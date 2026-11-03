// Licensed under the MIT License.
//! Each execution owns a desktop; untrusted descendants never share the host UI.

use super::win;
use super::win::Result;
use std::io::Read;
use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::StationsAndDesktops::CloseDesktop;
use windows_sys::Win32::System::StationsAndDesktops::CloseWindowStation;
use windows_sys::Win32::System::StationsAndDesktops::CreateDesktopW;
use windows_sys::Win32::System::StationsAndDesktops::CreateWindowStationW;
use windows_sys::Win32::System::StationsAndDesktops::GetProcessWindowStation;
use windows_sys::Win32::System::StationsAndDesktops::GetUserObjectInformationW;
use windows_sys::Win32::System::StationsAndDesktops::HDESK;
use windows_sys::Win32::System::StationsAndDesktops::HWINSTA;
use windows_sys::Win32::System::StationsAndDesktops::SetProcessWindowStation;
use windows_sys::Win32::System::StationsAndDesktops::UOI_NAME;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

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
        Self::create(&name, &attributes)
    }

    fn create(name: &str, attributes: &SECURITY_ATTRIBUTES) -> Result<Self> {
        let station = window_station_name()?;
        let handle = unsafe {
            CreateDesktopW(
                win::wide(name).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                OWNER_ACCESS,
                attributes,
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

const STATION_OWNER_ACCESS: u32 = 0x000f037f;
// The station is private to this execution. Participants may initialize Win32
// there but cannot create desktops or change the station's ACL.
const STATION_PARTICIPANT_ACCESS: u32 = 0x00020367;
const STATION_PREFIX: &str = "AshSandbox-";

pub(super) struct PrivateStation {
    holder: Child,
    pub(super) worker_desktop: String,
    pub(super) command_desktop: String,
}

impl PrivateStation {
    pub(super) fn start(runner: &Path, account: &str, capability: &str) -> Result<Self> {
        let id = win::random_hex(16)?;
        let holder = Command::new(runner)
            .args(["hold-private-station", &id, account, capability])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start the private station holder: {error}"))?;
        let mut station = Self {
            holder,
            worker_desktop: format!("{STATION_PREFIX}{id}\\Worker"),
            command_desktop: format!("{STATION_PREFIX}{id}\\AshExecution-{id}"),
        };
        station.wait_until_ready()?;
        Ok(station)
    }

    fn wait_until_ready(&mut self) -> Result<()> {
        let mut output = self
            .holder
            .stdout
            .take()
            .ok_or("missing station readiness pipe")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let mut available = 0;
            if unsafe {
                PeekNamedPipe(
                    output.as_raw_handle(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(win::error("private station readiness pipe"));
            }
            if available != 0 {
                let mut ready = [0];
                output
                    .read_exact(&mut ready)
                    .map_err(|error| error.to_string())?;
                return if ready == [1] {
                    Ok(())
                } else {
                    Err("invalid private station readiness response".into())
                };
            }
            if Instant::now() >= deadline {
                return Err("private station holder did not become ready".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for PrivateStation {
    fn drop(&mut self) {
        let _ = self.holder.kill();
        let _ = self.holder.wait();
    }
}

struct StationHandle(HWINSTA);

impl Drop for StationHandle {
    fn drop(&mut self) {
        unsafe { CloseWindowStation(self.0) };
    }
}

pub(super) fn hold_private_station(id: &str, account: &str, capability: &str) -> Result<()> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid private station identifier".into());
    }
    let account = win::sid_text(win::sid(account)?.0)?;
    let capability = win::sid_text(win::sid(capability)?.0)?;
    let owner = win::current_user()?;
    let descriptor = win::descriptor(&format!(
        "D:P(A;;0x{STATION_OWNER_ACCESS:x};;;{owner})(A;;0x{STATION_PARTICIPANT_ACCESS:x};;;{account})(A;;0x{STATION_PARTICIPANT_ACCESS:x};;;{capability})"
    ))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let original = unsafe { GetProcessWindowStation() };
    if original.is_null() {
        return Err(win::error("GetProcessWindowStation(station holder)"));
    }
    let handle = unsafe {
        CreateWindowStationW(
            win::wide(format!("{STATION_PREFIX}{id}")).as_ptr(),
            0,
            STATION_OWNER_ACCESS,
            &attributes,
        )
    };
    if handle.is_null() {
        return Err(win::error("CreateWindowStationW"));
    }
    let station = StationHandle(handle);
    // SetProcessWindowStation changes process-wide state. This holder exists
    // solely to create the desktops and keep their handles alive.
    if unsafe { SetProcessWindowStation(station.0) } == 0 {
        return Err(win::error("SetProcessWindowStation(private station)"));
    }
    let desktops = (|| {
        let worker_descriptor = win::descriptor(&format!(
            "D:P(A;;0x{OWNER_ACCESS:x};;;{owner})(A;;0x{PARTICIPANT_ACCESS:x};;;{account})"
        ))?;
        let worker_attributes = SECURITY_ATTRIBUTES {
            lpSecurityDescriptor: worker_descriptor.0,
            ..attributes
        };
        let worker = Desktop::create("Worker", &worker_attributes)?;
        let command_descriptor = win::descriptor(&format!(
            "D:P(A;;0x{OWNER_ACCESS:x};;;{owner})(A;;0x{PARTICIPANT_ACCESS:x};;;{account})(A;;0x{PARTICIPANT_ACCESS:x};;;{capability})"
        ))?;
        let command_attributes = SECURITY_ATTRIBUTES {
            lpSecurityDescriptor: command_descriptor.0,
            ..attributes
        };
        let command = Desktop::create(&format!("AshExecution-{id}"), &command_attributes)?;
        Ok::<_, String>((worker, command))
    })();
    if unsafe { SetProcessWindowStation(original) } == 0 {
        return Err(win::error("SetProcessWindowStation(restore)"));
    }
    let _desktops = desktops?;
    {
        let mut output = std::io::stdout().lock();
        output
            .write_all(&[1])
            .and_then(|()| output.flush())
            .map_err(|error| error.to_string())?;
    }
    // EOF also releases the desktops if the app server exits unexpectedly.
    std::io::stdin()
        .read(&mut [0])
        .map_err(|error| error.to_string())?;
    Ok(())
}
