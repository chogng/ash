use std::fmt;

/// A reusable Remote connection profile.
///
/// Profiles describe the remote target and the executable that must host the App Server. They
/// intentionally do not contain SSH credentials: the client host process keeps those in its
/// platform SSH agent, configuration, or keychain integration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteProfile {
    target: SshTarget,
    runtime: RemoteRuntime,
}

impl RemoteProfile {
    /// Combines one SSH target with the runtime selected by product packaging or installation.
    pub fn new(target: SshTarget, runtime: RemoteRuntime) -> Self {
        Self { target, runtime }
    }

    /// Returns the remote SSH target.
    pub const fn target(&self) -> &SshTarget {
        &self.target
    }

    /// Returns the remote runtime selected for this profile.
    pub const fn runtime(&self) -> &RemoteRuntime {
        &self.runtime
    }
}

/// An OpenSSH target and its authoritative Directory root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshTarget {
    host: SshHost,
    dir: RemoteDirPath,
}

impl SshTarget {
    /// Creates a target from a validated OpenSSH host alias and an absolute Directory path.
    pub fn new(host: SshHost, dir: RemoteDirPath) -> Self {
        Self { host, dir }
    }

    /// Returns the host alias passed to the local OpenSSH client.
    pub const fn host(&self) -> &SshHost {
        &self.host
    }

    /// Returns the remote Directory root supplied to the App Server.
    pub const fn dir(&self) -> &RemoteDirPath {
        &self.dir
    }
}

/// A validated OpenSSH configuration host alias.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshHost(String);

impl SshHost {
    /// Parses a bounded OpenSSH host alias and canonicalizes its ASCII identity to lowercase.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, RemoteAddressError> {
        let value = value.as_ref().trim();
        if value.is_empty()
            || value.len() > 253
            || !value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !value
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(RemoteAddressError::InvalidSshHost);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    /// Returns the canonical host alias passed to OpenSSH and used for profile identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The remote path syntax, independent of the operating system of the client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemotePathStyle {
    Posix,
    Windows,
}

/// A canonical absolute Directory path owned by one Remote host.
/// Windows drive and UNC paths use forward slashes; POSIX backslashes stay literal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteDirPath(String);

impl RemoteDirPath {
    /// Parses a canonical POSIX, Windows drive, or UNC Directory path.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, RemoteAddressError> {
        let value = value.as_ref();
        if value.chars().any(char::is_control) {
            return Err(RemoteAddressError::InvalidDirPath);
        }
        if is_windows_path(value) {
            return canonical_windows_path(value)
                .map(Self)
                .ok_or(RemoteAddressError::InvalidDirPath);
        }
        let value = value.trim();
        if value.is_empty() || !value.starts_with('/') {
            return Err(RemoteAddressError::InvalidDirPath);
        }
        if value != "/"
            && (value.ends_with('/')
                || value
                    .split('/')
                    .skip(1)
                    .any(|segment| segment.is_empty() || matches!(segment, "." | "..")))
        {
            return Err(RemoteAddressError::InvalidDirPath);
        }
        Ok(Self(value.to_owned()))
    }

    /// Returns the path passed to the remote runtime as `ASH_WORKSPACE_ROOT`.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Selects the shell/path contract without consulting the client filesystem.
    pub fn style(&self) -> RemotePathStyle {
        if is_windows_path(&self.0) {
            RemotePathStyle::Windows
        } else {
            RemotePathStyle::Posix
        }
    }

    /// Whether the path identifies a filesystem root rather than an entry below it.
    pub fn is_root(&self) -> bool {
        self.0.ends_with('/') || (self.0.starts_with("//") && self.0[2..].split('/').count() == 2)
    }
}

pub(crate) fn is_windows_path(value: &str) -> bool {
    (value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && value.as_bytes().get(1) == Some(&b':'))
        || value.starts_with("//")
        || value.starts_with("\\\\")
}

fn canonical_windows_path(value: &str) -> Option<String> {
    let mut path = value.replace('\\', "/");
    let drive = path.as_bytes().get(1) == Some(&b':');
    let rest = if drive {
        if path.as_bytes().get(2) != Some(&b'/') {
            return None;
        }
        path.replace_range(..1, &path[..1].to_ascii_uppercase());
        &path[3..]
    } else {
        let rest = path.strip_prefix("//")?;
        if rest.split('/').count() < 2 {
            return None;
        }
        rest
    };
    if !(drive && rest.is_empty()) && !rest.split('/').all(valid_windows_component) {
        return None;
    }
    Some(path)
}

// Reject aliases that Windows rewrites, devices, ADS and extended/device namespaces.
// Otherwise an apparently distinct immutable object could address an existing file.
fn valid_windows_component(component: &str) -> bool {
    if component.is_empty()
        || component.ends_with(['.', ' '])
        || component
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return false;
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

/// The executable installed on the Remote host that can launch an App Server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntime(String);

impl RemoteRuntime {
    /// Creates a runtime reference selected by the installer or a compatible existing CLI.
    pub fn new(executable: impl AsRef<str>) -> Result<Self, RemoteAddressError> {
        let executable = executable.as_ref().trim();
        if executable.is_empty()
            || executable.contains('\0')
            || executable.contains('\n')
            || executable.contains('\r')
        {
            return Err(RemoteAddressError::InvalidRuntime);
        }
        Ok(Self(executable.to_owned()))
    }

    /// Creates an exact canonical absolute executable selected after Remote resolution.
    pub fn new_exact_executable(executable: impl AsRef<str>) -> Result<Self, RemoteAddressError> {
        let path =
            RemoteDirPath::parse(executable).map_err(|_| RemoteAddressError::InvalidRuntime)?;
        if path.is_root() {
            return Err(RemoteAddressError::InvalidRuntime);
        }
        Ok(Self(path.0))
    }

    /// Returns the remote executable path or command name.
    pub fn executable(&self) -> &str {
        &self.0
    }
}

/// The reason a Remote address or runtime reference cannot enter a connection profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteAddressError {
    InvalidSshHost,
    InvalidDirPath,
    InvalidRuntime,
}

impl fmt::Display for RemoteAddressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSshHost => formatter.write_str("Remote SSH host is invalid"),
            Self::InvalidDirPath => {
                formatter.write_str("Remote Directory path must be canonical and absolute")
            }
            Self::InvalidRuntime => formatter.write_str("Remote runtime executable is invalid"),
        }
    }
}

impl std::error::Error for RemoteAddressError {}
