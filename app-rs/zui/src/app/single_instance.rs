use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;

use super::ApplicationExit;

pub(crate) mod transport;
mod wire;

/// Validated application identity used to coordinate one primary process per desktop user.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SingleInstanceKey(String);

impl SingleInstanceKey {
    /// Creates a stable key such as `com.example.product`.
    pub fn new(value: impl Into<String>) -> Result<Self, SingleInstanceKeyError> {
        let value = value.into().to_ascii_lowercase();
        let mut characters = value.chars();
        if value.len() > 128
            || !characters
                .next()
                .is_some_and(|first| first.is_ascii_alphanumeric())
            || !characters.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
        {
            return Err(SingleInstanceKeyError);
        }
        Ok(Self(value))
    }

    /// Returns the normalized lowercase identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Invalid application identity supplied to the single-instance coordinator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SingleInstanceKeyError;

impl fmt::Display for SingleInstanceKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "single-instance key must contain at most 128 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit",
        )
    }
}

impl Error for SingleInstanceKeyError {}

/// Configuration for acquiring a process-wide primary application instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SingleInstanceOptions {
    key: SingleInstanceKey,
    additional_data: Vec<u8>,
}

impl SingleInstanceOptions {
    /// Creates options for one validated application identity.
    pub const fn new(key: SingleInstanceKey) -> Self {
        Self {
            key,
            additional_data: Vec::new(),
        }
    }

    /// Attaches opaque product data to a secondary process invocation.
    pub fn with_additional_data(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.additional_data = data.into();
        self
    }

    /// Returns the identity shared by all invocations of this application.
    pub const fn key(&self) -> &SingleInstanceKey {
        &self.key
    }

    /// Returns the opaque data forwarded when this process is a secondary instance.
    pub fn additional_data(&self) -> &[u8] {
        &self.additional_data
    }
}

/// Invocation details forwarded from a secondary process to the primary application instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecondInstance {
    arguments: Vec<OsString>,
    working_directory: PathBuf,
    additional_data: Vec<u8>,
}

impl SecondInstance {
    /// Creates deterministic invocation details for tests or custom process adapters.
    pub fn new<I, S>(arguments: I, working_directory: impl Into<PathBuf>) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self {
            arguments: arguments.into_iter().map(Into::into).collect(),
            working_directory: working_directory.into(),
            additional_data: Vec::new(),
        }
    }

    /// Attaches the opaque product data supplied by the secondary invocation.
    pub fn with_additional_data(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.additional_data = data.into();
        self
    }

    /// Returns the complete secondary argument vector, including its executable at index zero.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the secondary process working directory captured at startup.
    pub fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    /// Returns opaque product data supplied through [`SingleInstanceOptions`].
    pub fn additional_data(&self) -> &[u8] {
        &self.additional_data
    }

    /// Consumes the invocation and returns its arguments, working directory, and additional data.
    pub fn into_parts(self) -> (Vec<OsString>, PathBuf, Vec<u8>) {
        (self.arguments, self.working_directory, self.additional_data)
    }
}

/// Result of running an application with single-instance coordination enabled.
pub enum SingleInstanceRun<A> {
    /// This process became primary and completed its native application event loop.
    Primary(ApplicationExit<A>),
    /// An existing primary acknowledged this process invocation.
    Forwarded,
}

impl<A> SingleInstanceRun<A> {
    /// Returns whether this process became the primary application instance.
    pub const fn is_primary(&self) -> bool {
        matches!(self, Self::Primary(_))
    }

    /// Returns whether this invocation was forwarded without constructing product state.
    pub const fn is_forwarded(&self) -> bool {
        matches!(self, Self::Forwarded)
    }

    /// Returns the primary event-loop exit report, if this process became primary.
    pub const fn primary_exit(&self) -> Option<&ApplicationExit<A>> {
        match self {
            Self::Primary(exit) => Some(exit),
            Self::Forwarded => None,
        }
    }

    /// Consumes the outcome and returns the primary event-loop exit report, if present.
    pub fn into_primary_exit(self) -> Option<ApplicationExit<A>> {
        match self {
            Self::Primary(exit) => Some(exit),
            Self::Forwarded => None,
        }
    }
}

#[cfg(test)]
#[path = "single_instance_tests.rs"]
mod tests;
