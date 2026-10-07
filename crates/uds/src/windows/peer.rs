// Adapted from OpenAI Codex (dafb6781ee), Apache-2.0. See ../../NOTICE and ../../LICENSE-APACHE.
//! Authenticate implicitly discovered Windows socket peers before sending data.
//! The socket's kernel-reported PID, rather than a PID file, identifies the token.

use std::io;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;
use std::os::windows::io::RawSocket;
use std::ptr;

use windows_sys::Win32::Networking::WinSock::SIO_AF_UNIX_GETPEERPID;
use windows_sys::Win32::Networking::WinSock::SOCKET_ERROR;
use windows_sys::Win32::Networking::WinSock::WSAGetLastError;
use windows_sys::Win32::Networking::WinSock::WSAIoctl;
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

pub(super) fn peer_identity(socket: RawSocket) -> io::Result<crate::PeerIdentity> {
    let mut pid = 0u32;
    let mut returned = 0;
    if unsafe {
        WSAIoctl(
            socket as _,
            SIO_AF_UNIX_GETPEERPID,
            ptr::null(),
            /*cbinbuffer*/ 0,
            ptr::addr_of_mut!(pid).cast(),
            std::mem::size_of_val(&pid) as u32,
            &mut returned,
            ptr::null_mut(),
            /*lpcompletionroutine*/ None,
        )
    } == SOCKET_ERROR
    {
        return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
    }
    // Older Windows versions can return a valid PID with zero bytes reported.
    if pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket peer PID unavailable",
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
