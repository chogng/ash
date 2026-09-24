use super::presentation::with_shell_presentation_model;
use super::*;

impl WorkbenchApplication {
    pub(super) fn rebuild_presentation(&mut self) {
        self.memory
            .update_counters(self.retained_runtime.fragment_registry().len());
        let viewport = self.logical_viewport();
        let active_screen = self.active_screen();
        let tab_container = self.workbench.tab_container_state();
        let inspector = self.workbench.inspector_state();
        let terminal_size =
            terminal_grid_size_for_viewport(viewport, active_screen, tab_container, inspector);
        self.resize_terminal_panes(viewport, active_screen, terminal_size);
        let scroll_limit = self.terminal_scroll_limit();
        self.terminal_view_mut().scroll.clamp(scroll_limit);
        let window_control_insets = self
            .window
            .as_ref()
            .map(WindowHandle::window_control_insets)
            .unwrap_or(WindowControlInsets::NONE);
        let inspector_sash_state = self.workbench.inspector_sash_state();
        let mut presentation = with_shell_presentation_model(
            self,
            window_control_insets,
            |model, text_layout, animation_bindings| {
                build_workbench_presentation_with_animation_bindings(
                    viewport,
                    model,
                    text_layout,
                    inspector_sash_state,
                    animation_bindings,
                )
            },
        );
        let requested_focus = self.pending_focus.take();
        let preferred_focus = requested_focus.unwrap_or_else(|| {
            if self.main_surface.is_editor() {
                FILE_EDITOR_DOCUMENT
            } else {
                COMPOSER
            }
        });
        let focus_outcome = if requested_focus.is_some() {
            self.ui_dispatch
                .focus_element(presentation.interaction_frame(), preferred_focus)
        } else {
            self.ui_dispatch
                .reconcile_focus(presentation.interaction_frame(), preferred_focus)
        };
        if focus_outcome.invalidation != DispatchInvalidation::None {
            let inspector_sash_state = self.workbench.inspector_sash_state();
            presentation = with_shell_presentation_model(
                self,
                window_control_insets,
                |model, text_layout, animation_bindings| {
                    build_workbench_presentation_with_animation_bindings(
                        viewport,
                        model,
                        text_layout,
                        inspector_sash_state,
                        animation_bindings,
                    )
                },
            );
        }
        let pointer_requires_rebuild = self.cursor_position.is_some_and(|point| {
            let outcome = self
                .ui_dispatch
                .pointer_moved(point, presentation.interaction_frame());
            let sash_changed = self.sync_sash_pointer_presence(Instant::now());
            outcome.invalidation != DispatchInvalidation::None || sash_changed
        });
        if pointer_requires_rebuild {
            let inspector_sash_state = self.workbench.inspector_sash_state();
            presentation = with_shell_presentation_model(
                self,
                window_control_insets,
                |model, text_layout, animation_bindings| {
                    build_workbench_presentation_with_animation_bindings(
                        viewport,
                        model,
                        text_layout,
                        inspector_sash_state,
                        animation_bindings,
                    )
                },
            );
        }
        self.presentation = Some(presentation);
        self.frame_scheduler.clear();
        if requested_focus.is_some() {
            self.sync_input_focus();
        }
        self.update_ime_cursor_area();
    }

    pub(super) fn resize_terminal_panes(
        &mut self,
        viewport: LogicalViewport,
        active_screen: ScreenBuffer,
        fallback_size: GridSize,
    ) {
        let sidebar_part = self.workbench.workbench().sidebar_part();
        let Some(tab_key) = sidebar_part
            .active_tab_key()
            .filter(|key| key.is_session())
            .cloned()
            .or_else(|| {
                sidebar_part
                    .selected_session()
                    .cloned()
                    .map(TabInputKey::session)
            })
        else {
            self.terminal_runtime.resize_all(fallback_size);
            return;
        };
        let Some(layout) = self.workbench.workbench().pane_part(&tab_key) else {
            self.terminal_runtime.resize_all(fallback_size);
            return;
        };
        let panes = terminal_pane_bounds_for_viewport(
            viewport,
            active_screen,
            self.workbench.tab_container_state(),
            self.workbench.inspector_state(),
            layout,
        );
        if panes.is_empty() {
            self.terminal_runtime.resize_all(fallback_size);
            return;
        }
        let resize_requests = panes
            .into_iter()
            .filter_map(|(pane, bounds)| {
                self.workbench
                    .mount(&tab_key, pane)
                    .and_then(|mount| mount.binding().terminal_key())
                    .map(|key| (key, terminal_grid_size_for_bounds(bounds)))
            })
            .collect::<Vec<_>>();
        for (key, size) in resize_requests {
            self.terminal_runtime.resize_key(key, size);
        }
    }

    pub(super) fn rebuild_overlay_presentation(&mut self) {
        let viewport = self.logical_viewport();
        let window_control_insets = self
            .window
            .as_ref()
            .map(WindowHandle::window_control_insets)
            .unwrap_or(WindowControlInsets::NONE);
        let Some(mut presentation) = self.presentation.take() else {
            self.rebuild_presentation();
            return;
        };
        let rebuilt = with_shell_presentation_model(
            self,
            window_control_insets,
            |model, text_layout, _animation_bindings| {
                rebuild_workbench_overlays(&mut presentation, viewport, model, text_layout)
            },
        );
        if !rebuilt {
            self.presentation = Some(presentation);
            self.rebuild_presentation();
            return;
        }
        self.presentation = Some(presentation);
        self.frame_scheduler.clear();
        self.update_ime_cursor_area();
    }

    pub(super) fn rebuild_presentation_on_next_redraw(&mut self) {
        if self.frame_scheduler.request(FrameInvalidation::Rebuild) == FrameSchedule::RequestFrame {
            self.request_redraw();
        }
    }

    pub(super) fn rebuild_overlay_on_next_redraw(&mut self) {
        if self.frame_scheduler.request(FrameInvalidation::Fragment) == FrameSchedule::RequestFrame
        {
            self.request_redraw();
        }
    }
}
