use std::cell::RefCell;
use std::error::Error;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;

use super::SystemServiceError;

#[path = "login_item/platform.rs"]
mod platform;

const LOGIN_ITEM: &str = "login item";

/// Validated macOS service name or Windows startup registry value name.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LoginItemName(String);

impl LoginItemName {
    /// Creates a non-empty login-item identity without embedded NUL characters.
    pub fn new(value: impl Into<String>) -> Result<Self, LoginItemNameError> {
        let value = value.into();
        if value.trim().is_empty() || value.contains('\0') {
            return Err(LoginItemNameError);
        }
        Ok(Self(value))
    }

    /// Returns the validated identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Invalid login-item service or registry identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoginItemNameError;

impl fmt::Display for LoginItemNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("login-item identity cannot be empty or contain NUL")
    }
}

impl Error for LoginItemNameError {}

/// Installed service selected for macOS login-item management.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum LoginItemServiceKind {
    /// The signed main application bundle.
    #[default]
    MainApplication,
    /// A plist installed below `Contents/Library/LaunchAgents`.
    MacOsAgent(LoginItemName),
    /// A plist installed below `Contents/Library/LaunchDaemons`.
    MacOsDaemon(LoginItemName),
    /// A helper bundle installed below `Contents/Library/LoginItems`.
    MacOsLoginItem(LoginItemName),
}

/// Windows startup approval requested when a Run entry is installed.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LoginItemStartupState {
    /// The entry may launch and is visible as enabled in startup settings.
    #[default]
    Enabled,
    /// The entry remains registered but is disabled in startup settings.
    Disabled,
}

/// Whether a login-item association should be installed or removed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoginItemRegistration {
    /// Install or enable the selected login item.
    Enable,
    /// Remove the exact selected login item.
    Disable,
}

/// Command and platform identity used to update or query one login item.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LoginItemOptions {
    service_kind: LoginItemServiceKind,
    executable: Option<PathBuf>,
    arguments: Vec<OsString>,
    name: Option<LoginItemName>,
}

impl LoginItemOptions {
    /// Creates options for the main application and current executable.
    pub const fn new() -> Self {
        Self {
            service_kind: LoginItemServiceKind::MainApplication,
            executable: None,
            arguments: Vec::new(),
            name: None,
        }
    }

    /// Selects a packaged macOS app service.
    pub fn with_service_kind(mut self, service_kind: LoginItemServiceKind) -> Self {
        self.service_kind = service_kind;
        self
    }

    /// Overrides the executable installed or compared on Windows.
    pub fn with_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.executable = Some(executable.into());
        self
    }

    /// Appends one Windows launch argument after the executable.
    pub fn with_argument(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    /// Replaces Windows launch arguments while retaining their native boundaries.
    pub fn with_arguments(
        mut self,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        self.arguments = arguments.into_iter().map(Into::into).collect();
        self
    }

    /// Overrides the Windows Run registry value name.
    pub fn with_name(mut self, name: LoginItemName) -> Self {
        self.name = Some(name);
        self
    }

    /// Returns the selected macOS service kind.
    pub const fn service_kind(&self) -> &LoginItemServiceKind {
        &self.service_kind
    }

    /// Returns the explicit executable override, if present.
    pub fn executable(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    /// Returns Windows launch arguments.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the explicit Windows registry value name, if present.
    pub const fn name(&self) -> Option<&LoginItemName> {
        self.name.as_ref()
    }
}

/// Requested login-item mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginItemSettings {
    registration: LoginItemRegistration,
    options: LoginItemOptions,
    startup_state: LoginItemStartupState,
}

impl LoginItemSettings {
    /// Creates a request to install or enable one login item.
    pub const fn enable(options: LoginItemOptions) -> Self {
        Self {
            registration: LoginItemRegistration::Enable,
            options,
            startup_state: LoginItemStartupState::Enabled,
        }
    }

    /// Creates a request to remove the exact selected login item.
    pub const fn disable(options: LoginItemOptions) -> Self {
        Self {
            registration: LoginItemRegistration::Disable,
            options,
            startup_state: LoginItemStartupState::Enabled,
        }
    }

    /// Selects whether an installed Windows entry is enabled in startup settings.
    pub const fn with_startup_state(mut self, state: LoginItemStartupState) -> Self {
        self.startup_state = state;
        self
    }

    /// Returns whether this request enables or disables the login item.
    pub const fn registration(&self) -> LoginItemRegistration {
        self.registration
    }

    /// Returns the command and identity options.
    pub const fn options(&self) -> &LoginItemOptions {
        &self.options
    }

    /// Returns the requested Windows startup approval state.
    pub const fn startup_state(&self) -> LoginItemStartupState {
        self.startup_state
    }
}

/// Stable operating-system status for one login item.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoginItemStatus {
    /// No matching service or exact Windows command is registered.
    NotRegistered,
    /// The selected login item is registered and eligible to launch.
    Enabled,
    /// macOS registered the service but still requires user approval.
    RequiresApproval,
    /// Windows retains the Run entry but startup settings disable it.
    Disabled,
    /// The installed macOS service declared by the application could not be found.
    NotFound,
}

