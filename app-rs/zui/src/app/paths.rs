use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

#[path = "paths/access.rs"]
mod access;
#[path = "paths/platform.rs"]
mod platform;

use platform::ApplicationPathEnvironment;

/// Standard application file or directory associated with the current desktop user.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ApplicationPath {
    /// Current user's home directory.
    Home,
    /// Per-user roaming application configuration root.
    AppData,
    /// Executable-adjacent application assets on Windows and Linux.
    Assets,
    /// Product configuration directory below [`Self::AppData`].
    UserData,
    /// Browser/session storage directory, defaulting to [`Self::UserData`].
    SessionData,
    /// Operating-system temporary directory.
    Temporary,
    /// Current executable file.
    Executable,
    /// Runtime module file, synonymous with [`Self::Executable`] for ZUI applications.
    Module,
    /// Current user's desktop directory.
    Desktop,
    /// Current user's documents directory.
    Documents,
    /// Current user's downloads directory.
    Downloads,
    /// Current user's music directory.
    Music,
    /// Current user's pictures directory.
    Pictures,
    /// Current user's videos directory.
    Videos,
    /// Current user's recent-items directory on Windows.
    Recent,
    /// Product log directory, created lazily when first queried.
    Logs,
    /// Product crash-report directory below [`Self::UserData`].
    CrashDumps,
}

impl ApplicationPath {
    /// Returns whether this path name exists on the current target platform.
    pub const fn is_supported(self) -> bool {
        (!matches!(self, Self::Assets) || cfg!(any(target_os = "linux", target_os = "windows")))
            && (!matches!(self, Self::Recent) || cfg!(target_os = "windows"))
    }

    const fn expects_file(self) -> bool {
        matches!(self, Self::Executable | Self::Module)
    }
}

/// Stable category for a standard application-path failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationPathErrorCode {
    /// Executable discovery or application-name validation failed during startup.
    Initialization,
    /// The path name does not exist on the current target platform.
    Unsupported,
    /// The operating system did not provide a location for the requested name.
    Unavailable,
    /// An override was relative, missing, or the wrong file type.
    InvalidOverride,
    /// An application log directory could not be created.
    CreateDirectory,
}

/// Failure to initialize, query, or override one application path.
#[derive(Debug)]
pub struct ApplicationPathError(ApplicationPathErrorKind);

#[derive(Debug)]
enum ApplicationPathErrorKind {
    CurrentExecutable(io::Error),
    InvalidApplicationName(OsString),
    InvalidApplicationVersion {
        value: String,
        source: semver::Error,
    },
    Unsupported(ApplicationPath),
    Unavailable(ApplicationPath),
    InvalidOverride {
        name: Option<ApplicationPath>,
        path: PathBuf,
        source: io::Error,
    },
    CreateDirectory {
        path: PathBuf,
        source: io::Error,
    },
}

impl ApplicationPathError {
    fn current_executable(source: io::Error) -> Self {
        Self(ApplicationPathErrorKind::CurrentExecutable(source))
    }

    fn invalid_application_name(name: OsString) -> Self {
        Self(ApplicationPathErrorKind::InvalidApplicationName(name))
    }

    fn invalid_application_version(value: String, source: semver::Error) -> Self {
        Self(ApplicationPathErrorKind::InvalidApplicationVersion { value, source })
    }

    fn unsupported(name: ApplicationPath) -> Self {
        Self(ApplicationPathErrorKind::Unsupported(name))
    }

    pub(crate) fn unavailable(name: ApplicationPath) -> Self {
        Self(ApplicationPathErrorKind::Unavailable(name))
    }

    fn invalid_override(name: Option<ApplicationPath>, path: PathBuf, source: io::Error) -> Self {
        Self(ApplicationPathErrorKind::InvalidOverride { name, path, source })
    }

    fn create_directory(path: PathBuf, source: io::Error) -> Self {
        Self(ApplicationPathErrorKind::CreateDirectory { path, source })
    }

    /// Returns the backend-independent failure category.
    pub const fn code(&self) -> ApplicationPathErrorCode {
        match &self.0 {
            ApplicationPathErrorKind::CurrentExecutable(_)
            | ApplicationPathErrorKind::InvalidApplicationName(_)
            | ApplicationPathErrorKind::InvalidApplicationVersion { .. } => {
                ApplicationPathErrorCode::Initialization
            }
            ApplicationPathErrorKind::Unsupported(_) => ApplicationPathErrorCode::Unsupported,
            ApplicationPathErrorKind::Unavailable(_) => ApplicationPathErrorCode::Unavailable,
            ApplicationPathErrorKind::InvalidOverride { .. } => {
                ApplicationPathErrorCode::InvalidOverride
            }
            ApplicationPathErrorKind::CreateDirectory { .. } => {
                ApplicationPathErrorCode::CreateDirectory
            }
        }
    }

