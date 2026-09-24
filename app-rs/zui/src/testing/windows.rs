use std::collections::HashSet;

use crate::app::ApplicationExitReason;
use crate::window::LogicalSize;
use crate::window::WindowId;

use super::HeadlessRenderer;
use super::TestEvent;
use super::TestRuntime;
use super::TestTimerScope;
use super::TestWindow;

impl<T> TestRuntime<T> {
    /// Opens one root headless window and emits its lifecycle event.
    pub fn open_window(&mut self, title: impl Into<String>, logical_size: LogicalSize) -> WindowId {
        self.open_test_window(None, false, title.into(), logical_size)
            .expect("root test windows do not require a parent")
    }

    /// Opens a direct child, or returns `None` when `parent` is not live.
    pub fn open_child_window(
        &mut self,
        parent: WindowId,
        title: impl Into<String>,
        logical_size: LogicalSize,
    ) -> Option<WindowId> {
        self.open_test_window(Some(parent), false, title.into(), logical_size)
    }

    /// Opens a modal child and disables its parent, or returns `None` when the parent is not live.
    pub fn open_modal_window(
        &mut self,
        parent: WindowId,
        title: impl Into<String>,
        logical_size: LogicalSize,
    ) -> Option<WindowId> {
        self.open_test_window(Some(parent), true, title.into(), logical_size)
    }

    fn open_test_window(
        &mut self,
        parent: Option<WindowId>,
        modal: bool,
        title: String,
        logical_size: LogicalSize,
    ) -> Option<WindowId> {
        if let Some(parent) = parent
            && !self.windows.contains_key(&parent.into_raw())
        {
            return None;
        }
        let raw = self.next_window;
        self.next_window += 1;
        let id = WindowId::from_raw(raw);
        if modal
            && let Some(parent) = parent
            && let Some(parent) = self.windows.get_mut(&parent.into_raw())
        {
            parent.input_enabled = false;
        }
        self.windows.insert(
            raw,
            TestWindow {
                id,
                title,
                logical_size,
                renderer: HeadlessRenderer::default(),
                accessibility: Vec::new(),
                parent,
                modal,
                input_enabled: true,
            },
        );
        self.lifecycle.record_window_opened(id);
        self.process_lifecycle_commands();
        Some(id)
    }

    /// Returns one live headless window.
    pub fn window(&self, id: WindowId) -> Option<&TestWindow> {
        self.windows.get(&id.into_raw())
    }

    /// Returns a live window's direct parent.
    pub fn parent_window(&self, id: WindowId) -> Option<&TestWindow> {
        let parent = self.window(id)?.parent_id()?;
        self.window(parent)
    }

    /// Returns direct live children in stable identity order.
    pub fn child_windows(&self, parent: WindowId) -> Vec<&TestWindow> {
        self.windows
            .values()
            .filter(|window| window.parent_id() == Some(parent))
            .collect()
    }

    /// Requests a redraw for a live window.
    pub fn request_redraw(&mut self, id: WindowId) -> bool {
        if self.windows.contains_key(&id.into_raw()) {
            self.events.push_back(TestEvent::RedrawRequested(id));
            true
        } else {
            false
        }
    }

    /// Emits a cancelable close request for one live window.
    pub fn request_window_close(&mut self, id: WindowId) -> bool {
        if !self.windows.contains_key(&id.into_raw()) {
            return false;
        }
        let queued = self.lifecycle.request_window_close(id);
        self.process_lifecycle_commands();
        queued
    }

    /// Accepts a close request and closes all descendants in child-first order.
    pub fn close_window(&mut self, id: WindowId) -> bool {
        if !self.windows.contains_key(&id.into_raw()) {
            return false;
        }
        let queued = self.lifecycle.destroy_window(id);
        self.process_lifecycle_commands();
        queued
    }

    pub(super) fn window_close_order(&self, root: WindowId) -> Vec<WindowId> {
        let mut visited = HashSet::new();
        let mut order = Vec::new();
        collect_window_close_order(self, root, &mut visited, &mut order);
        order
    }

    pub(super) fn all_window_close_order(&self) -> Vec<WindowId> {
        let roots = self
            .windows
            .values()
            .filter(|window| {
                window
                    .parent_id()
                    .is_none_or(|parent| self.window(parent).is_none())
            })
            .map(TestWindow::id)
            .collect::<Vec<_>>();
        let remaining = self
            .windows
            .values()
            .map(TestWindow::id)
            .collect::<Vec<_>>();
        let mut visited = HashSet::new();
        let mut order = Vec::new();
        for root in roots.into_iter().chain(remaining) {
            collect_window_close_order(self, root, &mut visited, &mut order);
        }
        order
    }

    pub(super) fn close_test_window(&mut self, window: WindowId, notify_all_closed: bool) {
        let Some(closed) = self.windows.remove(&window.into_raw()) else {
            return;
        };
        self.window_close_decisions.remove(&window.into_raw());
        if closed.modal
            && let Some(parent) = closed.parent
            && !self
                .windows
                .values()
                .any(|window| window.modal && window.parent == Some(parent))
            && let Some(parent) = self.windows.get_mut(&parent.into_raw())
        {
            parent.input_enabled = true;
        }
        self.timers
            .retain(|_, timer| timer.scope != TestTimerScope::Window(window));
        self.lifecycle.record_window_closed(window);
        self.events.push_back(TestEvent::WindowClosed(window));
        if notify_all_closed && !self.lifecycle.has_product_windows() {
            self.events.push_back(TestEvent::WindowAllClosed);
            if self.lifecycle.should_exit_after_last_window() {
                self.lifecycle
                    .request_exit(ApplicationExitReason::LastWindowClosed);
            }
        }
    }
}

fn collect_window_close_order<T>(
    runtime: &TestRuntime<T>,
    window: WindowId,
    visited: &mut HashSet<WindowId>,
    order: &mut Vec<WindowId>,
) {
    if !visited.insert(window) || runtime.window(window).is_none() {
        return;
    }
    let children = runtime
        .child_windows(window)
        .into_iter()
        .map(TestWindow::id)
        .collect::<Vec<_>>();
    for child in children {
        collect_window_close_order(runtime, child, visited, order);
    }
    order.push(window);
}
