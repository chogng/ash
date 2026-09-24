use std::collections::HashSet;
use std::collections::VecDeque;

use crate::window::WindowId;

use super::ApplicationReadiness;
use super::ApplicationReadyFuture;

/// Policy controlling whether an application exits automatically after closing its last window.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ExitPolicy {
    /// Exit after the final live window has completed its close lifecycle.
    #[default]
    OnLastWindowClosed,
    /// Keep the event loop alive until the application explicitly exits.
    Explicit,
}

/// Current reusable application-host lifecycle phase.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ApplicationPhase {
    /// The event loop has been created but has not delivered its first resume.
    #[default]
    Initializing,
    /// Native application resources may be created and windows may receive events.
    Active,
    /// The platform temporarily suspended active window work.
    Suspended,
    /// The event loop is releasing application resources.
    Exiting,
}

/// Operating-system request to reactivate an application that is already running.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApplicationActivation {
    has_visible_windows: bool,
}

impl ApplicationActivation {
    /// Creates an activation event with the platform's visible-window observation.
    pub const fn new(has_visible_windows: bool) -> Self {
        Self {
            has_visible_windows,
        }
    }

    /// Returns whether the platform observed at least one visible application window.
    pub const fn has_visible_windows(self) -> bool {
        self.has_visible_windows
    }
}

/// Stable reason recorded when an application begins exiting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationExitReason {
    /// Product code explicitly requested a normal exit.
    Requested,
    /// The configured policy exited after the final product window closed.
    LastWindowClosed,
    /// Product code requested immediate teardown with the preserved process exit code.
    Forced(i32),
    /// Product or runtime work recorded a fatal [`super::ApplicationError`].
    FatalError,
    /// The platform event loop ended without an earlier ZUI exit request.
    Platform,
}

impl ApplicationExitReason {
    /// Returns whether product code may cancel this exit before teardown begins.
    pub const fn is_cancelable(self) -> bool {
        matches!(self, Self::Requested | Self::LastWindowClosed)
    }

    /// Returns the process exit code supplied by an immediate exit request.
    pub const fn forced_exit_code(self) -> Option<i32> {
        match self {
            Self::Forced(code) => Some(code),
            _ => None,
        }
    }

    const fn priority(self) -> u8 {
        match self {
            Self::Requested | Self::LastWindowClosed => 0,
            Self::Forced(_) => 1,
            Self::FatalError | Self::Platform => 2,
        }
    }
}

/// Product decision returned while a normal application exit is still cancelable.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ApplicationExitDecision {
    /// Continue application teardown.
    #[default]
    Exit,
    /// Keep the application event loop alive.
    Cancel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WindowCommand {
    Opened(WindowId),
    RequestClose(WindowId),
    Destroy(WindowId),
    Exit(ApplicationExitReason),
}

#[derive(Default)]
struct WindowCommandQueue {
    commands: VecDeque<WindowCommand>,
    pending_close_requests: HashSet<WindowId>,
    pending_destroys: HashSet<WindowId>,
    pending_exit: Option<ApplicationExitReason>,
}

impl WindowCommandQueue {
    fn opened(&mut self, window: WindowId) {
        self.commands.push_back(WindowCommand::Opened(window));
    }

    fn request_close(&mut self, window: WindowId) -> bool {
        if self.pending_destroys.contains(&window) || !self.pending_close_requests.insert(window) {
            return false;
        }
        self.commands.push_back(WindowCommand::RequestClose(window));
        true
    }

    fn destroy(&mut self, window: WindowId) -> bool {
        if !self.pending_destroys.insert(window) {
            return false;
        }
        if self.pending_close_requests.remove(&window) {
            self.commands.retain(
                |command| !matches!(command, WindowCommand::RequestClose(id) if *id == window),
            );
        }
        self.commands.push_back(WindowCommand::Destroy(window));
        true
    }

    fn exit(&mut self, reason: ApplicationExitReason) -> bool {
        if let Some(pending) = self.pending_exit {
            if reason.priority() > pending.priority() {
                let queued_exit = self
                    .commands
                    .iter_mut()
                    .find(|command| matches!(command, WindowCommand::Exit(_)));
                if let Some(command) = queued_exit {
                    *command = WindowCommand::Exit(reason);
                } else {
                    self.commands.push_front(WindowCommand::Exit(reason));
                }
                self.pending_exit = Some(reason);
            }
            return false;
        }
        self.pending_exit = Some(reason);
        self.commands.push_back(WindowCommand::Exit(reason));
        true
    }

    fn pop(&mut self) -> Option<WindowCommand> {
        let command = self.commands.pop_front()?;
        match command {
            WindowCommand::RequestClose(window) => {
                self.pending_close_requests.remove(&window);
            }
            WindowCommand::Destroy(window) => {
                self.pending_destroys.remove(&window);
            }
            WindowCommand::Exit(_) => {}
            WindowCommand::Opened(_) => {}
        }
        Some(command)
    }

