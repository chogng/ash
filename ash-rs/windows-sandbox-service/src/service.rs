//! SCM lifecycle, bounded local pipe requests, and thread-scoped impersonation.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::Notify;
use windows_sandbox::provisioning::*;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_CALL_NOT_IMPLEMENTED;
use windows_sys::Win32::Foundation::ERROR_SERVICE_SPECIFIC_ERROR;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::Authorization::SDDL_REVISION_1;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::IsTokenRestricted;
use windows_sys::Win32::Security::RevertToSelf;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::SecurityImpersonation;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TokenImpersonationLevel;
use windows_sys::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows_sys::Win32::System::Services::RegisterServiceCtrlHandlerExW;
use windows_sys::Win32::System::Services::SERVICE_ACCEPT_SHUTDOWN;
use windows_sys::Win32::System::Services::SERVICE_ACCEPT_STOP;
use windows_sys::Win32::System::Services::SERVICE_CONTROL_INTERROGATE;
use windows_sys::Win32::System::Services::SERVICE_CONTROL_SHUTDOWN;
use windows_sys::Win32::System::Services::SERVICE_CONTROL_STOP;
use windows_sys::Win32::System::Services::SERVICE_RUNNING;
use windows_sys::Win32::System::Services::SERVICE_START_PENDING;
use windows_sys::Win32::System::Services::SERVICE_STATUS;
use windows_sys::Win32::System::Services::SERVICE_STATUS_HANDLE;
use windows_sys::Win32::System::Services::SERVICE_STOP_PENDING;
use windows_sys::Win32::System::Services::SERVICE_STOPPED;
use windows_sys::Win32::System::Services::SERVICE_TABLE_ENTRYW;
use windows_sys::Win32::System::Services::SERVICE_WIN32_OWN_PROCESS;
use windows_sys::Win32::System::Services::SetServiceStatus;
use windows_sys::Win32::System::Services::StartServiceCtrlDispatcherW;
use windows_sys::Win32::System::Threading::GetCurrentThread;
use windows_sys::Win32::System::Threading::OpenThreadToken;

static STATUS: AtomicUsize = AtomicUsize::new(0);
static STOP: AtomicBool = AtomicBool::new(false);
static STOPPED: Notify = Notify::const_new();

pub(crate) fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

pub(crate) fn error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}

pub(crate) struct Local(pub(crate) *mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub(crate) fn descriptor(sddl: &str) -> Result<Local, String> {
    let mut raw = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ));
    }
    Ok(Local(raw))
}

pub(crate) fn run() -> Result<(), String> {
    let mut name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: std::ptr::null_mut(),
            lpServiceProc: None,
        },
    ];
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        return Err(error("StartServiceCtrlDispatcherW"));
    }
    Ok(())
}

unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    let handle = unsafe {
        RegisterServiceCtrlHandlerExW(
            wide(SERVICE_NAME).as_ptr(),
            Some(control),
            std::ptr::null_mut(),
        )
    };
    if handle.is_null() {
        return;
    }
    STATUS.store(handle as usize, Ordering::Release);
    report(SERVICE_START_PENDING, 0);
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
        .and_then(|runtime| runtime.block_on(listen(PIPE_NAME)));
    report(
        SERVICE_STOPPED,
        if result.is_ok() {
            0
        } else {
            ERROR_SERVICE_SPECIFIC_ERROR
        },
    );
}

fn report(state: u32, exit: u32) {
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: exit,
        dwServiceSpecificExitCode: u32::from(exit != 0),
        dwCheckPoint: u32::from(matches!(
            state,
            SERVICE_START_PENDING | SERVICE_STOP_PENDING
        )),
        dwWaitHint: 120_000,
    };
    unsafe {
        SetServiceStatus(
            STATUS.load(Ordering::Acquire) as SERVICE_STATUS_HANDLE,
            &status,
        );
    }
}

unsafe extern "system" fn control(
    code: u32,
    _: u32,
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> u32 {
    match code {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            STOP.store(true, Ordering::Release);
            report(SERVICE_STOP_PENDING, 0);
            STOPPED.notify_one();
            0
        }
        SERVICE_CONTROL_INTERROGATE => 0,
        _ => ERROR_CALL_NOT_IMPLEMENTED,
    }
}

enum PipeInstance {
    First,
    Next,
}

