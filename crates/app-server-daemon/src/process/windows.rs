//! Process identity and termination stay on one Windows handle to prevent PID-reuse races.

use std::io;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::System::Threading::GetProcessTimes;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

struct Process(HANDLE);

impl Process {
    fn open(pid: u32, access: u32) -> io::Result<Option<Self>> {
        // SAFETY: OpenProcess accepts a PID and documented access flags; the returned handle is owned.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(None);
            }
            return Err(error);
        }
        Ok(Some(Self(handle)))
    }

    fn start_identity(&self) -> io::Result<Option<String>> {
        // SAFETY: the handle is live and owned by self for the entire wait operation.
        match unsafe { WaitForSingleObject(self.0, 0) } {
            WAIT_OBJECT_0 => return Ok(None),
            WAIT_TIMEOUT => {}
            _ => return Err(io::Error::last_os_error()),
        }
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut user = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        // SAFETY: all four output pointers refer to initialized FILETIME storage and the handle is open.
        if unsafe { GetProcessTimes(self.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        Ok(Some(format!("{ticks:016x}")))
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: this is the sole owner and the handle is closed exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) fn start_identity(pid: u32) -> Result<Option<String>, String> {
    let Some(process) = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    process.start_identity().map_err(|error| error.to_string())
}

pub(super) fn terminate(pid: u32, expected_start: &str) -> Result<(), String> {
    let Some(process) = Process::open(
        pid,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
    )
    .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    match process
        .start_identity()
        .map_err(|error| error.to_string())?
    {
        None => return Ok(()),
        Some(actual) if actual == expected_start => {}
        Some(_) => return Err("refusing to terminate a reused or stale backend pid".into()),
    }
    // SAFETY: identity was verified on this same still-owned handle; PID reuse cannot retarget it.
    if unsafe { TerminateProcess(process.0, 1) } == 0 {
        let error = io::Error::last_os_error();
        // SAFETY: this owned handle still refers to the verified process, which may have exited meanwhile.
        if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
            return Ok(());
        }
        return Err(error.to_string());
    }
    // SAFETY: the process handle remains open while waiting for termination.
    match unsafe { WaitForSingleObject(process.0, 5_000) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(format!("timed out waiting for backend {pid} to terminate")),
        _ => Err(io::Error::last_os_error().to_string()),
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
