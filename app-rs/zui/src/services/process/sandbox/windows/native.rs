#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::ffi::OsString;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys::Win32::Foundation::WAIT_FAILED;
use windows_sys::Win32::Security::FreeSid;
use windows_sys::Win32::Security::Isolation::CreateAppContainerProfile;
use windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName;
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::Security::SECURITY_CAPABILITIES;
use windows_sys::Win32::System::Console::GetStdHandle;
use windows_sys::Win32::System::Console::STD_ERROR_HANDLE;
use windows_sys::Win32::System::Console::STD_INPUT_HANDLE;
use windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
use windows_sys::Win32::System::Threading::CreateProcessW;
use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;
use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;

const HRESULT_ALREADY_EXISTS: i32 = 0x8007_00B7u32 as i32;

pub(super) struct AppContainerSid(PSID);

impl AppContainerSid {
    pub(super) fn ensure(profile: &OsStr) -> Result<Self, String> {
        let profile = to_wide(profile);
        let display = to_wide(OsStr::new("ZUI Process Sandbox"));
        let description = to_wide(OsStr::new("ZUI isolated child process"));
        let mut sid = std::ptr::null_mut();
        let created = unsafe {
            CreateAppContainerProfile(
                profile.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };
        if created >= 0 {
            return Ok(Self(sid));
        }
        if created != HRESULT_ALREADY_EXISTS {
            return Err(format!(
                "CreateAppContainerProfile failed with HRESULT 0x{:08x}",
                created as u32
            ));
        }
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) };
        if derived < 0 {
            return Err(format!(
                "DeriveAppContainerSidFromAppContainerName failed with HRESULT 0x{:08x}",
                derived as u32
            ));
        }
        Ok(Self(sid))
    }

    pub(super) fn as_ptr(&self) -> PSID {
        self.0
    }
}

impl Drop for AppContainerSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                FreeSid(self.0);
            }
        }
    }
}

pub(super) fn canonical_file(path: &Path, description: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|source| format!("{description}: {source}"))?;
    if !canonical.is_file() {
        return Err(format!("{description} is not a regular file"));
    }
    Ok(canonical)
}

pub(super) fn canonical_directory(path: &Path, description: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|source| format!("{description}: {source}"))?;
    if !canonical.is_dir() {
        return Err(format!("{description} is not a directory"));
    }
    Ok(canonical)
}

pub(super) fn launch(
    sid: &AppContainerSid,
    arguments: &[OsString],
    working_directory: &Path,
) -> Result<i32, String> {
    let job = create_job()?;
    let mut attributes = AttributeList::new(2)?;
    let mut security = SECURITY_CAPABILITIES {
        AppContainerSid: sid.as_ptr(),
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    attributes.set(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
        &mut security as *mut _ as *const c_void,
        std::mem::size_of::<SECURITY_CAPABILITIES>(),
    )?;
    let child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    attributes.set(
        PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY as usize,
        &child_policy as *const _ as *const c_void,
        std::mem::size_of_val(&child_policy),
    )?;

    let stdin = inheritable_standard_handle(STD_INPUT_HANDLE)?;
    let stdout = inheritable_standard_handle(STD_OUTPUT_HANDLE)?;
    let stderr = inheritable_standard_handle(STD_ERROR_HANDLE)?;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin;
    startup.StartupInfo.hStdOutput = stdout;
    startup.StartupInfo.hStdError = stderr;
    startup.lpAttributeList = attributes.pointer();

    let mut command = command_line(arguments)?;
    let working_directory = to_wide(working_directory.as_os_str());
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
            std::ptr::null(),
            working_directory.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessW AppContainer launch"));
    }
    let process_handle = OwnedHandle::new(process.hProcess, "child process handle")?;
    let thread_handle = OwnedHandle::new(process.hThread, "child thread handle")?;
    if unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) } == 0 {
        unsafe {
            TerminateProcess(process_handle.raw(), 1);
        }
        return Err(last_error("AssignProcessToJobObject"));
    }
    if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
        unsafe {
            TerminateProcess(process_handle.raw(), 1);
        }
        return Err(last_error("ResumeThread"));
    }
    if unsafe { WaitForSingleObject(process_handle.raw(), INFINITE) } == WAIT_FAILED {
        return Err(last_error("WaitForSingleObject"));
    }
    let mut exit_code = 1;
    if unsafe { GetExitCodeProcess(process_handle.raw(), &mut exit_code) } == 0 {
        return Err(last_error("GetExitCodeProcess"));
    }
    Ok(exit_code as i32)
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, operation: &str) -> Result<Self, String> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(last_error(operation))
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn create_job() -> Result<OwnedHandle, String> {
    let job = OwnedHandle::new(
        unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) },
        "CreateJobObjectW",
    )?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

