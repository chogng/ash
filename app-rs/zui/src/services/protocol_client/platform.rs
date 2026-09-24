#![allow(unsafe_code)]

use super::DEFAULT_PROTOCOL_CLIENT;
use super::ProtocolClientRemoval;
use super::ProtocolClientRequest;
use crate::services::SystemServiceError;

#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
pub(super) fn set_default(request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
    macos::set_default(request)
}

#[cfg(target_os = "macos")]
pub(super) fn is_default(request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
    macos::is_default(request)
}

#[cfg(target_os = "macos")]
pub(super) fn remove_default(
    request: &ProtocolClientRequest,
) -> Result<ProtocolClientRemoval, SystemServiceError> {
    macos::remove_default(request)
}

#[cfg(target_os = "linux")]
fn linux_desktop_file(
    request: &ProtocolClientRequest,
) -> Result<&super::DesktopFileName, SystemServiceError> {
    request.desktop_file_name().ok_or_else(|| {
        SystemServiceError::invalid_input(
            DEFAULT_PROTOCOL_CLIENT,
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Linux protocol clients require an installed desktop filename or CHROME_DESKTOP",
            ),
        )
    })
}

#[cfg(target_os = "linux")]
pub(super) fn set_default(request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
    use gio::DesktopAppInfo;
    use gio::prelude::AppInfoExt;

    let desktop_file = linux_desktop_file(request)?;
    let app_info = DesktopAppInfo::new(desktop_file.as_str()).ok_or_else(|| {
        SystemServiceError::backend(
            DEFAULT_PROTOCOL_CLIENT,
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!(
                    "installed desktop entry {} was not found",
                    desktop_file.as_str()
                ),
            ),
        )
    })?;
    app_info
        .set_as_default_for_type(&format!("x-scheme-handler/{}", request.scheme().as_str()))
        .map_err(|source| SystemServiceError::backend(DEFAULT_PROTOCOL_CLIENT, source))
}

#[cfg(target_os = "linux")]
pub(super) fn is_default(request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
    use gio::AppInfo;
    use gio::prelude::AppInfoExt;

    let desktop_file = linux_desktop_file(request)?;
    Ok(AppInfo::default_for_uri_scheme(request.scheme().as_str())
        .and_then(|application| application.id())
        .is_some_and(|identifier| identifier == desktop_file.as_str()))
}

#[cfg(target_os = "linux")]
pub(super) fn remove_default(
    _request: &ProtocolClientRequest,
) -> Result<ProtocolClientRemoval, SystemServiceError> {
    Err(SystemServiceError::unsupported(DEFAULT_PROTOCOL_CLIENT))
}

#[cfg(target_os = "windows")]
struct RegistryKey(windows_sys::Win32::System::Registry::HKEY);

#[cfg(target_os = "windows")]
impl RegistryKey {
    fn create(path: &[u16]) -> Result<Self, SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        use windows_sys::Win32::System::Registry::KEY_WRITE;
        use windows_sys::Win32::System::Registry::RegCreateKeyExW;

        let mut key = std::ptr::null_mut();
        // SAFETY: `path` is NUL terminated; output storage is valid, and no security descriptor is
        // supplied. The resulting handle is closed by `Drop`.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_WRITE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if status == ERROR_SUCCESS {
            Ok(Self(key))
        } else {
            Err(windows_error(status))
        }
    }

    fn open(path: &[u16]) -> Result<Option<Self>, SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
        use windows_sys::Win32::Foundation::ERROR_PATH_NOT_FOUND;
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        use windows_sys::Win32::System::Registry::KEY_READ;
        use windows_sys::Win32::System::Registry::RegOpenKeyExW;

        let mut key = std::ptr::null_mut();
        // SAFETY: `path` is NUL terminated and output storage is valid.
        let status =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) };
        match status {
            ERROR_SUCCESS => Ok(Some(Self(key))),
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
            status => Err(windows_error(status)),
        }
    }

    fn write_string(&self, name: Option<&[u16]>, value: &[u16]) -> Result<(), SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::REG_SZ;
        use windows_sys::Win32::System::Registry::RegSetValueExW;

        let byte_count = value
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .and_then(|length| u32::try_from(length).ok())
            .ok_or_else(|| {
                SystemServiceError::invalid_input(
                    DEFAULT_PROTOCOL_CLIENT,
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Windows protocol registry value is too large",
                    ),
                )
            })?;
        // SAFETY: The name, when present, and value are NUL terminated live UTF-16 buffers.
        let status = unsafe {
            RegSetValueExW(
                self.0,
                name.map_or(std::ptr::null(), |name| name.as_ptr()),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                byte_count,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(windows_error(status))
        }
    }

    fn read_default_string(&self) -> Result<Option<Vec<u16>>, SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::REG_SZ;
        use windows_sys::Win32::System::Registry::RegQueryValueExW;

        let mut value_type = 0;
        let mut byte_count = 0;
        // SAFETY: The query supplies valid output pointers and intentionally omits a data buffer.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                std::ptr::null(),
                std::ptr::null(),
                &mut value_type,
                std::ptr::null_mut(),
                &mut byte_count,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(windows_error(status));
        }
        if value_type != REG_SZ || byte_count % 2 != 0 {
            return Err(SystemServiceError::backend(
                DEFAULT_PROTOCOL_CLIENT,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Windows protocol command is not a UTF-16 REG_SZ value",
                ),
            ));
        }
        let mut value = vec![0_u16; byte_count as usize / 2];
        // SAFETY: `value` owns at least `byte_count` writable bytes and all output pointers are
        // valid for the synchronous registry query.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                std::ptr::null(),
                std::ptr::null(),
                &mut value_type,
                value.as_mut_ptr().cast(),
                &mut byte_count,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(windows_error(status));
        }
        while value.last() == Some(&0) {
            value.pop();
        }
        Ok(Some(value))
    }
}

