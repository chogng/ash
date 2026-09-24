use crate::internal::ActiveEventLoop;
use crate::window::DisplaySnapshot;

use super::App;
use super::ApplicationHost;

impl<T, A> ApplicationHost<T, A>
where
    T: Send + 'static,
    A: App<T>,
{
    pub(super) fn initialize_display_snapshot(&mut self, event_loop: &ActiveEventLoop) {
        self.display_change_pending.set(false);
        self.display_snapshot = Some(capture_snapshot(event_loop));
    }

    pub(super) fn mark_display_change(&self) {
        self.display_change_pending.set(true);
    }

    pub(super) fn process_display_changes(&mut self, event_loop: &ActiveEventLoop) {
        if !self.display_change_pending.replace(false) {
            return;
        }
        let current = capture_snapshot(event_loop);
        let events = self
            .display_snapshot
            .as_ref()
            .map(|previous| current.changes_since(previous))
            .unwrap_or_default();
        self.display_snapshot = Some(current);
        for event in events {
            self.diagnostics
                .record(crate::devtools::DiagnosticEventKind::DisplayEvent);
            self.with_app_context(event_loop, |app, context| app.display_event(context, event));
            self.process_window_commands(event_loop);
        }
    }
}

fn capture_snapshot(event_loop: &ActiveEventLoop) -> DisplaySnapshot {
    DisplaySnapshot::from_native(
        event_loop.available_monitors(),
        event_loop.primary_monitor(),
        None,
    )
}
