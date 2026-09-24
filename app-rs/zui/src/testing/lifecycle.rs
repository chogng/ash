use crate::app::ApplicationExitDecision;
use crate::app::ApplicationExitReason;
use crate::app::WindowCommand;
use crate::window::WindowId;

use super::TestEvent;
use super::TestRuntime;
use super::TestWindowCloseDecision;

impl<T> TestRuntime<T> {
    /// Requests a normal application exit and processes every deterministic cancellation point.
    ///
    /// Accepted exits request child-first closure of every live window, suppress
    /// [`TestEvent::WindowAllClosed`], cancel pending timers, and emit [`TestEvent::Exiting`].
    pub fn exit(&mut self) -> bool {
        let queued = self
            .lifecycle
            .request_exit(ApplicationExitReason::Requested);
        self.process_lifecycle_commands();
        queued
    }

    /// Requests immediate deterministic teardown without cancelable callbacks or window events.
    pub fn force_exit(&mut self, exit_code: i32) -> bool {
        let queued = self
            .lifecycle
            .request_exit(ApplicationExitReason::Forced(exit_code));
        self.process_lifecycle_commands();
        queued
    }

    /// Selects the decision used for the next cancelable exit request.
    ///
    /// The decision resets to [`ApplicationExitDecision::Exit`] after one request. Fatal and
    /// platform exits ignore it because the native runtime cannot offer a cancellation point.
    pub fn decide_next_exit(&mut self, decision: ApplicationExitDecision) {
        self.next_exit_decision = decision;
    }

    /// Selects the decision used after all windows close in the next normal exit attempt.
    ///
    /// This models [`crate::app::App::will_exit`] and resets to
    /// [`ApplicationExitDecision::Exit`] after the callback point is reached.
    pub fn decide_next_will_exit(&mut self, decision: ApplicationExitDecision) {
        self.next_will_exit_decision = decision;
    }

    /// Selects how one live window handles its next application-exit close request.
    ///
    /// Unconfigured windows accept the request. A decision is consumed only when the exit
    /// lifecycle reaches `window`; ordinary [`Self::request_window_close`] remains explicitly
    /// accepted through [`Self::close_window`]. Returns `false` when `window` is not live.
    pub fn decide_next_window_close(
        &mut self,
        window: WindowId,
        decision: TestWindowCloseDecision,
    ) -> bool {
        if self.window(window).is_none() {
            return false;
        }
        self.window_close_decisions
            .insert(window.into_raw(), decision);
        true
    }

    pub(super) fn process_lifecycle_commands(&mut self) {
        while let Some(command) = self.lifecycle.next_command() {
            match command {
                WindowCommand::Opened(window) => {
                    self.events.push_back(TestEvent::WindowOpened(window));
                }
                WindowCommand::RequestClose(window) => {
                    if self.window(window).is_some() {
                        self.events
                            .push_back(TestEvent::WindowCloseRequested(window));
                    }
                }
                WindowCommand::Destroy(window) => {
                    for window in self.window_close_order(window) {
                        self.close_test_window(window, true);
                    }
                }
                WindowCommand::Exit(reason) => self.process_exit_request(reason),
            }
        }
    }

    fn process_exit_request(&mut self, reason: ApplicationExitReason) {
        let decision = if reason.is_cancelable() {
            self.events.push_back(TestEvent::ExitRequested(reason));
            std::mem::take(&mut self.next_exit_decision)
        } else {
            ApplicationExitDecision::Exit
        };
        if decision == ApplicationExitDecision::Cancel {
            self.cancel_exit_request(reason);
            return;
        }
        if reason.is_cancelable() && !self.close_windows_for_exit() {
            self.cancel_exit_request(reason);
            return;
        }
        let decision = if reason.is_cancelable() {
            self.events.push_back(TestEvent::WillExitRequested(reason));
            std::mem::take(&mut self.next_will_exit_decision)
        } else {
            ApplicationExitDecision::Exit
        };
        if decision == ApplicationExitDecision::Cancel {
            self.cancel_exit_request(reason);
            return;
        }
        if self
            .lifecycle
            .resolve_exit(reason, ApplicationExitDecision::Exit)
        {
            self.timers.clear();
            self.events.push_back(TestEvent::Exiting(reason));
        }
    }

    fn cancel_exit_request(&mut self, reason: ApplicationExitReason) {
        self.lifecycle
            .resolve_exit(reason, ApplicationExitDecision::Cancel);
        self.events.push_back(TestEvent::ExitCancelled(reason));
    }

    fn close_windows_for_exit(&mut self) -> bool {
        for window in self.all_window_close_order() {
            if self.window(window).is_none() {
                continue;
            }
            self.events
                .push_back(TestEvent::WindowCloseRequested(window));
            let decision = self
                .window_close_decisions
                .remove(&window.into_raw())
                .unwrap_or_default();
            if decision == TestWindowCloseDecision::Cancel {
                return false;
            }
            self.close_test_window(window, false);
        }
        !self.lifecycle.has_product_windows()
    }
}
