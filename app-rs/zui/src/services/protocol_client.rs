use std::cell::RefCell;
use std::error::Error;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;

use crate::app::ProtocolScheme;

use super::SystemServiceError;

#[path = "protocol_client/platform.rs"]
mod platform;

const DEFAULT_PROTOCOL_CLIENT: &str = "default protocol client";

/// Validated Linux desktop-entry filename used for application identity.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DesktopFileName(String);

impl DesktopFileName {
    /// Creates a reverse-DNS desktop filename, accepting an optional `.desktop` suffix.
    pub fn new(value: impl Into<String>) -> Result<Self, DesktopFileNameError> {
        let value = value.into();
        let identity = value.strip_suffix(".desktop").unwrap_or(&value);
        if identity.split('.').count() < 2
            || identity.split('.').any(|segment| {
                segment.is_empty()
                    || !segment
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
        {
            return Err(DesktopFileNameError);
        }
        Ok(Self(format!("{identity}.desktop")))
    }

    /// Returns the canonical filename including its `.desktop` suffix.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the desktop application identity without its filename suffix.
    pub fn application_id(&self) -> &str {
        self.0
            .strip_suffix(".desktop")
            .expect("validated desktop filenames always retain their suffix")
    }
}

/// Invalid Linux desktop-entry identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DesktopFileNameError;

impl fmt::Display for DesktopFileNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "desktop filename must be a reverse-DNS identity with an optional .desktop suffix",
        )
    }
}

impl Error for DesktopFileNameError {}

/// Platform-specific overrides used when registering or comparing one protocol client.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProtocolClientOptions {
    executable: Option<PathBuf>,
    arguments: Vec<OsString>,
    desktop_file_name: Option<DesktopFileName>,
}

impl ProtocolClientOptions {
    /// Creates options using the current executable and detected platform application identity.
    pub const fn new() -> Self {
        Self {
            executable: None,
            arguments: Vec::new(),
            desktop_file_name: None,
        }
    }

    /// Overrides the executable written to or compared with the Windows protocol command.
    pub fn with_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.executable = Some(executable.into());
        self
    }

    /// Appends one argument before the protocol URL in the Windows launch command.
    pub fn with_argument(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    /// Replaces arguments inserted before the protocol URL in the Windows launch command.
    pub fn with_arguments(
        mut self,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        self.arguments = arguments.into_iter().map(Into::into).collect();
        self
    }

    /// Selects the installed Linux desktop entry used by GIO association APIs.
    pub fn with_desktop_file_name(mut self, name: DesktopFileName) -> Self {
        self.desktop_file_name = Some(name);
        self
    }

    /// Returns the explicit executable override, if present.
    pub fn executable(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    /// Returns arguments inserted before the protocol URL.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the explicit Linux desktop-entry filename, if present.
    pub const fn desktop_file_name(&self) -> Option<&DesktopFileName> {
        self.desktop_file_name.as_ref()
    }
}

/// Fully resolved registration request passed to an injected protocol-client backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolClientRequest {
    scheme: ProtocolScheme,
    executable: PathBuf,
    arguments: Vec<OsString>,
    desktop_file_name: Option<DesktopFileName>,
}

impl ProtocolClientRequest {
    /// Returns the validated URL scheme.
    pub const fn scheme(&self) -> &ProtocolScheme {
        &self.scheme
    }

    /// Returns the absolute executable used by Windows registration and comparison.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Returns literal arguments inserted before the protocol URL on Windows.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the installed Linux desktop-entry filename when configured or detected.
    pub const fn desktop_file_name(&self) -> Option<&DesktopFileName> {
        self.desktop_file_name.as_ref()
    }
}

/// Outcome of removing this application as the default protocol client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolClientRemoval {
    /// This exact application registration was removed or replaced.
    Removed,
    /// The requested application command was not the current default.
    NotCurrent,
}

/// Main-thread backend for operating-system default protocol-client associations.
pub trait ProtocolClientService {
    /// Makes the application in `request` the default client for its URL scheme.
    fn set_default(&mut self, request: &ProtocolClientRequest) -> Result<(), SystemServiceError>;

    /// Returns whether the exact application in `request` is the current default client.
    fn is_default(&mut self, request: &ProtocolClientRequest) -> Result<bool, SystemServiceError>;

    /// Removes or replaces the exact application registration when it is currently selected.
    fn remove_default(
        &mut self,
        _request: &ProtocolClientRequest,
    ) -> Result<ProtocolClientRemoval, SystemServiceError> {
        Err(SystemServiceError::unsupported(DEFAULT_PROTOCOL_CLIENT))
    }
}

/// Cloneable main-thread capability for default protocol-client associations.
#[derive(Clone)]
pub struct ProtocolClientHandle {
    service: Rc<RefCell<Box<dyn ProtocolClientService>>>,
    desktop_file_name: Rc<RefCell<Option<DesktopFileName>>>,
}

