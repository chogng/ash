use std::error::Error;
use std::fmt;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

use crate::internal::NativeEventLoopClosed;
use crate::internal::NativeEventProxy;

#[cfg(target_os = "macos")]
use super::ApplicationActivation;
use super::ApplicationExitReason;
use super::ApplicationLocales;
use super::ApplicationPaths;
use super::ApplicationRelauncher;
use super::GlobalShortcutEvent;
use super::MenuItemId;
use super::OpenWindowFuture;
use super::OpenWindowRequest;
use super::ProtocolUrl;
use super::RelaunchError;
use super::RelaunchOptions;
use super::SecondInstance;
use super::TrayEvent;
use crate::runtime::timer::ScheduledTimer;
use crate::runtime::timer::TimerId;
use crate::window::WindowCloseMode;
use crate::window::WindowCloseRequester;
use crate::window::WindowId;
use crate::window::WindowOptions;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApplicationControlCommand {
    Exit(ApplicationExitReason),
    RequestWindowClose(WindowId),
    DestroyWindow(WindowId),
}

pub(crate) enum RuntimeEvent<T: 'static> {
    Product(T),
    Control(ApplicationControlCommand),
    OpenWindow(OpenWindowRequest),
    ScheduleTimer(ScheduledTimer<T>),
    CancelTimer(TimerId),
    MenuAction(MenuItemId),
    Tray(TrayEvent),
    GlobalShortcut(GlobalShortcutEvent),
    SecondInstance(SecondInstance),
    #[cfg(target_os = "macos")]
    Activated(ApplicationActivation),
    #[cfg(target_os = "macos")]
    OpenFile(PathBuf),
    OpenUrl(ProtocolUrl),
    Accessibility(accesskit_platform::Event),
    DevToolsWake,
}

impl<T: 'static> From<accesskit_platform::Event> for RuntimeEvent<T> {
    fn from(event: accesskit_platform::Event) -> Self {
        Self::Accessibility(event)
    }
}

/// Cloneable cross-thread capability for delivering application-defined events.
pub struct AppProxy<T: 'static> {
    pub(crate) inner: NativeEventProxy<RuntimeEvent<T>>,
    relauncher: ApplicationRelauncher,
    pub(crate) application_locales: ApplicationLocales,
    pub(crate) application_paths: ApplicationPaths,
}

impl<T: 'static> Clone for AppProxy<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            relauncher: self.relauncher.clone(),
            application_locales: self.application_locales.clone(),
            application_paths: self.application_paths.clone(),
        }
    }
}

impl<T: 'static> fmt::Debug for AppProxy<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AppProxy { .. }")
    }
}