#[cfg(target_os = "windows")]
impl Drop for RegistryKey {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Registry::RegCloseKey;

        // SAFETY: This handle was returned by a successful registry open/create call and is owned
        // by this value.
        unsafe { RegCloseKey(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn windows_error(status: u32) -> SystemServiceError {
    SystemServiceError::backend(
        DEFAULT_PROTOCOL_CLIENT,
        std::io::Error::from_raw_os_error(status as i32),
    )
}

#[cfg(target_os = "windows")]
fn windows_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn windows_protocol_key(request: &ProtocolClientRequest) -> Vec<u16> {
    windows_wide(&format!("Software\\Classes\\{}", request.scheme().as_str()))
}

#[cfg(target_os = "windows")]
fn windows_command_key(request: &ProtocolClientRequest) -> Vec<u16> {
    windows_wide(&format!(
        "Software\\Classes\\{}\\shell\\open\\command",
        request.scheme().as_str()
    ))
}

#[cfg(target_os = "windows")]
fn append_windows_argument(command: &mut Vec<u16>, argument: &[u16]) {
    command.push(u16::from(b'"'));
    let mut backslashes = 0;
    for &unit in argument {
        if unit == u16::from(b'\\') {
            backslashes += 1;
            continue;
        }
        if unit == u16::from(b'"') {
            command.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2 + 1));
        } else {
            command.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
        }
        backslashes = 0;
        command.push(unit);
    }
    command.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2));
    command.push(u16::from(b'"'));
}

#[cfg(target_os = "windows")]
fn windows_launch_command(request: &ProtocolClientRequest) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut command = Vec::new();
    append_windows_argument(
        &mut command,
        &request
            .executable()
            .as_os_str()
            .encode_wide()
            .collect::<Vec<_>>(),
    );
    for argument in request.arguments() {
        command.push(u16::from(b' '));
        append_windows_argument(&mut command, &argument.encode_wide().collect::<Vec<_>>());
    }
    command.push(u16::from(b' '));
    append_windows_argument(&mut command, &"%1".encode_utf16().collect::<Vec<_>>());
    command
}

#[cfg(target_os = "windows")]
fn windows_notify_association_change() {
    use windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED;
    use windows_sys::Win32::UI::Shell::SHCNF_IDLIST;
    use windows_sys::Win32::UI::Shell::SHChangeNotify;

    let event = i32::try_from(SHCNE_ASSOCCHANGED).expect("association event fits in i32");
    // SAFETY: The association-changed event with ID-list flags requires two null item pointers.
    unsafe { SHChangeNotify(event, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
}

#[cfg(target_os = "windows")]
pub(super) fn set_default(request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
    let protocol_key = RegistryKey::create(&windows_protocol_key(request))?;
    let command_key = RegistryKey::create(&windows_command_key(request))?;
    let default_name = None;
    let url_protocol_name = windows_wide("URL Protocol");
    protocol_key.write_string(
        default_name,
        &windows_wide(&format!("URL:{}", request.scheme().as_str())),
    )?;
    protocol_key.write_string(Some(&url_protocol_name), &[0])?;
    let mut command = windows_launch_command(request);
    command.push(0);
    command_key.write_string(default_name, &command)?;
    windows_notify_association_change();
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn is_default(request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
    let Some(command_key) = RegistryKey::open(&windows_command_key(request))? else {
        return Ok(false);
    };
    Ok(command_key
        .read_default_string()?
        .is_some_and(|command| command == windows_launch_command(request)))
}

#[cfg(target_os = "windows")]
pub(super) fn remove_default(
    request: &ProtocolClientRequest,
) -> Result<ProtocolClientRemoval, SystemServiceError> {
    use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows_sys::Win32::Foundation::ERROR_PATH_NOT_FOUND;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    use windows_sys::Win32::System::Registry::RegDeleteTreeW;
    use windows_sys::Win32::System::Registry::RegDeleteValueW;

    if !is_default(request)? {
        return Ok(ProtocolClientRemoval::NotCurrent);
    }
    let shell_key = windows_wide(&format!(
        "Software\\Classes\\{}\\shell",
        request.scheme().as_str()
    ));
    // SAFETY: `shell_key` is a live NUL-terminated registry path beneath the validated scheme.
    let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, shell_key.as_ptr()) };
    if !matches!(
        status,
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND
    ) {
        return Err(windows_error(status));
    }
    let protocol_key_path = windows_protocol_key(request);
    let protocol_key = RegistryKey::create(&protocol_key_path)?;
    let url_protocol_name = windows_wide("URL Protocol");
    for name in [std::ptr::null(), url_protocol_name.as_ptr()] {
        // SAFETY: The null pointer selects the default value; the other pointer is a live
        // NUL-terminated value name, and the key was opened with write access.
        let status = unsafe { RegDeleteValueW(protocol_key.0, name) };
        if !matches!(status, ERROR_SUCCESS | ERROR_FILE_NOT_FOUND) {
            return Err(windows_error(status));
        }
    }
    windows_notify_association_change();
    Ok(ProtocolClientRemoval::Removed)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(super) fn set_default(_request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
    Err(SystemServiceError::unsupported(DEFAULT_PROTOCOL_CLIENT))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(super) fn is_default(_request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
    Err(SystemServiceError::unsupported(DEFAULT_PROTOCOL_CLIENT))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(super) fn remove_default(
    _request: &ProtocolClientRequest,
) -> Result<ProtocolClientRemoval, SystemServiceError> {
    Err(SystemServiceError::unsupported(DEFAULT_PROTOCOL_CLIENT))
}
