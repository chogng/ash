#![allow(unsafe_code)]

use std::os::windows::ffi::OsStrExt;

use super::super::LoginItemRegistration;
use super::super::LoginItemServiceKind;
use super::super::LoginItemStartupState;
use super::super::LoginItemStatus;
use super::LOGIN_ITEM;
use super::LoginItemRequest;
use super::LoginItemState;
use super::LoginItemUpdate;
use crate::services::SystemServiceError;

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_APPROVED_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

struct RegistryKey(windows_sys::Win32::System::Registry::HKEY);

impl RegistryKey {
    fn create(path: &[u16]) -> Result<Self, SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        use windows_sys::Win32::System::Registry::KEY_READ;
        use windows_sys::Win32::System::Registry::KEY_WRITE;
        use windows_sys::Win32::System::Registry::RegCreateKeyExW;

        let mut key = std::ptr::null_mut();
        // SAFETY: `path` is NUL terminated; output storage is valid and the owned handle is closed
        // by `Drop`.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_READ | KEY_WRITE,
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

    fn write_string(&self, name: &[u16], value: &[u16]) -> Result<(), SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::REG_SZ;
        use windows_sys::Win32::System::Registry::RegSetValueExW;

        let byte_count = byte_count::<u16>(value.len())?;
        // SAFETY: Both buffers are live and NUL terminated for the synchronous registry call.
        let status = unsafe {
            RegSetValueExW(
                self.0,
                name.as_ptr(),
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

    fn write_binary(&self, name: &[u16], value: &[u8]) -> Result<(), SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::REG_BINARY;
        use windows_sys::Win32::System::Registry::RegSetValueExW;

        let byte_count = u32::try_from(value.len()).map_err(|_| registry_value_too_large())?;
        // SAFETY: `name` is NUL terminated and `value` remains live for the call.
        let status = unsafe {
            RegSetValueExW(
                self.0,
                name.as_ptr(),
                0,
                REG_BINARY,
                value.as_ptr(),
                byte_count,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(windows_error(status))
        }
    }

    fn read_value(&self, name: &[u16]) -> Result<Option<(u32, Vec<u8>)>, SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::RegQueryValueExW;

        let mut value_type = 0;
        let mut byte_count = 0;
        // SAFETY: The first query supplies valid metadata pointers and no data buffer.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name.as_ptr(),
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
        let mut value = vec![0_u8; usize::try_from(byte_count).expect("u32 fits usize")];
        // SAFETY: The allocated byte vector has the capacity reported by the registry query.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut value_type,
                value.as_mut_ptr(),
                &mut byte_count,
            )
        };
        if status == ERROR_SUCCESS {
            value.truncate(usize::try_from(byte_count).expect("u32 fits usize"));
            Ok(Some((value_type, value)))
        } else {
            Err(windows_error(status))
        }
    }

    fn read_string(&self, name: &[u16]) -> Result<Option<Vec<u16>>, SystemServiceError> {
        use windows_sys::Win32::System::Registry::REG_SZ;

        let Some((value_type, bytes)) = self.read_value(name)? else {
            return Ok(None);
        };
        if value_type != REG_SZ || bytes.len() % 2 != 0 {
            return Err(SystemServiceError::backend(
                LOGIN_ITEM,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Windows login-item command is not a UTF-16 REG_SZ value",
                ),
            ));
        }
        let mut value = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        while value.last() == Some(&0) {
            value.pop();
        }
        Ok(Some(value))
    }

    fn delete_value(&self, name: &[u16]) -> Result<(), SystemServiceError> {
        use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::RegDeleteValueW;

        // SAFETY: `name` is a live NUL-terminated registry value name.
        let status = unsafe { RegDeleteValueW(self.0, name.as_ptr()) };
        if matches!(status, ERROR_SUCCESS | ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err(windows_error(status))
        }
    }
}

impl Drop for RegistryKey {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Registry::RegCloseKey;

        // SAFETY: This owned handle came from a successful registry open or create call.
        unsafe { RegCloseKey(self.0) };
    }
}

fn byte_count<T>(length: usize) -> Result<u32, SystemServiceError> {
    length
        .checked_mul(std::mem::size_of::<T>())
        .and_then(|bytes| u32::try_from(bytes).ok())
        .ok_or_else(registry_value_too_large)
}

fn registry_value_too_large() -> SystemServiceError {
    SystemServiceError::invalid_input(
        LOGIN_ITEM,
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Windows login-item registry value is too large",
        ),
    )
}

fn windows_error(status: u32) -> SystemServiceError {
    SystemServiceError::backend(LOGIN_ITEM, std::io::Error::from_raw_os_error(status as i32))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn append_argument(command: &mut Vec<u16>, argument: &[u16]) {
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

fn launch_command(request: &LoginItemRequest) -> Vec<u16> {
    let mut command = Vec::new();
    append_argument(
        &mut command,
        &request
            .executable()
            .as_os_str()
            .encode_wide()
            .collect::<Vec<_>>(),
    );
    for argument in request.arguments() {
        command.push(u16::from(b' '));
        append_argument(&mut command, &argument.encode_wide().collect::<Vec<_>>());
    }
    command
}

fn require_main_application(request: &LoginItemRequest) -> Result<(), SystemServiceError> {
    if matches!(
        request.service_kind(),
        LoginItemServiceKind::MainApplication
    ) {
        Ok(())
    } else {
        Err(SystemServiceError::unsupported(LOGIN_ITEM))
    }
}

pub(super) fn set(update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
    require_main_application(update.request())?;
    let run_path = wide(RUN_KEY);
    let approved_path = wide(STARTUP_APPROVED_KEY);
    let name = wide(update.request().name().as_str());
    match update.registration() {
        LoginItemRegistration::Enable => {
            let run = RegistryKey::create(&run_path)?;
            let approved = RegistryKey::create(&approved_path)?;
            let mut command = launch_command(update.request());
            command.push(0);
            run.write_string(&name, &command)?;
            match update.startup_state() {
                LoginItemStartupState::Enabled => approved.delete_value(&name)?,
                LoginItemStartupState::Disabled => {
                    approved.write_binary(&name, &[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])?;
                }
            }
        }
        LoginItemRegistration::Disable => {
            let matches = RegistryKey::open(&run_path)?
                .map(|run| run.read_string(&name))
                .transpose()?
                .flatten()
                .is_some_and(|command| command == launch_command(update.request()));
            if matches {
                let run = RegistryKey::create(&run_path)?;
                let approved = RegistryKey::create(&approved_path)?;
                run.delete_value(&name)?;
                approved.delete_value(&name)?;
            }
        }
    }
    Ok(())
}

pub(super) fn get(request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
    use windows_sys::Win32::System::Registry::REG_BINARY;

    require_main_application(request)?;
    let name = wide(request.name().as_str());
    let Some(run) = RegistryKey::open(&wide(RUN_KEY))? else {
        return Ok(LoginItemState::new(LoginItemStatus::NotRegistered));
    };
    if !run
        .read_string(&name)?
        .is_some_and(|command| command == launch_command(request))
    {
        return Ok(LoginItemState::new(LoginItemStatus::NotRegistered));
    }
    let disabled = match RegistryKey::open(&wide(STARTUP_APPROVED_KEY))? {
        Some(approved) => approved
            .read_value(&name)?
            .is_some_and(|(value_type, bytes)| {
                value_type != REG_BINARY || bytes.first() == Some(&3)
            }),
        None => false,
    };
    Ok(LoginItemState::new(if disabled {
        LoginItemStatus::Disabled
    } else {
        LoginItemStatus::Enabled
    }))
}