impl<T: 'static> AppProxy<T> {
    pub(crate) const fn new(
        inner: NativeEventProxy<RuntimeEvent<T>>,
        relauncher: ApplicationRelauncher,
        application_locales: ApplicationLocales,
        application_paths: ApplicationPaths,
    ) -> Self {
        Self {
            inner,
            relauncher,
            application_locales,
            application_paths,
        }
    }

    /// Sends `event` to the application's main-thread event loop.
    pub fn send_event(&self, event: T) -> Result<(), AppDisconnected<T>> {
        self.inner
            .send_event(RuntimeEvent::Product(event))
            .map_err(|error| match error {
                NativeEventLoopClosed(RuntimeEvent::Product(event)) => AppDisconnected(event),
                NativeEventLoopClosed(
                    RuntimeEvent::Control(_)
                    | RuntimeEvent::OpenWindow(_)
                    | RuntimeEvent::ScheduleTimer(_)
                    | RuntimeEvent::CancelTimer(_)
                    | RuntimeEvent::MenuAction(_)
                    | RuntimeEvent::Tray(_)
                    | RuntimeEvent::GlobalShortcut(_)
                    | RuntimeEvent::SecondInstance(_)
                    | RuntimeEvent::OpenUrl(_)
                    | RuntimeEvent::Accessibility(_)
                    | RuntimeEvent::DevToolsWake,
                ) => unreachable!("product event delivery must retain the product event"),
                #[cfg(target_os = "macos")]
                NativeEventLoopClosed(RuntimeEvent::Activated(_) | RuntimeEvent::OpenFile(_)) => {
                    unreachable!("product event delivery cannot fail with a macOS lifecycle event")
                }
            })
    }

    /// Forwards an application URL to the main-thread lifecycle handler.
    pub fn send_open_url(&self, url: ProtocolUrl) -> Result<(), AppDisconnected<ProtocolUrl>> {
        self.inner
            .send_event(RuntimeEvent::OpenUrl(url))
            .map_err(|error| match error {
                NativeEventLoopClosed(RuntimeEvent::OpenUrl(url)) => AppDisconnected(url),
                NativeEventLoopClosed(
                    RuntimeEvent::Product(_)
                    | RuntimeEvent::Control(_)
                    | RuntimeEvent::OpenWindow(_)
                    | RuntimeEvent::ScheduleTimer(_)
                    | RuntimeEvent::CancelTimer(_)
                    | RuntimeEvent::MenuAction(_)
                    | RuntimeEvent::Tray(_)
                    | RuntimeEvent::GlobalShortcut(_)
                    | RuntimeEvent::SecondInstance(_)
                    | RuntimeEvent::Accessibility(_)
                    | RuntimeEvent::DevToolsWake,
                ) => unreachable!("application URL delivery must retain the URL"),
                #[cfg(target_os = "macos")]
                NativeEventLoopClosed(RuntimeEvent::Activated(_) | RuntimeEvent::OpenFile(_)) => {
                    unreachable!(
                        "application URL delivery cannot fail with a macOS lifecycle event"
                    )
                }
            })
    }

    /// Requests a normal, window-close-cancelable application exit from any thread.
    ///
    /// Success confirms delivery to the event-loop queue, not completion of application teardown.
    pub fn exit(&self) -> Result<(), AppDisconnected<ApplicationExitReason>> {
        self.request_exit(ApplicationExitReason::Requested)
    }

    /// Requests immediate application teardown from any thread.
    ///
    /// This skips every cancelable exit and window-close callback. The requested process code is
    /// preserved in [`ApplicationExitReason::Forced`] for the binary entry point to return.
    pub fn force_exit(&self, exit_code: i32) -> Result<(), AppDisconnected<ApplicationExitReason>> {
        self.request_exit(ApplicationExitReason::Forced(exit_code))
    }

    /// Schedules one new instance with the current executable, arguments, and working directory.
    ///
    /// Scheduling does not exit this instance. The new process starts only after the native event
    /// loop ends and any single-instance ownership has been released.
    pub fn relaunch(&self) -> Result<(), RelaunchError> {
        self.relaunch_with(RelaunchOptions::new())
    }

    /// Schedules one new instance using explicit executable or argument overrides.
    ///
    /// Each successful call retains a distinct request. Scheduling does not exit this instance.
    pub fn relaunch_with(&self, options: RelaunchOptions) -> Result<(), RelaunchError> {
        self.relauncher.schedule(options)
    }

    /// Requests a cancelable window-close callback from any thread.
    ///
    /// Success confirms command delivery; it does not imply that `window` was still live.
    pub fn close_window(&self, window: WindowId) -> Result<(), AppDisconnected<WindowId>> {
        self.request_window_close(window)
    }

    /// Destroys a runtime-owned window from any thread without a cancelable close callback.
    ///
    /// Success confirms command delivery; it does not imply that `window` was still live.
    pub fn destroy_window(&self, window: WindowId) -> Result<(), AppDisconnected<WindowId>> {
        self.request_window_destroy(window)
    }

    /// Opens a runtime-owned window through the main event loop from any thread.
    ///
    /// The future resolves after the runtime registry and [`super::App::window_opened`] callback
    /// have observed the window. Dropping it does not cancel an already delivered request.
    pub fn open_window(&self, options: WindowOptions) -> OpenWindowFuture
    where
        T: Send,
    {
        let (request, future) = OpenWindowRequest::new(options);
        self.request_window_open(request);
        future
    }

    pub(crate) fn request_exit(
        &self,
        reason: ApplicationExitReason,
    ) -> Result<(), AppDisconnected<ApplicationExitReason>> {
        self.inner
            .send_event(RuntimeEvent::Control(ApplicationControlCommand::Exit(
                reason,
            )))
            .map_err(|error| match error {
                NativeEventLoopClosed(RuntimeEvent::Control(ApplicationControlCommand::Exit(
                    reason,
                ))) => AppDisconnected(reason),
                NativeEventLoopClosed(_) => {
                    unreachable!("application exit delivery must retain the exit reason")
                }
            })
    }

    pub(crate) fn request_window_close(
        &self,
        window: WindowId,
    ) -> Result<(), AppDisconnected<WindowId>> {
        self.inner
            .send_event(RuntimeEvent::Control(
                ApplicationControlCommand::RequestWindowClose(window),
            ))
            .map_err(|error| match error {
                NativeEventLoopClosed(RuntimeEvent::Control(
                    ApplicationControlCommand::RequestWindowClose(window),
                )) => AppDisconnected(window),
                NativeEventLoopClosed(_) => {
                    unreachable!("window-close delivery must retain the window identity")
                }
            })
    }

    pub(crate) fn request_window_destroy(
        &self,
        window: WindowId,
    ) -> Result<(), AppDisconnected<WindowId>> {
        self.inner
            .send_event(RuntimeEvent::Control(
                ApplicationControlCommand::DestroyWindow(window),
            ))
            .map_err(|error| match error {
                NativeEventLoopClosed(RuntimeEvent::Control(
                    ApplicationControlCommand::DestroyWindow(window),
                )) => AppDisconnected(window),
                NativeEventLoopClosed(_) => {
                    unreachable!("window-destroy delivery must retain the window identity")
                }
            })
    }

    pub(crate) fn request_window_open(&self, request: OpenWindowRequest) {
        let _ = self.inner.send_event(RuntimeEvent::OpenWindow(request));
    }

    pub(crate) fn window_close_requester(&self) -> WindowCloseRequester
    where
        T: Send,
    {
        let proxy = self.inner.clone();
        WindowCloseRequester::new(move |window, mode| {
            let command = match mode {
                WindowCloseMode::Request => ApplicationControlCommand::RequestWindowClose(window),
                WindowCloseMode::Destroy => ApplicationControlCommand::DestroyWindow(window),
            };
            proxy.send_event(RuntimeEvent::Control(command)).is_ok()
        })
    }
}

#[cfg(test)]
#[path = "runtime_event_tests.rs"]
mod tests;

/// Failed event delivery after the owning application loop has exited.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct AppDisconnected<T>(pub T);

impl<T> fmt::Display for AppDisconnected<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("cannot deliver an event to an application that has exited")
    }
}

impl<T: fmt::Debug> Error for AppDisconnected<T> {}