    /// Returns the path name involved in the failure, when applicable.
    pub const fn path_name(&self) -> Option<ApplicationPath> {
        match &self.0 {
            ApplicationPathErrorKind::Unsupported(name)
            | ApplicationPathErrorKind::Unavailable(name) => Some(*name),
            ApplicationPathErrorKind::InvalidOverride { name, .. } => *name,
            ApplicationPathErrorKind::CreateDirectory { .. } => Some(ApplicationPath::Logs),
            ApplicationPathErrorKind::CurrentExecutable(_)
            | ApplicationPathErrorKind::InvalidApplicationName(_)
            | ApplicationPathErrorKind::InvalidApplicationVersion { .. } => None,
        }
    }
}

impl fmt::Display for ApplicationPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            ApplicationPathErrorKind::CurrentExecutable(source) => {
                write!(
                    formatter,
                    "could not resolve the current executable: {source}"
                )
            }
            ApplicationPathErrorKind::InvalidApplicationName(name) => {
                write!(formatter, "invalid application name {name:?}")
            }
            ApplicationPathErrorKind::InvalidApplicationVersion { value, source } => {
                write!(formatter, "invalid application version {value:?}: {source}")
            }
            ApplicationPathErrorKind::Unsupported(name) => {
                write!(
                    formatter,
                    "application path {name:?} is unsupported on this platform"
                )
            }
            ApplicationPathErrorKind::Unavailable(name) => {
                write!(formatter, "application path {name:?} is unavailable")
            }
            ApplicationPathErrorKind::InvalidOverride { name, path, source } => {
                write!(
                    formatter,
                    "invalid {name:?} path override {path:?}: {source}"
                )
            }
            ApplicationPathErrorKind::CreateDirectory { path, source } => {
                write!(
                    formatter,
                    "could not create application log directory {path:?}: {source}"
                )
            }
        }
    }
}

impl Error for ApplicationPathError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match &self.0 {
            ApplicationPathErrorKind::CurrentExecutable(source)
            | ApplicationPathErrorKind::InvalidOverride { source, .. }
            | ApplicationPathErrorKind::CreateDirectory { source, .. } => Some(source),
            ApplicationPathErrorKind::InvalidApplicationVersion { source, .. } => Some(source),
            ApplicationPathErrorKind::InvalidApplicationName(_)
            | ApplicationPathErrorKind::Unsupported(_)
            | ApplicationPathErrorKind::Unavailable(_) => None,
        }
    }
}

#[derive(Default)]
pub(crate) struct ApplicationPathConfig {
    name: Option<OsString>,
    version: Option<String>,
    application_path: Option<PathBuf>,
    overrides: BTreeMap<ApplicationPath, PathBuf>,
}

impl ApplicationPathConfig {
    fn set_name(&mut self, name: OsString) {
        self.name = Some(name);
    }

    fn set_version(&mut self, version: String) {
        self.version = Some(version);
    }

    fn set_application_path(&mut self, path: PathBuf) {
        self.application_path = Some(path);
    }

    fn set_override(&mut self, name: ApplicationPath, path: PathBuf) {
        self.overrides.insert(name, path);
    }
}

#[derive(Clone)]
pub(crate) struct ApplicationPaths {
    state: Arc<Mutex<ApplicationPathState>>,
}

struct ApplicationPathState {
    name: OsString,
    version: String,
    application_path: PathBuf,
    values: BTreeMap<ApplicationPath, PathBuf>,
    logs_root: Option<PathBuf>,
}

impl ApplicationPaths {
    pub(crate) fn detect(config: ApplicationPathConfig) -> Result<Self, ApplicationPathError> {
        Self::from_environment(config, ApplicationPathEnvironment::detect()?)
    }

    fn from_environment(
        config: ApplicationPathConfig,
        mut environment: ApplicationPathEnvironment,
    ) -> Result<Self, ApplicationPathError> {
        let version = config
            .version
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
        semver::Version::parse(&version).map_err(|source| {
            ApplicationPathError::invalid_application_version(version.clone(), source)
        })?;
        let name = config
            .name
            .or_else(|| {
                environment
                    .values
                    .get(&ApplicationPath::Executable)
                    .and_then(|path| path.file_stem())
                    .map(OsStr::to_os_string)
            })
            .ok_or_else(|| ApplicationPathError::invalid_application_name(OsString::new()))?;
        validate_application_name(&name)?;
        let application_path = match config.application_path {
            Some(path) => {
                validate_location(None, &path, false)?;
                path
            }
            None => environment
                .values
                .get(&ApplicationPath::Executable)
                .and_then(|path| path.parent())
                .map(Path::to_path_buf)
                .ok_or_else(|| ApplicationPathError::unavailable(ApplicationPath::Executable))?,
        };
        for (path_name, path) in &config.overrides {
            if !path_name.is_supported() {
                return Err(ApplicationPathError::unsupported(*path_name));
            }
            validate_location(Some(*path_name), path, path_name.expects_file())?;
        }
        if let Some(app_data) = config.overrides.get(&ApplicationPath::AppData) {
            environment
                .values
                .insert(ApplicationPath::AppData, app_data.clone());
        }
        let user_data = config
            .overrides
            .get(&ApplicationPath::UserData)
            .cloned()
            .or_else(|| {
                environment
                    .values
                    .get(&ApplicationPath::AppData)
                    .map(|path| path.join(&name))
            });
        if let Some(user_data) = user_data.as_ref() {
            environment
                .values
                .insert(ApplicationPath::UserData, user_data.clone());
            environment
                .values
                .entry(ApplicationPath::SessionData)
                .or_insert_with(|| user_data.clone());
            environment
                .values
                .entry(ApplicationPath::CrashDumps)
                .or_insert_with(|| user_data.join("Crashpad"));
        }
        for (path_name, path) in config.overrides {
            environment.values.insert(path_name, path);
        }
        Ok(Self {
            state: Arc::new(Mutex::new(ApplicationPathState {
                name,
                version,
                application_path,
                values: environment.values,
                logs_root: environment.logs_root,
            })),
        })
    }

