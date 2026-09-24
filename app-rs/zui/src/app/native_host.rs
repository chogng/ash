#[cfg(target_os = "windows")]
use std::cell::Cell;
use std::error::Error;
use std::fmt;
#[cfg(target_os = "windows")]
use std::rc::Rc;
use std::time::Instant;

use winit::application::ApplicationHandler;
use winit::event_loop::EventLoop;

use super::ApplicationPathError;

/// Native event-loop integrations selected by application-owned platform services.
#[derive(Default)]
pub(crate) struct NativeEventLoopOptions {
    #[cfg(target_os = "windows")]
    menu_accelerator_table: Option<Rc<Cell<isize>>>,
    #[cfg(target_os = "windows")]
    display_change_pending: Option<Rc<Cell<bool>>>,
}

impl NativeEventLoopOptions {
    #[cfg(target_os = "windows")]
    pub(crate) fn with_menu_accelerator_table(mut self, table: Option<Rc<Cell<isize>>>) -> Self {
        self.menu_accelerator_table = table;
        self
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn with_display_change_pending(mut self, pending: Rc<Cell<bool>>) -> Self {
        self.display_change_pending = Some(pending);
        self
    }
}

/// Policy controlling when the application event loop wakes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlFlow {
    Poll,
    Wait,
    WaitUntil(Instant),
}

impl ControlFlow {
    pub(crate) const fn into_native(self) -> winit::event_loop::ControlFlow {
        match self {
            Self::Poll => winit::event_loop::ControlFlow::Poll,
            Self::Wait => winit::event_loop::ControlFlow::Wait,
            Self::WaitUntil(deadline) => winit::event_loop::ControlFlow::WaitUntil(deadline),
        }
    }
}

/// Internal cross-thread capability used by the application runtime.
pub(crate) struct NativeEventProxy<T: 'static> {
    inner: winit::event_loop::EventLoopProxy<T>,
}

impl<T: 'static> Clone for NativeEventProxy<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T: 'static> fmt::Debug for NativeEventProxy<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeEventProxy { .. }")
    }
}

impl<T: 'static> NativeEventProxy<T> {
    pub(crate) const fn from_native(inner: winit::event_loop::EventLoopProxy<T>) -> Self {
        Self { inner }
    }

    /// Sends `event` to the application's main-thread event loop.
    pub(crate) fn send_event(&self, event: T) -> Result<(), NativeEventLoopClosed<T>> {
        self.inner
            .send_event(event)
            .map_err(|error| NativeEventLoopClosed(error.0))
    }

    pub(crate) fn native(&self) -> winit::event_loop::EventLoopProxy<T> {
        self.inner.clone()
    }
}

pub(crate) struct NativeEventLoopClosed<T>(pub(crate) T);

/// Failure to initialize or run the reusable native application host.
#[derive(Debug)]
pub struct ApplicationRunError(ApplicationRunErrorKind);

/// Stable category for a failure that prevents the native application host from running.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationRunErrorCode {
    /// The native event loop could not be created or stopped with a platform failure.
    EventLoop,
    /// The application-wide background worker pool could not be initialized.
    BackgroundExecutor,
    /// Single-instance coordination or secondary invocation delivery failed.
    SingleInstance,
    /// A scheduled application instance could not be launched after the event loop stopped.
    Relaunch,
    /// Application identity or standard path initialization failed before startup.
    ApplicationPaths,
}

#[derive(Debug)]
enum ApplicationRunErrorKind {
    EventLoop(winit::error::EventLoopError),
    BackgroundExecutor(std::io::Error),
    SingleInstance(std::io::Error),
    Relaunch(std::io::Error),
    ApplicationPaths(ApplicationPathError),
}

impl ApplicationRunError {
    pub(crate) fn background_executor(source: std::io::Error) -> Self {
        Self(ApplicationRunErrorKind::BackgroundExecutor(source))
    }

    pub(crate) fn single_instance(source: std::io::Error) -> Self {
        Self(ApplicationRunErrorKind::SingleInstance(source))
    }

