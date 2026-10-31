// Adapted from OpenAI Codex (dafb6781ee), Apache-2.0. See ../../NOTICE and ../../LICENSE-APACHE.
//! Authenticate implicitly discovered Windows named-pipe peers before sending data.
//! The pipe's kernel-reported PID, rather than a PID file, identifies the token.

use std::io;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;

use windows_sys::Win32::Security::EqualSid;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::TOKEN_ELEVATION;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TOKEN_USER;
use windows_sys::Win32::Security::TokenElevation;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::OpenProcessToken;
use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;

pub(super) fn peer_identity(
    handle: windows_sys::Win32::Foundation::HANDLE,
    side: super::pipe::Side,
) -> io::Result<crate::PeerIdentity> {
    let mut pid = 0u32;
    let success = unsafe {
        match side {
            super::pipe::Side::Server => {
                windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(handle, &mut pid)
            }
            super::pipe::Side::Client => {
                windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(handle, &mut pid)
            }
        }
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "named pipe peer PID unavailable",
        ));
    }
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            /*binherithandle*/ 0,
            pid,
        )
    };
    if process == 0 {
        return Err(io::Error::last_os_error());
    }
    let _process = unsafe { OwnedHandle::from_raw_handle(process as _) };
    let mut token = 0;
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _token = unsafe { OwnedHandle::from_raw_handle(token as _) };
    let mut current_token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut current_token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _current_token = unsafe { OwnedHandle::from_raw_handle(current_token as _) };
    let current_user = super::security::token_user(current_token)?;
    let peer_user = super::security::token_user(token)?;
    let same_user = unsafe {
        EqualSid(
            (*(current_user.as_ptr().cast::<TOKEN_USER>())).User.Sid,
            (*(peer_user.as_ptr().cast::<TOKEN_USER>())).User.Sid,
        ) != 0
    };
    Ok(crate::PeerIdentity {
        same_user,
        same_elevation: elevation(current_token)? == elevation(token)?,
    })
}

fn elevation(token: windows_sys::Win32::Foundation::HANDLE) -> io::Result<bool> {
    let mut elevation: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
    let mut returned = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            std::ptr::addr_of_mut!(elevation).cast(),
            std::mem::size_of_val(&elevation) as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}