    fn application_name(&self) -> OsString {
        self.state
            .lock()
            .expect("application path state lock")
            .name
            .clone()
    }

    fn set_application_name(&self, name: OsString) -> Result<(), ApplicationPathError> {
        validate_application_name(&name)?;
        self.state.lock().expect("application path state lock").name = name;
        Ok(())
    }

    fn application_version(&self) -> String {
        self.state
            .lock()
            .expect("application path state lock")
            .version
            .clone()
    }

    fn application_path(&self) -> PathBuf {
        self.state
            .lock()
            .expect("application path state lock")
            .application_path
            .clone()
    }

    fn path(&self, name: ApplicationPath) -> Result<PathBuf, ApplicationPathError> {
        if !name.is_supported() {
            return Err(ApplicationPathError::unsupported(name));
        }
        let mut state = self.state.lock().expect("application path state lock");
        if name == ApplicationPath::Logs && !state.values.contains_key(&name) {
            let path = default_logs_path(&state)?;
            create_log_directory(&path)?;
            state.values.insert(name, path);
        }
        state
            .values
            .get(&name)
            .cloned()
            .ok_or_else(|| ApplicationPathError::unavailable(name))
    }

    fn set_path(&self, name: ApplicationPath, path: PathBuf) -> Result<(), ApplicationPathError> {
        if !name.is_supported() {
            return Err(ApplicationPathError::unsupported(name));
        }
        validate_location(Some(name), &path, name.expects_file())?;
        self.state
            .lock()
            .expect("application path state lock")
            .values
            .insert(name, path);
        Ok(())
    }

    fn set_app_logs_path(&self, path: PathBuf) -> Result<(), ApplicationPathError> {
        validate_absolute(Some(ApplicationPath::Logs), &path)?;
        create_log_directory(&path)?;
        self.state
            .lock()
            .expect("application path state lock")
            .values
            .insert(ApplicationPath::Logs, path);
        Ok(())
    }

    fn set_default_app_logs_path(&self) -> Result<PathBuf, ApplicationPathError> {
        let mut state = self.state.lock().expect("application path state lock");
        let path = default_logs_path(&state)?;
        create_log_directory(&path)?;
        state.values.insert(ApplicationPath::Logs, path.clone());
        Ok(path)
    }
}

fn validate_application_name(name: &OsStr) -> Result<(), ApplicationPathError> {
    let path = Path::new(name);
    let mut components = path.components();
    let single_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    let text = name.to_string_lossy();
    if !single_component || text.contains('/') || text.contains('\\') {
        return Err(ApplicationPathError::invalid_application_name(
            name.to_os_string(),
        ));
    }
    Ok(())
}

fn validate_location(
    name: Option<ApplicationPath>,
    path: &Path,
    expects_file: bool,
) -> Result<(), ApplicationPathError> {
    validate_absolute(name, path)?;
    let metadata = fs::metadata(path).map_err(|source| {
        ApplicationPathError::invalid_override(name, path.to_path_buf(), source)
    })?;
    if (expects_file && !metadata.is_file()) || (!expects_file && !metadata.is_dir()) {
        return Err(ApplicationPathError::invalid_override(
            name,
            path.to_path_buf(),
            io::Error::new(io::ErrorKind::InvalidInput, "path has the wrong file type"),
        ));
    }
    Ok(())
}

fn validate_absolute(
    name: Option<ApplicationPath>,
    path: &Path,
) -> Result<(), ApplicationPathError> {
    if !path.is_absolute() {
        return Err(ApplicationPathError::invalid_override(
            name,
            path.to_path_buf(),
            io::Error::new(io::ErrorKind::InvalidInput, "path must be absolute"),
        ));
    }
    Ok(())
}

fn default_logs_path(state: &ApplicationPathState) -> Result<PathBuf, ApplicationPathError> {
    match state.logs_root.as_ref() {
        Some(root) => Ok(root.join(&state.name)),
        None => state
            .values
            .get(&ApplicationPath::UserData)
            .map(|path| path.join("logs"))
            .ok_or_else(|| ApplicationPathError::unavailable(ApplicationPath::Logs)),
    }
}

fn create_log_directory(path: &Path) -> Result<(), ApplicationPathError> {
    fs::create_dir_all(path)
        .map_err(|source| ApplicationPathError::create_directory(path.to_path_buf(), source))
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
