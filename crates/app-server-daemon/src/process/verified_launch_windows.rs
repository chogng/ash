//! Transfers a leased executable's digest across a kernel-authenticated launch pipe.

use std::ffi::OsString;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::PipeWriter;
use std::io::Read;
use std::io::Write;
use std::mem::MaybeUninit;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsHandle;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use ash_package_store::PackageLease;
use serde::Deserialize;
use serde::Serialize;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
use windows_sys::Win32::Storage::FileSystem::FILE_BASIC_INFO;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FileBasicInfo;
use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandleEx;
use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::GetProcessTimes;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_BASIC_INFORMATION;
use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

use super::BackendExecutable;
use super::PackageDigest;
use super::io_error;

const MAX_PROOF_BYTES: usize = 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct FileStamp {
    volume: u32,
    index: u64,
    size: u64,
    modified: u64,
    changed: i64,
}

impl FileStamp {
    fn read(file: &File) -> Result<Self, String> {
        let mut identity = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        let mut basic = MaybeUninit::<FILE_BASIC_INFO>::uninit();
        // Both APIs initialize fixed-size output structures on success; the File
        // owns the handle throughout these calls.
        let success = unsafe {
            GetFileInformationByHandle(file.as_raw_handle(), identity.as_mut_ptr()) != 0
                && GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileBasicInfo,
                    basic.as_mut_ptr().cast(),
                    size_of::<FILE_BASIC_INFO>() as u32,
                ) != 0
        };
        if !success {
            return Err(io_error(io::Error::last_os_error()));
        }
        // The successful calls above initialize every field consumed below.
        let (identity, basic) = unsafe { (identity.assume_init(), basic.assume_init()) };
        Ok(Self {
            volume: identity.dwVolumeSerialNumber,
            index: (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow),
            size: (u64::from(identity.nFileSizeHigh) << 32) | u64::from(identity.nFileSizeLow),
            modified: file_time(identity.ftLastWriteTime),
            changed: basic.ChangeTime,
        })
    }

    fn check(&self, file: &File, path: &Path) -> Result<(), String> {
        let current = open_locked(path)?;
        if Self::read(file)? != *self || Self::read(&current)? != *self {
            return Err("managed executable changed during launch".into());
        }
        Ok(())
    }
}

pub(super) struct VerifiedExecutable {
    stamp: FileStamp,
    // Mandatory Windows sharing denies write and rename from before hashing
    // until the child publishes its control endpoint. The package lease also
    // prevents its generation from being collected during that interval.
    file: File,
}

pub(super) fn open(path: &Path, lease: Option<&PackageLease>) -> Result<File, String> {
    if lease.is_some() {
        open_locked(path)
    } else {
        File::open(path).map_err(io_error)
    }
}

fn open_locked(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(io_error)
}

pub(super) fn capture(
    path: &Path,
    file: &File,
    lease: Option<&PackageLease>,
) -> Result<Option<VerifiedExecutable>, String> {
    if lease.is_none() {
        return Ok(None);
    }
    // Filesystems without a stable handle identity keep the ordinary full hash
    // in the child; an unavailable optimization is never a verification result.
    let Ok(stamp) = FileStamp::read(file) else {
        return Ok(None);
    };
    if stamp.index == 0 {
        return Ok(None);
    }
    stamp.check(file, path)?;
    Ok(Some(VerifiedExecutable {
        stamp,
        file: file.try_clone().map_err(io_error)?,
    }))
}

