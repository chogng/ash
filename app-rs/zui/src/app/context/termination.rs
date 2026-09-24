use crate::app::ApplicationError;
use crate::app::ApplicationExitReason;
use crate::app::RelaunchError;
use crate::app::RelaunchOptions;
use crate::window::WindowId;

use super::AppContext;
use super::WindowContext;

impl<'a, T: 'static> AppContext<'a, T> {
    /// Schedules a new instance with the current executable, arguments, and working directory.
    ///
    /// This does not request an exit from the current instance.
    pub fn relaunch(&self) -> Result<(), RelaunchError> {
        self.event_proxy.relaunch()
    }

    /// Schedules a new instance using explicit executable or argument overrides.
    pub fn relaunch_with(&self, options: RelaunchOptions) -> Result<(), RelaunchError> {
        self.event_proxy.relaunch_with(options)
    }

    /// Queues a cancelable close request after the current application callback returns.
    pub fn close_window(&mut self, id: WindowId) -> bool {
        self.windows.contains_key(&id) && self.lifecycle.request_window_close(id)
    }

    /// Queues a normal exit that asks every live window to close through its cancelable callback.
    pub fn exit(&mut self) -> bool {
        self.lifecycle
            .request_exit(ApplicationExitReason::Requested)
    }

    /// Requests immediate teardown without application or window cancellation callbacks.
    ///
    /// The requested process code is preserved in the final [`ApplicationExitReason::Forced`].
    pub fn force_exit(&mut self, exit_code: i32) -> bool {
        self.lifecycle
            .request_exit(ApplicationExitReason::Forced(exit_code))
    }

    /// Records a fatal runtime error and exits the native application.
    pub fn exit_with_error(&mut self, error: ApplicationError) -> bool {
        if self.error.is_none() {
            *self.error = Some(error);
        }
        self.lifecycle
            .request_exit(ApplicationExitReason::FatalError)
    }
}

impl<'a, T: 'static> WindowContext<'a, T> {
    /// Schedules a new instance with the current executable, arguments, and working directory.
    ///
    /// This does not request an exit from the current instance.
    pub fn relaunch(&self) -> Result<(), RelaunchError> {
        self.event_proxy.relaunch()
    }

    /// Schedules a new instance using explicit executable or argument overrides.
    pub fn relaunch_with(&self, options: RelaunchOptions) -> Result<(), RelaunchError> {
        self.event_proxy.relaunch_with(options)
    }

    /// Accepts a close request and destroys this window after the current callback returns.
    pub fn close(&mut self) -> bool {
        self.lifecycle.destroy_window(self.id())
    }

    /// Queues a normal exit that asks every live window to close through its cancelable callback.
    pub fn exit(&mut self) -> bool {
        self.lifecycle
            .request_exit(ApplicationExitReason::Requested)
    }

    /// Requests immediate teardown without application or window cancellation callbacks.
    ///
    /// The requested process code is preserved in the final [`ApplicationExitReason::Forced`].
    pub fn force_exit(&mut self, exit_code: i32) -> bool {
        self.lifecycle
            .request_exit(ApplicationExitReason::Forced(exit_code))
    }

    /// Records a fatal runtime error and exits the complete native application.
    pub fn exit_with_error(&mut self, error: ApplicationError) -> bool {
        if self.error.is_none() {
            *self.error = Some(error);
        }
        self.lifecycle
            .request_exit(ApplicationExitReason::FatalError)
    }
}
