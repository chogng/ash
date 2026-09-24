use std::time::Instant;

use crate::INSPECTOR_RESIZE_HANDLE;
use crate::WorkbenchApplication;
use crate::inspector_resize_snapshot_for_viewport;
use zui::input::ElementState;
use zui::ui::DispatchInvalidation;
use zui::ui::Point;

impl WorkbenchApplication {
    pub(super) fn route_inspector_resize_move(&mut self, point: Point) -> bool {
        if !self.workbench.inspector_is_resizing() {
            return false;
        }
        if self.workbench.resize_inspector(point) {
            self.terminal_view_mut().selection.clear();
            self.rebuild_presentation();
            self.request_redraw();
        }
        self.update_cursor();
        true
    }

    pub(super) fn route_inspector_resize_button(&mut self, state: ElementState) -> bool {
        let now = Instant::now();
        match state {
            ElementState::Pressed => {
                let Some(point) = self.cursor_position else {
                    return false;
                };
                let over_handle = self.presentation.as_ref().is_some_and(|presentation| {
                    presentation.interaction_frame().target_at(point)
                        == Some(INSPECTOR_RESIZE_HANDLE)
                });
                let Some(snapshot) = inspector_resize_snapshot_for_viewport(
                    self.logical_viewport(),
                    self.workbench.tab_container_state(),
                    self.workbench.inspector_state(),
                ) else {
                    return false;
                };
                if !over_handle || !self.workbench.start_inspector_resize(snapshot, point, now) {
                    return false;
                }
            }
            ElementState::Released => {
                let presence = self.sash_pointer_presence(INSPECTOR_RESIZE_HANDLE);
                if !self.workbench.finish_inspector_resize(presence, now) {
                    return false;
                }
            }
        }
        self.rebuild_presentation();
        let hover_changed = self
            .cursor_position
            .zip(self.presentation.as_ref())
            .is_some_and(|(point, presentation)| {
                self.ui_dispatch
                    .pointer_moved(point, presentation.interaction_frame())
                    .invalidation
                    == DispatchInvalidation::Paint
            });
        if hover_changed {
            self.rebuild_presentation();
        }
        self.update_cursor();
        self.request_redraw();
        true
    }

    pub(super) fn cancel_inspector_resize(&mut self) {
        if self.workbench.cancel_inspector_resize() {
            self.rebuild_presentation();
            self.update_cursor();
            self.request_redraw();
        }
    }
}