impl ProtocolClientHandle {
    pub(crate) fn new(service: impl ProtocolClientService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
            desktop_file_name: Rc::new(RefCell::new(None)),
        }
    }

    pub(crate) fn set_desktop_file_name(&self, name: Option<DesktopFileName>) {
        *self.desktop_file_name.borrow_mut() = name;
    }

    /// Makes the current executable the default client for `scheme`.
    pub fn set_default(&self, scheme: ProtocolScheme) -> Result<(), SystemServiceError> {
        self.set_default_with(scheme, ProtocolClientOptions::new())
    }

    /// Makes the configured application command the default client for `scheme`.
    pub fn set_default_with(
        &self,
        scheme: ProtocolScheme,
        options: ProtocolClientOptions,
    ) -> Result<(), SystemServiceError> {
        let request = resolve_request(
            scheme,
            options,
            self.desktop_file_name.borrow().as_ref().cloned(),
        )?;
        self.service.borrow_mut().set_default(&request)
    }

    /// Returns whether the current executable is the default client for `scheme`.
    pub fn is_default(&self, scheme: ProtocolScheme) -> Result<bool, SystemServiceError> {
        self.is_default_with(scheme, ProtocolClientOptions::new())
    }

    /// Returns whether the configured application command is the default client for `scheme`.
    pub fn is_default_with(
        &self,
        scheme: ProtocolScheme,
        options: ProtocolClientOptions,
    ) -> Result<bool, SystemServiceError> {
        let request = resolve_request(
            scheme,
            options,
            self.desktop_file_name.borrow().as_ref().cloned(),
        )?;
        self.service.borrow_mut().is_default(&request)
    }

    /// Removes the current executable as the default client for `scheme` when selected.
    pub fn remove_default(
        &self,
        scheme: ProtocolScheme,
    ) -> Result<ProtocolClientRemoval, SystemServiceError> {
        self.remove_default_with(scheme, ProtocolClientOptions::new())
    }

    /// Removes the configured application command when it is the selected protocol client.
    pub fn remove_default_with(
        &self,
        scheme: ProtocolScheme,
        options: ProtocolClientOptions,
    ) -> Result<ProtocolClientRemoval, SystemServiceError> {
        let request = resolve_request(
            scheme,
            options,
            self.desktop_file_name.borrow().as_ref().cloned(),
        )?;
        self.service.borrow_mut().remove_default(&request)
    }
}

fn resolve_request(
    scheme: ProtocolScheme,
    options: ProtocolClientOptions,
    configured_desktop_file_name: Option<DesktopFileName>,
) -> Result<ProtocolClientRequest, SystemServiceError> {
    let executable = match options.executable {
        Some(executable) => {
            validate_executable(&executable)?;
            executable
        }
        None => std::env::current_exe()
            .map_err(|source| SystemServiceError::backend(DEFAULT_PROTOCOL_CLIENT, source))?,
    };
    for argument in &options.arguments {
        if os_str_contains_nul(argument) {
            return Err(invalid_input(
                "protocol-client arguments cannot contain NUL",
            ));
        }
    }
    #[cfg(target_os = "linux")]
    let desktop_file_name = match options.desktop_file_name {
        Some(name) => Some(name),
        None => match configured_desktop_file_name {
            Some(name) => Some(name),
            None => std::env::var("CHROME_DESKTOP")
                .ok()
                .map(DesktopFileName::new)
                .transpose()
                .map_err(|source| {
                    SystemServiceError::invalid_input(DEFAULT_PROTOCOL_CLIENT, source)
                })?,
        },
    };
    #[cfg(not(target_os = "linux"))]
    let desktop_file_name = options.desktop_file_name.or(configured_desktop_file_name);
    Ok(ProtocolClientRequest {
        scheme,
        executable,
        arguments: options.arguments,
        desktop_file_name,
    })
}

fn validate_executable(executable: &Path) -> Result<(), SystemServiceError> {
    if !executable.is_absolute() {
        return Err(invalid_input(
            "protocol-client executable must be an absolute path",
        ));
    }
    if os_str_contains_nul(executable.as_os_str()) {
        return Err(invalid_input(
            "protocol-client executable cannot contain NUL",
        ));
    }
    Ok(())
}

fn invalid_input(message: &'static str) -> SystemServiceError {
    SystemServiceError::invalid_input(
        DEFAULT_PROTOCOL_CLIENT,
        std::io::Error::new(std::io::ErrorKind::InvalidInput, message),
    )
}

#[cfg(unix)]
fn os_str_contains_nul(value: &OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;

    value.as_bytes().contains(&0)
}

#[cfg(windows)]
fn os_str_contains_nul(value: &OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().any(|unit| unit == 0)
}

#[cfg(not(any(unix, windows)))]
fn os_str_contains_nul(value: &OsStr) -> bool {
    value.to_string_lossy().contains('\0')
}

/// Default native protocol-client backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemProtocolClients;

impl ProtocolClientService for SystemProtocolClients {
    fn set_default(&mut self, request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
        platform::set_default(request)
    }

    fn is_default(&mut self, request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
        platform::is_default(request)
    }

    fn remove_default(
        &mut self,
        request: &ProtocolClientRequest,
    ) -> Result<ProtocolClientRemoval, SystemServiceError> {
        platform::remove_default(request)
    }
}

#[cfg(test)]
#[path = "protocol_client_tests.rs"]
mod tests;