impl VerifiedExecutable {
    pub(super) fn check(&self, path: &Path) -> Result<(), String> {
        self.stamp.check(&self.file, path)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LaunchProof {
    stamp: FileStamp,
    sha256: String,
}

pub(super) fn prepare(
    command: &mut Command,
    backend: &BackendExecutable,
) -> Result<Option<PipeWriter>, String> {
    let Some(verified) = &backend.verified_launch else {
        return Ok(None);
    };
    verified.check(&backend.path)?;
    let (reader, writer) = io::pipe().map_err(io_error)?;
    command.stdin(Stdio::from(reader));
    Ok(Some(writer))
}

pub(super) fn send(writer: &mut PipeWriter, backend: &BackendExecutable) -> Result<(), String> {
    let verified = backend
        .verified_launch
        .as_ref()
        .expect("prepared launch proof");
    verified.check(&backend.path)?;
    let mut payload = serde_json::to_vec(&LaunchProof {
        stamp: verified.stamp.clone(),
        sha256: backend.identity.sha256.clone(),
    })
    .map_err(|error| error.to_string())?;
    payload.push(b'\n');
    if payload.len() > MAX_PROOF_BYTES {
        return Err("managed executable proof exceeds its size limit".into());
    }
    writer.write_all(&payload).map_err(io_error)
}

pub(super) fn receive(path: &Path) -> Result<Option<String>, String> {
    let stdin = io::stdin();
    let mut peer = 0;
    // Anonymous pipes use the same kernel identity query as named pipes. A
    // redirected file/terminal and a pipe created by another process are not proof.
    if unsafe { GetNamedPipeServerProcessId(stdin.as_raw_handle(), &mut peer) } == 0
        || parent_pid() != Some(peer)
    {
        return Ok(None);
    }
    let Some(_lease) =
        ash_package_store::acquire_package_lease_for_executable(path).map_err(io_error)?
    else {
        return Ok(None);
    };
    // Acquire the image lock before authenticating the live parent, closing the
    // gap in which a dead carrier could release its original write protection.
    let file = open_locked(path)?;
    let Some(_parent) = verified_carrier(peer, path)? else {
        return Ok(None);
    };
    let mut input = File::from(stdin.as_handle().try_clone_to_owned().map_err(io_error)?);
    let payload = read_proof(&mut input)?;
    let proof: LaunchProof = serde_json::from_slice(&payload)
        .map_err(|_| "invalid managed executable proof".to_string())?;
    PackageDigest::parse(&proof.sha256)?;
    proof.stamp.check(&file, path)?;
    let _reuse = crate::startup_trace::StartupTrace::span("executable-identity-reused");
    Ok(Some(proof.sha256))
}

fn verified_carrier(pid: u32, backend: &Path) -> Result<Option<OwnedHandle>, String> {
    // A PID from a dead parent must not authenticate a newly reused process.
    let parent = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if parent.is_null() {
        return Ok(None);
    }
    // OpenProcess returned a new owned handle; close it on every exit path.
    let parent = unsafe { OwnedHandle::from_raw_handle(parent) };
    let Some(created) = creation_time(parent.as_raw_handle()) else {
        return Ok(None);
    };
    // The pseudo handle is borrowed and must not be closed.
    let current_created = unsafe { creation_time(GetCurrentProcess()) };
    if current_created.is_none_or(|current| created > current) {
        return Ok(None);
    }
    let Some(path) = image_path(&parent) else {
        return Ok(None);
    };
    if path
        .file_name()
        .is_none_or(|name| name != "ash-app-server-daemon.exe")
    {
        return Ok(None);
    }
    let Ok(image) = open_locked(&path) else {
        return Ok(None);
    };
    // Query again after taking the mandatory file lock: a rename between the
    // first query and open must not authenticate a replacement at the old path.
    if image_path(&parent).as_ref() != Some(&path) {
        return Ok(None);
    }
    let Some(expected) = carrier_digest(backend)? else {
        return Ok(None);
    };
    // Desktop's carrier can live in resources/bin while its selected backend
    // lives in the profile store. Authenticate the smaller carrier image against
    // that package, rather than accepting an executable name or environment flag.
    let _hash = crate::startup_trace::StartupTrace::span("launch-proof-carrier");
    let mut image = image;
    let Ok(identity) = super::read_binary_identity(&path, &mut image) else {
        return Ok(None);
    };
    if identity.sha256 != expected
        || identity.package_build_id != super::package_build_id(backend)?
        // The handle is valid and includes SYNCHRONIZE. Only a live parent can
        // still own the lock which overlaps the child's backend image lock.
        || unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) } != WAIT_TIMEOUT
    {
        return Ok(None);
    }
    Ok(Some(parent))
}