    fn take_destroy(&mut self, window: WindowId) -> bool {
        if !self.pending_destroys.remove(&window) {
            return false;
        }
        self.commands
            .retain(|command| !matches!(command, WindowCommand::Destroy(id) if *id == window));
        true
    }

    fn pending_exit(&self) -> Option<ApplicationExitReason> {
        self.pending_exit
    }

    fn finish_exit(&mut self, reason: ApplicationExitReason) {
        if self.pending_exit == Some(reason) {
            self.pending_exit = None;
        }
    }
}

/// Shared lifecycle state used by the native host and deterministic test runtime.
pub(crate) struct LifecycleCore {
    phase: ApplicationPhase,
    readiness: ApplicationReadiness,
    exit_policy: ExitPolicy,
    exit_reason: Option<ApplicationExitReason>,
    product_windows: HashSet<WindowId>,
    commands: WindowCommandQueue,
}

impl LifecycleCore {
    pub(crate) fn new(exit_policy: ExitPolicy, readiness: ApplicationReadiness) -> Self {
        Self {
            phase: ApplicationPhase::Initializing,
            readiness,
            exit_policy,
            exit_reason: None,
            product_windows: HashSet::new(),
            commands: WindowCommandQueue::default(),
        }
    }

    pub(crate) const fn phase(&self) -> ApplicationPhase {
        self.phase
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.readiness.is_ready()
    }

    pub(crate) fn when_ready(&self) -> ApplicationReadyFuture {
        self.readiness.future()
    }

    pub(crate) fn mark_ready(&mut self) {
        self.readiness.mark_ready();
    }

    pub(crate) fn set_exit_policy(&mut self, exit_policy: ExitPolicy) {
        self.exit_policy = exit_policy;
    }

    /// Enters the active phase and returns whether this was the first resume.
    pub(crate) fn resumed(&mut self) -> bool {
        let first = self.phase == ApplicationPhase::Initializing;
        self.phase = ApplicationPhase::Active;
        first
    }

    pub(crate) fn suspended(&mut self) {
        self.phase = ApplicationPhase::Suspended;
    }

    pub(crate) fn record_window_opened(&mut self, window: WindowId) -> bool {
        if !self.product_windows.insert(window) {
            return false;
        }
        self.commands.opened(window);
        true
    }

    pub(crate) fn request_window_close(&mut self, window: WindowId) -> bool {
        self.commands.request_close(window)
    }

    pub(crate) fn destroy_window(&mut self, window: WindowId) -> bool {
        self.commands.destroy(window)
    }

    pub(crate) fn take_window_destroy(&mut self, window: WindowId) -> bool {
        self.commands.take_destroy(window)
    }

    pub(crate) fn record_window_closed(&mut self, window: WindowId) -> bool {
        self.product_windows.remove(&window)
    }

    pub(crate) fn has_product_windows(&self) -> bool {
        !self.product_windows.is_empty()
    }

    pub(crate) fn should_exit_after_last_window(&self) -> bool {
        !self.has_product_windows() && self.exit_policy == ExitPolicy::OnLastWindowClosed
    }

    pub(crate) fn request_exit(&mut self, reason: ApplicationExitReason) -> bool {
        self.commands.exit(reason)
    }

    pub(crate) fn pending_exit(&self) -> Option<ApplicationExitReason> {
        self.commands.pending_exit()
    }

    pub(crate) fn next_command(&mut self) -> Option<WindowCommand> {
        self.commands.pop()
    }

    pub(crate) fn begin_exit(&mut self, reason: ApplicationExitReason) {
        if self.exit_reason.is_none() {
            self.exit_reason = Some(reason);
        }
        self.readiness.mark_exited();
        self.phase = ApplicationPhase::Exiting;
    }

    pub(crate) fn resolve_exit(
        &mut self,
        reason: ApplicationExitReason,
        decision: ApplicationExitDecision,
    ) -> bool {
        let superseded = self
            .commands
            .pending_exit()
            .is_some_and(|pending| pending != reason);
        if superseded {
            return false;
        }
        self.commands.finish_exit(reason);
        if reason.is_cancelable() && decision == ApplicationExitDecision::Cancel {
            return false;
        }
        self.begin_exit(reason);
        true
    }

    pub(crate) fn ensure_platform_exit(&mut self) {
        let reason = self.exit_reason.unwrap_or(ApplicationExitReason::Platform);
        self.begin_exit(reason);
    }

    pub(crate) const fn exit_reason(&self) -> Option<ApplicationExitReason> {
        self.exit_reason
    }
}

impl Drop for LifecycleCore {
    fn drop(&mut self) {
        self.readiness.mark_exited();
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
