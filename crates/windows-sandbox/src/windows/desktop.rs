// Licensed under the MIT License.
//! Each execution owns a desktop; untrusted descendants never share the host UI.

use super::win;
use super::win::Result;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::StationsAndDesktops::CloseDesktop;
use windows_sys::Win32::System::StationsAndDesktops::CreateDesktopW;
use windows_sys::Win32::System::StationsAndDesktops::HDESK;

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

impl Desktop {
    pub(super) fn new(owner: &str, account: &str, capability: &str) -> Result<Self> {
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
            name: format!("Winsta0\\{name}"),
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