/// Query result for one exact login-item identity and command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoginItemState {
    status: LoginItemStatus,
}

impl LoginItemState {
    /// Creates a state reported by an injected platform backend.
    pub const fn new(status: LoginItemStatus) -> Self {
        Self { status }
    }

    /// Returns the platform-independent status.
    pub const fn status(self) -> LoginItemStatus {
        self.status
    }

    /// Returns whether the exact item remains registered to open at login.
    pub const fn open_at_login(self) -> bool {
        matches!(
            self.status,
            LoginItemStatus::Enabled | LoginItemStatus::Disabled
        )
    }

    /// Returns whether the operating system currently permits the item to launch.
    pub const fn will_launch_at_login(self) -> bool {
        matches!(self.status, LoginItemStatus::Enabled)
    }

    /// Returns whether the operating system retains a registration for this item.
    pub const fn is_registered(self) -> bool {
        matches!(
            self.status,
            LoginItemStatus::Enabled
                | LoginItemStatus::RequiresApproval
                | LoginItemStatus::Disabled
        )
    }
}

/// Fully resolved query passed to an injected login-item backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginItemRequest {
    service_kind: LoginItemServiceKind,
    executable: PathBuf,
    arguments: Vec<OsString>,
    name: LoginItemName,
}

impl LoginItemRequest {
    /// Returns the selected macOS service kind.
    pub const fn service_kind(&self) -> &LoginItemServiceKind {
        &self.service_kind
    }

    /// Returns the absolute Windows executable.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Returns the native Windows command arguments.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the Windows registry value identity.
    pub const fn name(&self) -> &LoginItemName {
        &self.name
    }
}

/// Fully resolved mutation passed to an injected login-item backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginItemUpdate {
    request: LoginItemRequest,
    registration: LoginItemRegistration,
    startup_state: LoginItemStartupState,
}

impl LoginItemUpdate {
    /// Returns the exact service identity and command.
    pub const fn request(&self) -> &LoginItemRequest {
        &self.request
    }

    /// Returns whether the item should be enabled or removed.
    pub const fn registration(&self) -> LoginItemRegistration {
        self.registration
    }

    /// Returns the requested Windows startup approval state.
    pub const fn startup_state(&self) -> LoginItemStartupState {
        self.startup_state
    }
}

/// Main-thread backend for login-item registration and status queries.
pub trait LoginItemService {
    /// Applies one exact login-item mutation.
    fn set(&mut self, update: &LoginItemUpdate) -> Result<(), SystemServiceError>;

    /// Queries one exact login-item identity and command.
    fn get(&mut self, request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError>;
}

/// Cloneable main-thread capability for application login items.
#[derive(Clone)]
pub struct LoginItemHandle {
    service: Rc<RefCell<Box<dyn LoginItemService>>>,
}

impl LoginItemHandle {
    pub(crate) fn new(service: impl LoginItemService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
        }
    }

    /// Applies one validated login-item mutation.
    pub fn set(&self, settings: LoginItemSettings) -> Result<(), SystemServiceError> {
        let request = resolve_request(settings.options)?;
        self.service.borrow_mut().set(&LoginItemUpdate {
            request,
            registration: settings.registration,
            startup_state: settings.startup_state,
        })
    }

    /// Queries one validated login-item identity and command.
    pub fn get(&self, options: LoginItemOptions) -> Result<LoginItemState, SystemServiceError> {
        let request = resolve_request(options)?;
        self.service.borrow_mut().get(&request)
    }
}

fn resolve_request(options: LoginItemOptions) -> Result<LoginItemRequest, SystemServiceError> {
    let executable = match options.executable {
        Some(executable) => executable,
        None => std::env::current_exe()
            .map_err(|source| SystemServiceError::backend(LOGIN_ITEM, source))?,
    };
    if !executable.is_absolute() {
        return Err(invalid_input(
            "login-item executable must be an absolute path",
        ));
    }
    if os_str_contains_nul(executable.as_os_str()) {
        return Err(invalid_input("login-item executable cannot contain NUL"));
    }
    for argument in &options.arguments {
        if os_str_contains_nul(argument) {
            return Err(invalid_input("login-item arguments cannot contain NUL"));
        }
    }
    let name = match options.name {
        Some(name) => name,
        None => {
            let stem = executable
                .file_stem()
                .and_then(OsStr::to_str)
                .ok_or_else(|| invalid_input("login-item executable has no UTF-8 file stem"))?;
            LoginItemName::new(stem)
                .map_err(|source| SystemServiceError::invalid_input(LOGIN_ITEM, source))?
        }
    };
    Ok(LoginItemRequest {
        service_kind: options.service_kind,
        executable,
        arguments: options.arguments,
        name,
    })
}

fn invalid_input(message: &'static str) -> SystemServiceError {
    SystemServiceError::invalid_input(
        LOGIN_ITEM,
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

/// Default native login-item backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemLoginItems;

impl LoginItemService for SystemLoginItems {
    fn set(&mut self, update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
        platform::set(update)
    }

    fn get(&mut self, request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
        platform::get(request)
    }
}

#[cfg(test)]
#[path = "login_item_tests.rs"]
mod tests;
