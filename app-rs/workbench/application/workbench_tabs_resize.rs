use std::time::Instant;

use crate::TAB_CONTAINER_RESIZE_HANDLE;
use crate::WorkbenchApplication;
use zui::input::ElementState;
use zui::ui::DispatchInvalidation;
use zui::ui::Point;

impl WorkbenchApplication {
    pub(super) fn route_tab_container_resize_move(&mut self, point: Point) -> bool {
        if !self.workbench.tab_container_is_resizing() {
            return false;
        }
        if self.workbench.resize_tab_container(point) {
            self.terminal_view_mut().selection.clear();
            self.rebuild_presentation();
            self.request_redraw();
        }
        self.update_cursor();
        true
    }

    pub(super) fn route_tab_container_resize_button(&mut self, state: ElementState) -> bool {
        let now = Instant::now();
        match state {
            ElementState::Pressed => {
                let Some(point) = self.cursor_position else {
                    return false;
                };
                let over_handle = self.presentation.as_ref().is_some_and(|presentation| {
                    presentation.interaction_frame().target_at(point)
                        == Some(TAB_CONTAINER_RESIZE_HANDLE)
                });
                if !over_handle
                    || !self.workbench.start_tab_container_resize(
                        self.logical_viewport().width,
                        point,
                        now,
                    )
                {
                    return false;
                }
            }
            ElementState::Released => {
                let presence = self.sash_pointer_presence(TAB_CONTAINER_RESIZE_HANDLE);
                if !self.workbench.finish_tab_container_resize(presence, now) {
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

    pub(super) fn cancel_tab_container_resize(&mut self) {
        if self.workbench.cancel_tab_container_resize() {
            self.rebuild_presentation();
            self.update_cursor();
            self.request_redraw();
        }
    }
}