fn carrier_digest(backend: &Path) -> Result<Option<String>, String> {
    let Some(package) = backend.parent().and_then(Path::parent) else {
        return Ok(None);
    };
    let file = File::open(package.join("ash-package.json")).map_err(io_error)?;
    let mut bytes = Vec::new();
    file.take(super::MAX_PACKAGE_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > super::MAX_PACKAGE_METADATA_BYTES {
        return Err("managed package metadata exceeds its size limit".into());
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let Some(digest) = metadata["files"]["bin/ash-app-server-daemon.exe"].as_str() else {
        return Ok(None);
    };
    PackageDigest::parse(digest)?;
    Ok(Some(digest.to_owned()))
}

fn read_proof(input: &mut File) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut payload = Vec::new();
    loop {
        let mut available = 0;
        // One reader owns this inherited pipe. Read only bytes already reported
        // available, so an incomplete proof cannot block startup indefinitely.
        if unsafe {
            PeekNamedPipe(
                input.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("managed executable proof is incomplete".into());
        }
        if available > 0 {
            let mut buffer = [0_u8; MAX_PROOF_BYTES + 1];
            let capacity = (available as usize).min(buffer.len() - payload.len());
            let read = input.read(&mut buffer[..capacity]).map_err(io_error)?;
            payload.extend_from_slice(&buffer[..read]);
            if payload.len() > MAX_PROOF_BYTES {
                return Err("managed executable proof exceeds its size limit".into());
            }
            if payload.ends_with(b"\n") {
                return Ok(payload);
            }
        }
        if Instant::now() >= deadline {
            return Err("managed executable proof timed out".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn parent_pid() -> Option<u32> {
    parent_pid_native().or_else(parent_pid_snapshot)
}

fn parent_pid_native() -> Option<u32> {
    type QueryProcess = unsafe extern "system" fn(
        windows_sys::Win32::Foundation::HANDLE,
        i32,
        *mut std::ffi::c_void,
        u32,
        *mut u32,
    ) -> i32;
    // The documented ProcessBasicInformation layout supplies the parent PID.
    // Resolve dynamically and validate the result size/own PID; unsupported
    // systems retain ToolHelp rather than weakening peer authentication.
    // https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess
    let ntdll = unsafe { GetModuleHandleW(windows_sys::w!("ntdll.dll")) };
    if ntdll.is_null() {
        return None;
    }
    let address = unsafe { GetProcAddress(ntdll, windows_sys::s!("NtQueryInformationProcess")) }?;
    // This symbol has the documented system ABI above. ntdll remains loaded
    // for the process lifetime; its borrowed module handle must not be closed.
    let query: QueryProcess = unsafe { std::mem::transmute(address) };
    let mut basic = MaybeUninit::<PROCESS_BASIC_INFORMATION>::uninit();
    let mut written = 0;
    // The current-process pseudo handle is borrowed, and the output buffer has
    // exactly the SDK layout/capacity requested by information class zero.
    let status = unsafe {
        query(
            GetCurrentProcess(),
            0,
            basic.as_mut_ptr().cast(),
            size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut written,
        )
    };
    if status < 0 || written as usize != size_of::<PROCESS_BASIC_INFORMATION>() {
        return None;
    }
    // A successful, complete result initializes the SDK structure.
    let basic = unsafe { basic.assume_init() };
    if basic.UniqueProcessId != std::process::id() as usize {
        return None;
    }
    u32::try_from(basic.InheritedFromUniqueProcessId)
        .ok()
        .filter(|pid| *pid != 0)
}

fn parent_pid_snapshot() -> Option<u32> {
    // The snapshot contains plain fixed-layout entries. Only a successful
    // Process32First/Next call is inspected, and the snapshot handle is owned.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = unsafe { std::mem::zeroed::<PROCESSENTRY32W>() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32ProcessID == std::process::id() {
            return Some(entry.th32ParentProcessID);
        }
        found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    None
}

fn image_path(process: &OwnedHandle) -> Option<PathBuf> {
    let mut path = vec![0_u16; 32 * 1024];
    let mut length = path.len() as u32;
    // QueryFullProcessImageName writes at most the supplied UTF-16 capacity.
    if unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, path.as_mut_ptr(), &mut length)
    } == 0
    {
        return None;
    }
    dunce::canonicalize(PathBuf::from(OsString::from_wide(&path[..length as usize]))).ok()
}

fn creation_time(process: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    let mut times = [FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }; 4];
    // Each output points at a distinct initialized FILETIME slot.
    if unsafe {
        GetProcessTimes(
            process,
            &mut times[0],
            &mut times[1],
            &mut times[2],
            &mut times[3],
        )
    } == 0
    {
        return None;
    }
    Some(file_time(times[0]))
}

fn file_time(value: FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[cfg(test)]
#[path = "verified_launch_windows_tests.rs"]
mod tests;
