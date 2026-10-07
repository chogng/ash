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

/// An OpenSSH target and its authoritative POSIX Directory root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshTarget {
    host: SshHost,
    dir: RemoteDirPath,
}

impl SshTarget {
    /// Creates a target from a validated OpenSSH host alias and an absolute POSIX Directory path.
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

/// A canonical absolute POSIX Directory path owned by one Remote host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteDirPath(String);

impl RemoteDirPath {
    /// Parses an absolute canonical POSIX Directory path.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, RemoteAddressError> {
        let value = value.as_ref().trim();
        if value.is_empty() || !value.starts_with('/') || value.contains('\0') {
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

    /// Creates an exact canonical absolute POSIX executable selected after Remote resolution.
    pub fn new_exact_executable(executable: impl AsRef<str>) -> Result<Self, RemoteAddressError> {
        let executable = executable.as_ref().trim();
        if executable == "/"
            || !executable.starts_with('/')
            || executable.ends_with('/')
            || executable.contains('\0')
            || executable.contains('\n')
            || executable.contains('\r')
            || executable
                .split('/')
                .skip(1)
                .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        {
            return Err(RemoteAddressError::InvalidRuntime);
        }
        Ok(Self(executable.to_owned()))
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
