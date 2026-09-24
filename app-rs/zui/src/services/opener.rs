use std::error::Error;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use super::SystemServiceError;
use super::blocking::BlockingServiceExecutor;

/// Owned asynchronous result of an operating-system opener request.
pub type OpenerFuture =
    Pin<Box<dyn Future<Output = Result<(), SystemServiceError>> + Send + 'static>>;

/// Validated external URL passed to the operating system's registered handler.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ExternalUrl(String);

impl ExternalUrl {
    /// Parses and validates an absolute external URL.
    pub fn parse(value: impl Into<String>) -> Result<Self, ExternalUrlError> {
        let value = value.into();
        url::Url::parse(&value).map_err(ExternalUrlError)?;
        Ok(Self(value))
    }

    /// Returns the validated URL string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Failure to parse an external URL.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExternalUrlError(url::ParseError);

impl fmt::Display for ExternalUrlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid external URL: {}", self.0)
    }
}

impl Error for ExternalUrlError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.0)
    }
}

/// File-system path or validated URL selected for external opening.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OpenTarget {
    Path(PathBuf),
    Url(ExternalUrl),
}

impl OpenTarget {
    fn value(&self) -> &std::ffi::OsStr {
        match self {
            Self::Path(path) => path.as_os_str(),
            Self::Url(url) => std::ffi::OsStr::new(url.as_str()),
        }
    }
}

/// Operating-system opener backend used through an injectable [`OpenerHandle`].
pub trait OpenerService: Send + Sync {
    /// Opens one path or URL with its registered operating-system handler.
    fn open(&self, target: OpenTarget) -> Result<(), SystemServiceError>;
}

/// Cloneable capability for opening paths and validated external URLs.
#[derive(Clone)]
pub struct OpenerHandle {
    service: Arc<dyn OpenerService>,
    executor: BlockingServiceExecutor,
}

impl OpenerHandle {
    pub(crate) fn new(service: impl OpenerService + 'static) -> Self {
        Self {
            service: Arc::new(service),
            executor: BlockingServiceExecutor,
        }
    }

    /// Opens one target without blocking the calling thread.
    pub fn open(&self, target: OpenTarget) -> OpenerFuture {
        let service = Arc::clone(&self.service);
        self.executor.spawn("opener", move || service.open(target))
    }
}

/// Default operating-system opener backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemOpener;

impl OpenerService for SystemOpener {
    fn open(&self, target: OpenTarget) -> Result<(), SystemServiceError> {
        open::that(target.value()).map_err(|source| SystemServiceError::backend("opener", source))
    }
}
