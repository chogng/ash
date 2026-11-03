// Licensed under the MIT License.
//! Each execution owns a desktop; untrusted descendants never share the host UI.

use super::win;
use super::win::Result;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::StationsAndDesktops::CloseDesktop;
use windows_sys::Win32::System::StationsAndDesktops::CreateDesktopW;
use windows_sys::Win32::System::StationsAndDesktops::GetProcessWindowStation;
use windows_sys::Win32::System::StationsAndDesktops::GetUserObjectInformationW;
use windows_sys::Win32::System::StationsAndDesktops::HDESK;
use windows_sys::Win32::System::StationsAndDesktops::UOI_NAME;

const OWNER_ACCESS: u32 = 0x000f01ff;
// Windows DLL initialization opens the private desktop with participant rights.
// These rights affect only this execution's desktop; the job blocks clipboard,
// desktop switching and host settings. Ownership and ACL changes remain excluded.
const PARTICIPANT_ACCESS: u32 = 0x000201ff;

pub(super) struct Desktop {
    handle: HDESK,
    pub(super) name: String,
}

unsafe impl Send for Desktop {}

pub(super) fn window_station_name() -> Result<String> {
    let station = unsafe { GetProcessWindowStation() };
    if station.is_null() {
        return Err(win::error("GetProcessWindowStation"));
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
        return Err(win::error("GetUserObjectInformationW(window station)"));
    }
    let length = name
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(name.len());
    String::from_utf16(&name[..length]).map_err(|error| error.to_string())
}

impl Desktop {
    pub(super) fn new(owner: &str, account: &str, capability: &str) -> Result<Self> {
        // OpenSSH processes can have a noninteractive station. CreateDesktopW uses
        // the caller's station, which is also inherited by the trusted logon worker.
        let station = window_station_name()?;
        // LogonW may share the caller's logon SID. Only the host USER SID gets
        // management access; the per-execution SID also passes restricted checks.
        let descriptor = win::descriptor(&format!(
            "D:P(A;;0x{OWNER_ACCESS:x};;;{owner})(A;;0x{PARTICIPANT_ACCESS:x};;;{account})(A;;0x{PARTICIPANT_ACCESS:x};;;{capability})"
        ))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let name = format!("AshExecution-{}", win::random_hex(16)?);
        let handle = unsafe {
            CreateDesktopW(
                win::wide(&name).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                OWNER_ACCESS,
                &attributes,
            )
        };
        if handle.is_null() {
            return Err(win::error("CreateDesktopW"));
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
