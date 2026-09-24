use std::error::Error;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use futures::channel::oneshot;

use super::ApplicationError;
use crate::window::OpenedWindow;
use crate::window::WindowOptions;

/// Owned asynchronous result of a main-thread native window creation request.
pub type OpenWindowFuture =
    Pin<Box<dyn Future<Output = Result<OpenedWindow, OpenWindowError>> + Send + 'static>>;

/// Stable category for an asynchronous native window creation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenWindowErrorCode {
    /// The application event loop exited before returning a result.
    Disconnected,
    /// Native window configuration, creation, service attachment, or renderer setup failed.
    Creation,
}

/// Failure returned by [`super::ApplicationHandle::open_window`] or
/// [`super::AppProxy::open_window`].
#[derive(Debug)]
pub struct OpenWindowError {
    kind: OpenWindowErrorKind,
}

#[derive(Debug)]
enum OpenWindowErrorKind {
    Disconnected,
    Creation(ApplicationError),
}

impl OpenWindowError {
    fn disconnected() -> Self {
        Self {
            kind: OpenWindowErrorKind::Disconnected,
        }
    }

    fn creation(error: ApplicationError) -> Self {
        Self {
            kind: OpenWindowErrorKind::Creation(error),
        }
    }

    /// Returns the backend-independent failure category.
    pub const fn code(&self) -> OpenWindowErrorCode {
        match &self.kind {
            OpenWindowErrorKind::Disconnected => OpenWindowErrorCode::Disconnected,
            OpenWindowErrorKind::Creation(_) => OpenWindowErrorCode::Creation,
        }
    }

    /// Returns the runtime creation failure when the request reached the main thread.
    pub const fn creation_error(&self) -> Option<&ApplicationError> {
        match &self.kind {
            OpenWindowErrorKind::Creation(error) => Some(error),
            OpenWindowErrorKind::Disconnected => None,
        }
    }
}

impl fmt::Display for OpenWindowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            OpenWindowErrorKind::Disconnected => {
                formatter.write_str("application event loop exited before opening the window")
            }
            OpenWindowErrorKind::Creation(error) => error.fmt(formatter),
        }
    }
}

impl Error for OpenWindowError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.creation_error().map(|error| error as _)
    }
}

pub(crate) struct OpenWindowRequest {
    options: WindowOptions,
    response: oneshot::Sender<Result<OpenedWindow, ApplicationError>>,
}

impl OpenWindowRequest {
    pub(crate) fn new(options: WindowOptions) -> (Self, OpenWindowFuture) {
        let (response, result) = oneshot::channel();
        let future = Box::pin(async move {
            match result.await {
                Ok(Ok(opened)) => Ok(opened),
                Ok(Err(error)) => Err(OpenWindowError::creation(error)),
                Err(_) => Err(OpenWindowError::disconnected()),
            }
        });
        (Self { options, response }, future)
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        WindowOptions,
        oneshot::Sender<Result<OpenedWindow, ApplicationError>>,
    ) {
        (self.options, self.response)
    }
}

#[cfg(test)]
#[path = "window_request_tests.rs"]
mod tests;