fn inheritable_standard_handle(kind: u32) -> Result<HANDLE, String> {
    let handle = unsafe { GetStdHandle(kind) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_error("GetStdHandle"));
    }
    if unsafe { SetHandleInformation(handle, 1, 1) } == 0 {
        return Err(last_error("SetHandleInformation"));
    }
    Ok(handle)
}

struct AttributeList {
    storage: Vec<usize>,
    pointer: *mut c_void,
}

impl AttributeList {
    fn new(count: u32) -> Result<Self, String> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(last_error("InitializeProcThreadAttributeList sizing"));
        }
        let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
        let pointer = storage.as_mut_ptr() as *mut c_void;
        if unsafe { InitializeProcThreadAttributeList(pointer, count, 0, &mut bytes) } == 0 {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        Ok(Self { storage, pointer })
    }

    fn set(&mut self, attribute: usize, value: *const c_void, size: usize) -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.pointer,
                0,
                attribute,
                value,
                size,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(last_error("UpdateProcThreadAttribute"));
        }
        Ok(())
    }

    fn pointer(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr() as *mut c_void
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn last_error(operation: &str) -> String {
    format!("{operation} failed with Windows error {}", unsafe {
        GetLastError()
    })
}

pub(super) fn to_wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn command_line(arguments: &[OsString]) -> Result<Vec<u16>, String> {
    let mut command = Vec::new();
    for (index, argument) in arguments.iter().enumerate() {
        let argument = argument.encode_wide().collect::<Vec<_>>();
        if argument.contains(&0) {
            return Err("sandboxed command arguments cannot contain NUL".to_owned());
        }
        if index != 0 {
            command.push(b' ' as u16);
        }
        append_quoted(&mut command, &argument);
    }
    command.push(0);
    Ok(command)
}

fn append_quoted(output: &mut Vec<u16>, argument: &[u16]) {
    let quote = argument.is_empty()
        || argument
            .iter()
            .any(|character| matches!(*character, 0x09 | 0x20 | 0x22));
    if !quote {
        output.extend_from_slice(argument);
        return;
    }
    output.push(b'"' as u16);
    let mut backslashes = 0;
    for character in argument {
        if *character == b'\\' as u16 {
            backslashes += 1;
        } else if *character == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            output.push(*character);
            backslashes = 0;
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
            output.push(*character);
            backslashes = 0;
        }
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    output.push(b'"' as u16);
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    use super::command_line;

    #[test]
    fn command_line_quotes_spaces_quotes_and_trailing_backslashes() {
        let arguments = [
            OsString::from("tool.exe"),
            OsString::from("argument with spaces"),
            OsString::from("say \"hello\""),
            OsString::from("C:\\path with space\\"),
        ];
        let encoded = command_line(&arguments).unwrap();
        let decoded = String::from_utf16(&encoded[..encoded.len() - 1]).unwrap();
        assert_eq!(
            decoded,
            "tool.exe \"argument with spaces\" \"say \\\"hello\\\"\" \"C:\\path with space\\\\\""
        );
    }

    #[test]
    fn command_line_rejects_embedded_nul() {
        let invalid = OsString::from_wide(&[b'a' as u16, 0, b'b' as u16]);
        assert!(command_line(&[OsString::from("tool.exe"), invalid]).is_err());
    }
}
