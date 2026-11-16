// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Owned Windows security allocations and private desktops shared by process launchers.
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::Authorization::SDDL_REVISION_1;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TOKEN_USER;
use windows_sys::Win32::Security::TokenUser;
use windows_sys::Win32::System::StationsAndDesktops::CloseDesktop;
use windows_sys::Win32::System::StationsAndDesktops::CreateDesktopW;
use windows_sys::Win32::System::StationsAndDesktops::GetProcessWindowStation;
use windows_sys::Win32::System::StationsAndDesktops::GetUserObjectInformationW;
use windows_sys::Win32::System::StationsAndDesktops::HDESK;
use windows_sys::Win32::System::StationsAndDesktops::UOI_NAME;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::OpenProcessToken;

pub type Result<T> = std::result::Result<T, String>;

/// Owns memory allocated by a Windows LocalAlloc-compatible API.
pub struct Local(*mut c_void);
impl Local {
    /// # Safety
    /// `value` must be a uniquely owned allocation released with LocalFree.
    pub unsafe fn from_raw(value: *mut c_void) -> Self {
        Self(value)
    }
    pub fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(Some(0)).collect()
}

pub fn error(operation: &str) -> String {
    format!("{operation} failed (Windows error {})", unsafe {
        GetLastError()
    })
}

pub fn sid(text: &str) -> Result<Local> {
    if text.contains('\0') {
        return Err("SID cannot contain NUL".into());
    }
    let mut value = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(wide(text).as_ptr(), &mut value) } == 0 {
        Err(error("ConvertStringSidToSidW"))
    } else {
        Ok(Local(value))
    }
}

/// # Safety
/// `value` must point to a valid SID for the duration of the call.
pub unsafe fn sid_text(value: *mut c_void) -> Result<String> {
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(value, &mut text) } == 0 {
        return Err(error("ConvertSidToStringSidW"));
    }
    let guard = Local(text.cast());
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(text, length))
            .map_err(|error| error.to_string());
        drop(guard);
        result
    }
}

pub fn token_user(token: HANDLE) -> Result<String> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(error("GetTokenInformation(TokenUser)"));
    }
    let mut data = vec![0u64; (size as usize + 7) / 8];
    if unsafe { GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return Err(error("GetTokenInformation(TokenUser)"));
    }
    unsafe { sid_text((*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid) }
}

pub fn current_user() -> Result<String> {
    let mut raw = std::ptr::null_mut();
    // Management runs on one impersonating pipe thread. Execution has no thread
    // token and uses its process identity; the service's SYSTEM identity is never
    // used as the owner of a caller's accounts or DPAPI journal.
    if unsafe {
        windows_sys::Win32::System::Threading::OpenThreadToken(
            windows_sys::Win32::System::Threading::GetCurrentThread(),
            TOKEN_QUERY,
            1,
            &mut raw,
        )
    } == 0
    {
        if std::io::Error::last_os_error().raw_os_error() != Some(1008) {
            return Err(error("OpenThreadToken"));
        }
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            return Err(error("OpenProcessToken"));
        }
    }
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    token_user(token.as_raw_handle())
}

pub fn descriptor(sddl: &str) -> Result<Local> {
    if sddl.contains('\0') {
        return Err("security descriptor cannot contain NUL".into());
    }
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
        Err(error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ))
    } else {
        Ok(Local(raw))
    }
}

pub fn random_hex(bytes: usize) -> Result<String> {
    let mut value = vec![0u8; bytes];
    getrandom::getrandom(&mut value).map_err(|error| error.to_string())?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub const OWNER_ACCESS: u32 = 0x000f01ff;
pub const PARTICIPANT_ACCESS: u32 = 0x000201ff;

/// Owns an ACL-protected desktop; participant rights exclude ownership and ACL changes.
pub struct Desktop {
    handle: HDESK,
    pub name: String,
}
// SAFETY: the exclusively owned desktop handle is process-wide.
unsafe impl Send for Desktop {}

pub fn window_station_name() -> Result<String> {
    let station = unsafe { GetProcessWindowStation() };
    if station.is_null() {
        return Err(error("GetProcessWindowStation"));
    }
    let mut name = [0u16; 256];
    let mut bytes = 0;
    if unsafe {
        GetUserObjectInformationW(
            station,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            size_of_val(&name) as u32,
            &mut bytes,
        )
    } == 0
    {
        return Err(error("GetUserObjectInformationW(window station)"));
    }
    let length = name
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(name.len());
    String::from_utf16(&name[..length]).map_err(|error| error.to_string())
}

impl Desktop {
    pub fn new(owner: &str, account: &str, capability: &str) -> Result<Self> {
        // LogonW may share the caller's logon SID. Only the host USER SID gets
        // management access; the per-execution SID also passes restricted checks.
        let descriptor = descriptor(&format!(
            "D:P(A;;0x{OWNER_ACCESS:x};;;{owner})(A;;0x{PARTICIPANT_ACCESS:x};;;{account})(A;;0x{PARTICIPANT_ACCESS:x};;;{capability})"
        ))?;

        let name = format!("AshExecution-{}", random_hex(16)?);
        Self::create(&name, &descriptor)
    }

    pub fn create(name: &str, descriptor: &Local) -> Result<Self> {
        if name.is_empty() || name.contains('\0') {
            return Err("private desktop name must be nonempty and cannot contain NUL".into());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.as_ptr(),
            bInheritHandle: 0,
        };
        let station = window_station_name()?;
        let handle = unsafe {
            CreateDesktopW(
                wide(name).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                OWNER_ACCESS,
                &attributes,
            )
        };
        if handle.is_null() {
            return Err(error("CreateDesktopW"));
        }
        Ok(Self {
            handle,
            name: format!("{station}\\{name}"),
        })
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.handle);
        }
    }
}
