//! Authenticated management client and token-bound provisioning dispatch.

use super::account::NetworkMode;
use super::runtime;
use super::win;
use crate::provisioning::*;
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use windows_sys::Win32::Foundation::ERROR_IO_PENDING;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::Storage::FileSystem::SECURITY_IMPERSONATION;
use windows_sys::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT;
use windows_sys::Win32::Storage::FileSystem::WriteFile;
use windows_sys::Win32::System::IO::CancelIoEx;
use windows_sys::Win32::System::IO::GetOverlappedResult;
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::Services::CloseServiceHandle;
use windows_sys::Win32::System::Services::OpenSCManagerW;
use windows_sys::Win32::System::Services::OpenServiceW;
use windows_sys::Win32::System::Services::QueryServiceStatusEx;
use windows_sys::Win32::System::Services::SC_HANDLE;
use windows_sys::Win32::System::Services::SC_MANAGER_CONNECT;
use windows_sys::Win32::System::Services::SC_STATUS_PROCESS_INFO;
use windows_sys::Win32::System::Services::SERVICE_QUERY_STATUS;
use windows_sys::Win32::System::Services::SERVICE_RUNNING;
use windows_sys::Win32::System::Services::SERVICE_STATUS_PROCESS;
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
use windows_sys::Win32::System::Threading::ResetEvent;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

pub(crate) fn directory() -> Result<PathBuf, String> {
    Ok(win::program_data()?.join("AshWindowsSandbox"))
}

pub(crate) fn dispatch(request: Request) -> Result<serde_json::Value, String> {
    match request {
        Request::SetupPlan { runner, slots } => {
            let runner = std::fs::canonicalize(runner).map_err(|error| error.to_string())?;
            let _pins = win::pin_executable(&runner)?;
            runtime::approved_plan(runtime::setup_plan(slots, &runner)?)
        }
        Request::Setup {
            runner,
            slots,
            approved,
        } => {
            let runner = std::fs::canonicalize(runner).map_err(|error| error.to_string())?;
            runtime::setup(slots, &runner, &approved)?;
            Ok(serde_json::json!({"status": "ready"}))
        }
        Request::UpdatePlan { runner } => {
            let runner = std::fs::canonicalize(runner).map_err(|error| error.to_string())?;
            let _pins = win::pin_executable(&runner)?;
            runtime::approved_plan(runtime::update_plan(&runner)?)
        }
        Request::Update { runner, approved } => {
            let runner = std::fs::canonicalize(runner).map_err(|error| error.to_string())?;
            runtime::update(&runner, &approved)?;
            Ok(serde_json::json!({"status": "ready"}))
        }
        Request::RemovePlan {} => runtime::approved_plan(runtime::removal_plan()?),
        Request::Remove { approved } => {
            runtime::remove(&approved)?;
            Ok(serde_json::json!({"status": "removed"}))
        }
        Request::Status {} => Ok(serde_json::json!({
            "status": "ready", "runnerSha256": runtime::available(NetworkMode::Denied)?
        })),
    }
}

pub(super) fn print(request: Request) -> Result<(), String> {
    let data = call(request)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?
    );
    Ok(())
}

struct ServiceHandle(SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}

fn call(request: Request) -> Result<serde_json::Value, String> {
    let image = directory()?.join("bin/ash-windows-sandbox-service.exe");
    let _pins = win::pin_executable(&image)?;
    for path in [directory()?, directory()?.join("bin"), image.clone()] {
        win::verify_service_path(&path)?;
    }
    let manager = ServiceHandle(unsafe {
        OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT)
    });
    if manager.0.is_null() {
        return Err(win::error("OpenSCManagerW"));
    }
    let service = ServiceHandle(unsafe {
        OpenServiceW(
            manager.0,
            win::wide(SERVICE_NAME).as_ptr(),
            SERVICE_QUERY_STATUS,
        )
    });
    if service.0.is_null() {
        return Err(win::error("OpenServiceW"));
    }
    let mut status: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
    let mut needed = 0;
    if unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            (&raw mut status).cast(),
            size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    } == 0
    {
        return Err(win::error("QueryServiceStatusEx"));
    }
    if status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId == 0 {
        return Err("Windows sandbox service is not running".into());
    }
    if unsafe { WaitNamedPipeW(win::wide(PIPE_NAME).as_ptr(), 5_000) } == 0 {
        return Err(win::error("WaitNamedPipeW"));
    }
    let pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION)
        .open(PIPE_NAME)
        .map_err(|error| error.to_string())?;
    let raw = pipe.as_raw_handle();
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(raw, &mut pid) } == 0 || pid != status.dwProcessId {
        return Err("Windows sandbox pipe is not owned by the registered service".into());
    }
    let process = win::Handle::new(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) },
        "OpenProcess(service)",
    )?;
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length) } == 0 {
        return Err(win::error("QueryFullProcessImageNameW(service)"));
    }
    let actual = PathBuf::from(
        String::from_utf16(&path[..length as usize]).map_err(|error| error.to_string())?,
    );
    if std::fs::canonicalize(actual).map_err(|error| error.to_string())?
        != std::fs::canonicalize(image).map_err(|error| error.to_string())?
    {
        return Err("registered service is running an unexpected executable".into());
    }
    let message = Message {
        version: PROTOCOL_VERSION,
        request,
    };
    let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("sandbox service request exceeds its size limit".into());
    }
    transfer(
        raw,
        &mut (bytes.len() as u32).to_le_bytes(),
        Direction::Write,
    )?;
    transfer(raw, &mut bytes, Direction::Write)?;
    let mut header = [0; 4];
    transfer(raw, &mut header, Direction::Read)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err("invalid sandbox service response size".into());
    }
    let mut bytes = vec![0; length];
    transfer(raw, &mut bytes, Direction::Read)?;
    match serde_json::from_slice::<Response>(&bytes).map_err(|error| error.to_string())? {
        Response::Completed { data } => Ok(data),
        Response::Rejected { error } => Err(error),
    }
}

enum Direction {
    Read,
    Write,
}

fn transfer(pipe: HANDLE, mut buffer: &mut [u8], direction: Direction) -> Result<(), String> {
    let event = win::Handle::new(
        unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) },
        "CreateEventW(service I/O)",
    )?;
    while !buffer.is_empty() {
        unsafe {
            ResetEvent(event.0);
        }
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.0;
        let result = unsafe {
            match direction {
                Direction::Read => ReadFile(
                    pipe,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    std::ptr::null_mut(),
                    &mut overlapped,
                ),
                Direction::Write => WriteFile(
                    pipe,
                    buffer.as_ptr(),
                    buffer.len() as u32,
                    std::ptr::null_mut(),
                    &mut overlapped,
                ),
            }
        };
        if result == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(win::error("sandbox service I/O"));
        }
        if unsafe { WaitForSingleObject(event.0, 120_000) } != WAIT_OBJECT_0 {
            unsafe {
                CancelIoEx(pipe, &overlapped);
            }
            let mut transferred = 0;
            // The OVERLAPPED and buffer must remain alive until cancellation completes.
            unsafe {
                GetOverlappedResult(pipe, &overlapped, &mut transferred, 1);
            }
            return Err("sandbox service request timed out".into());
        }
        let mut transferred = 0;
        if unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, 0) } == 0 {
            return Err(win::error("GetOverlappedResult(service I/O)"));
        }
        if transferred == 0 {
            return Err("sandbox service closed the connection".into());
        }
        buffer = &mut buffer[transferred as usize..];
    }
    Ok(())
}
