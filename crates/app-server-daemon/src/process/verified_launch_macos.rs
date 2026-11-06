//! Reuses a package carrier's SHA-256 for the exact executable mapped by macOS.

use std::fs;
use std::fs::File;
use std::fs::Metadata;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::mem::MaybeUninit;
use std::os::fd::AsFd;
use std::os::fd::AsRawFd;
use std::os::fd::BorrowedFd;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

use ash_package_store::PackageLease;
use serde::Deserialize;
use serde::Serialize;

use super::BackendExecutable;
use super::PackageDigest;
use super::io_error;

const MAX_PROOF_BYTES: u64 = 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct FileStamp {
    device: u32,
    inode: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl FileStamp {
    fn read(metadata: Metadata) -> Result<Self, String> {
        if !metadata.is_file() {
            return Err("managed executable is not a regular file".into());
        }
        Ok(Self {
            device: metadata.dev() as u32,
            inode: metadata.ino(),
            size: metadata.size(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }

    fn check_path(&self, path: &Path) -> Result<(), String> {
        if Self::read(fs::symlink_metadata(path).map_err(io_error)?)? != *self {
            return Err("managed executable changed during launch".into());
        }
        Ok(())
    }
}

pub(super) struct VerifiedExecutable {
    stamp: FileStamp,
    // Hold the hashed vnode until spawn completes, so its inode cannot be recycled.
    file: File,
}

pub(super) fn capture(
    path: &Path,
    file: &File,
    lease: Option<&PackageLease>,
) -> Result<Option<VerifiedExecutable>, String> {
    let carrier = std::env::current_exe().and_then(dunce::canonicalize);
    if lease.is_none()
        || !carrier.is_ok_and(|carrier| carrier == path.with_file_name("ash-app-server-daemon"))
    {
        return Ok(None);
    }
    let stamp = FileStamp::read(file.metadata().map_err(io_error)?)?;
    stamp.check_path(path)?;
    Ok(Some(VerifiedExecutable {
        stamp,
        file: file.try_clone().map_err(io_error)?,
    }))
}

impl VerifiedExecutable {
    pub(super) fn check(&self, path: &Path) -> Result<(), String> {
        if FileStamp::read(self.file.metadata().map_err(io_error)?)? != self.stamp {
            return Err("managed executable changed during verification".into());
        }
        self.stamp.check_path(path)
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
) -> Result<Option<UnixStream>, String> {
    let Some(verified) = &backend.verified_launch else {
        return Ok(None);
    };
    verified.check(&backend.path)?;
    let (parent, child) = UnixStream::pair().map_err(io_error)?;
    command.stdin(Stdio::from(OwnedFd::from(child)));
    Ok(Some(parent))
}

pub(super) fn send(parent: &mut UnixStream, backend: &BackendExecutable) -> Result<(), String> {
    let verified = backend
        .verified_launch
        .as_ref()
        .expect("launch proof has a verified executable");
    verified.check(&backend.path)?;
    let mut payload = serde_json::to_vec(&LaunchProof {
        stamp: verified.stamp.clone(),
        sha256: backend.identity.sha256.clone(),
    })
    .map_err(|error| error.to_string())?;
    payload.push(b'\n');
    parent.write_all(&payload).map_err(io_error)
}

pub(super) fn receive(path: &Path) -> Result<Option<String>, String> {
    // Accept proof only when the kernel identifies the actual parent as the
    // peer of the inherited socket and that parent is this package's carrier.
    let stdin = io::stdin();
    let Ok(peer) = peer_pid(stdin.as_fd()) else {
        return Ok(None);
    };
    if rustix::process::getppid().is_none_or(|parent| parent.as_raw_pid() != peer)
        || !is_package_carrier(peer, path)
    {
        return Ok(None);
    }
    let socket = UnixStream::from(stdin.as_fd().try_clone_to_owned().map_err(io_error)?);
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(io_error)?;
    let mut payload = Vec::new();
    BufReader::new(socket.take(MAX_PROOF_BYTES + 1))
        .read_until(b'\n', &mut payload)
        .map_err(io_error)?;
    if payload.len() as u64 > MAX_PROOF_BYTES {
        return Err("managed executable proof exceeds its size limit".into());
    }
    if !payload.ends_with(b"\n") {
        return Err("managed executable proof is incomplete".into());
    }
    let proof: LaunchProof =
        serde_json::from_slice(&payload).map_err(|_| "invalid managed executable proof")?;
    PackageDigest::parse(&proof.sha256)?;
    proof.stamp.check_path(path)?;
    let Some(image) = running_image_stamp() else {
        return Ok(None);
    };
    if image != proof.stamp {
        return Err("managed executable proof does not match its running image".into());
    }
    let _reuse = crate::startup_trace::StartupTrace::span("executable-identity-reused");
    Ok(Some(proof.sha256))
}

fn peer_pid(socket: BorrowedFd<'_>) -> io::Result<libc::pid_t> {
    let mut pid: libc::pid_t = 0;
    let mut len = size_of_val(&pid) as libc::socklen_t;
    // The fixed-size result and length are writable for the duration of getsockopt.
    let result = unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != size_of_val(&pid) || pid <= 0 {
        return Err(io::Error::other("invalid managed launch peer PID"));
    }
    Ok(pid)
}

fn is_package_carrier(pid: libc::pid_t, executable: &Path) -> bool {
    let mut path = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // proc_pidpath writes the peer's executable path into this bounded buffer.
    let written = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    let Some(end) = path.iter().position(|byte| *byte == 0) else {
        return false;
    };
    written > 0
        && Path::new(std::ffi::OsStr::from_bytes(&path[..end]))
            == executable.with_file_name("ash-app-server-daemon")
}

fn running_image_stamp() -> Option<FileStamp> {
    // sys/proc_info.h defines this result as a 96-byte proc_regioninfo followed
    // by vnode_info_path. Only the vnode is consumed.
    #[repr(C)]
    struct RegionWithPath {
        region: [u64; 12],
        vnode: libc::vnode_info_path,
    }

    const PROC_PIDREGIONPATHINFO: libc::c_int = 8;
    let mut info = MaybeUninit::<RegionWithPath>::uninit();
    let size = size_of::<RegionWithPath>() as libc::c_int;
    // Query the file backing this function's executable mapping. Looking up the
    // path alone would accept a different vnode after a rename during spawn.
    let written = unsafe {
        libc::proc_pidinfo(
            std::process::id() as libc::pid_t,
            PROC_PIDREGIONPATHINFO,
            running_image_stamp as *const () as u64,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // A complete proc_pidinfo result initializes this plain C structure.
    let stat = unsafe { info.assume_init() }.vnode.vip_vi.vi_stat;
    if stat.vst_mode & libc::S_IFMT != libc::S_IFREG {
        return None;
    }
    Some(FileStamp {
        device: stat.vst_dev,
        inode: stat.vst_ino,
        size: stat.vst_size.try_into().ok()?,
        modified: (stat.vst_mtime, stat.vst_mtimensec),
        changed: (stat.vst_ctime, stat.vst_ctimensec),
    })
}

#[cfg(test)]
#[path = "verified_launch_macos_tests.rs"]
mod tests;