    pub(crate) fn relaunch(source: std::io::Error) -> Self {
        Self(ApplicationRunErrorKind::Relaunch(source))
    }

    pub(crate) fn paths(source: ApplicationPathError) -> Self {
        Self(ApplicationRunErrorKind::ApplicationPaths(source))
    }

    fn event_loop(source: winit::error::EventLoopError) -> Self {
        Self(ApplicationRunErrorKind::EventLoop(source))
    }

    /// Returns the backend-independent startup or runtime failure category.
    pub const fn code(&self) -> ApplicationRunErrorCode {
        match &self.0 {
            ApplicationRunErrorKind::EventLoop(_) => ApplicationRunErrorCode::EventLoop,
            ApplicationRunErrorKind::BackgroundExecutor(_) => {
                ApplicationRunErrorCode::BackgroundExecutor
            }
            ApplicationRunErrorKind::SingleInstance(_) => ApplicationRunErrorCode::SingleInstance,
            ApplicationRunErrorKind::Relaunch(_) => ApplicationRunErrorCode::Relaunch,
            ApplicationRunErrorKind::ApplicationPaths(_) => {
                ApplicationRunErrorCode::ApplicationPaths
            }
        }
    }
}

impl fmt::Display for ApplicationRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            ApplicationRunErrorKind::EventLoop(source) => source.fmt(formatter),
            ApplicationRunErrorKind::BackgroundExecutor(source) => {
                write!(
                    formatter,
                    "background executor initialization failed: {source}"
                )
            }
            ApplicationRunErrorKind::SingleInstance(source) => {
                write!(formatter, "single-instance coordination failed: {source}")
            }
            ApplicationRunErrorKind::Relaunch(source) => {
                write!(formatter, "application relaunch failed: {source}")
            }
            ApplicationRunErrorKind::ApplicationPaths(source) => {
                write!(
                    formatter,
                    "application path initialization failed: {source}"
                )
            }
        }
    }
}

impl Error for ApplicationRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match &self.0 {
            ApplicationRunErrorKind::EventLoop(source) => Some(source),
            ApplicationRunErrorKind::BackgroundExecutor(source) => Some(source),
            ApplicationRunErrorKind::SingleInstance(source) => Some(source),
            ApplicationRunErrorKind::Relaunch(source) => Some(source),
            ApplicationRunErrorKind::ApplicationPaths(source) => Some(source),
        }
    }
}

/// Creates a typed platform event loop and constructs a handler with its wakeup proxy.
///
/// The caller owns the user-event type. Returning the handler lets an application runtime inspect
/// its termination state after the event loop exits.
pub fn run_application_with_user_events<T, A, F>(
    options: NativeEventLoopOptions,
    create_application: F,
) -> Result<A, ApplicationRunError>
where
    T: 'static,
    A: ApplicationHandler<T>,
    F: FnOnce(NativeEventProxy<T>) -> A,
{
    let mut builder = EventLoop::<T>::with_user_event();
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::EventLoopBuilderExtWindows;

        let table = options.menu_accelerator_table;
        let display_change_pending = options.display_change_pending;
        if table.is_some() || display_change_pending.is_some() {
            builder.with_msg_hook(move |message| {
                if let Some(pending) = display_change_pending.as_ref()
                    && crate::window::is_display_change_message(message)
                {
                    pending.set(true);
                }
                table.as_ref().is_some_and(|table| {
                    crate::services::translate_menu_accelerator(table, message)
                })
            });
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = options;
    let event_loop = builder.build().map_err(ApplicationRunError::event_loop)?;
    let proxy = NativeEventProxy::from_native(event_loop.create_proxy());
    let mut application = create_application(proxy);
    event_loop
        .run_app(&mut application)
        .map_err(ApplicationRunError::event_loop)?;
    Ok(application)
}

#[cfg(test)]
#[path = "native_host_tests.rs"]
mod tests;