fn listener(name: &str, instance: PipeInstance) -> Result<NamedPipeServer, String> {
    // GENERIC_WRITE also grants FILE_CREATE_PIPE_INSTANCE. Clients need only
    // FILE_WRITE_DATA; the pipe owner alone can create the next server instance.
    let sd = descriptor("D:P(A;;GA;;;SY)(A;;GA;;;OW)(A;;GR;;;BU)(A;;0x2;;;BU)")?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(matches!(instance, PipeInstance::First))
        .reject_remote_clients(true)
        .max_instances(2);
    unsafe { options.create_with_security_attributes_raw(name, (&raw mut attributes).cast()) }
        .map_err(|error| error.to_string())
}

fn advance_listener(pipe: &mut NamedPipeServer, name: &str) -> Result<(), String> {
    // Mio can retain a prefetched EOF from the previous client. Each connection
    // gets fresh I/O state; keep the old handle until the next instance exists so
    // another process cannot acquire the service's pipe name between requests.
    let next = listener(name, PipeInstance::Next)?;
    pipe.disconnect().map_err(|error| error.to_string())?;
    *pipe = next;
    Ok(())
}

async fn listen(name: &str) -> Result<(), String> {
    let mut pipe = listener(name, PipeInstance::First)?;
    report(SERVICE_RUNNING, 0);
    loop {
        if STOP.load(Ordering::Acquire) {
            break;
        }
        tokio::select! {
            _ = STOPPED.notified() => break,
            connected = pipe.connect() => connected.map_err(|error| error.to_string())?,
        }
        // Client inactivity cannot hold the service indefinitely. Once mutation
        // starts, stop waits for its journaled operation to finish rather than
        // dropping a worker while it changes accounts or persistent WFP rules.
        let read = tokio::time::timeout(Duration::from_secs(30), read_request(&mut pipe));
        let message = tokio::select! {
            _ = STOPPED.notified() => { pipe.disconnect().map_err(|error| error.to_string())?; break; },
            message = read => message,
        };
        if STOP.load(Ordering::Acquire) {
            break;
        }
        if let Ok(Ok(message)) = message {
            let raw = pipe.as_raw_handle() as usize;
            let response =
                tokio::task::spawn_blocking(move || authenticated_dispatch(raw as HANDLE, message))
                    .await
                    .map_err(|error| error.to_string())?;
            let _ = tokio::time::timeout(
                Duration::from_secs(10),
                write_response(&mut pipe, &response),
            )
            .await;
        }
        advance_listener(&mut pipe, name)?;
    }
    Ok(())
}

async fn read_request(pipe: &mut NamedPipeServer) -> Result<Message, String> {
    let length = pipe
        .read_u32_le()
        .await
        .map_err(|error| error.to_string())? as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err("invalid sandbox service request size".into());
    }
    let mut bytes = vec![0; length];
    pipe.read_exact(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

async fn write_response(pipe: &mut NamedPipeServer, response: &Response) -> Result<(), String> {
    let bytes = serde_json::to_vec(response).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("sandbox service response exceeds its size limit".into());
    }
    pipe.write_u32_le(bytes.len() as u32)
        .await
        .map_err(|error| error.to_string())?;
    pipe.write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    // DisconnectNamedPipe discards unread response bytes, even after WriteFile
    // completes. Wait for a bounded receipt rather than an unbounded flush that
    // would let a client hold service shutdown by refusing to read.
    if pipe.read_u8().await.map_err(|error| error.to_string())? != RESPONSE_RECEIVED {
        return Err("invalid sandbox service response receipt".into());
    }
    Ok(())
}

fn authenticated_dispatch(pipe: HANDLE, message: Message) -> Response {
    struct Impersonation;
    impl Drop for Impersonation {
        fn drop(&mut self) {
            if unsafe { RevertToSelf() } == 0 {
                std::process::abort();
            }
        }
    }
    let result = (|| {
        if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
            return Err(error("ImpersonateNamedPipeClient"));
        }
        let _identity = Impersonation;
        let mut token = std::ptr::null_mut();
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
            return Err(error("OpenThreadToken(client)"));
        }
        struct Token(HANDLE);
        impl Drop for Token {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let token = Token(token);
        if unsafe { IsTokenRestricted(token.0) } != 0 {
            return Err("restricted tokens cannot manage the Windows sandbox service".into());
        }
        let mut level = 0u32;
        let mut needed = 0;
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenImpersonationLevel,
                (&raw mut level).cast(),
                size_of::<u32>() as u32,
                &mut needed,
            )
        } == 0
            || level < SecurityImpersonation as u32
        {
            return Err("sandbox service requires an impersonation token".into());
        }
        // Dispatch and DPAPI stay on this OS thread. No async suspension may
        // detach request authority from the impersonated Windows token.
        Ok(dispatch(message))
    })();
    result.unwrap_or_else(|error| Response::Rejected { error })
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
