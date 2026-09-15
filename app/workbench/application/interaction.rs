use super::*;

impl WorkbenchApplication {
    pub(super) fn logical_pointer_position(&self, physical_x: f64, physical_y: f64) -> Point {
        let scale_factor = if self.scale_factor.is_finite() && self.scale_factor > 0.0 {
            self.scale_factor as f32
        } else {
            1.0
        };
        Point::new(
            physical_x as f32 / scale_factor,
            physical_y as f32 / scale_factor,
        )
    }

    pub(super) fn request_redraw(&self) {
        if let Some(window) = self.window.as_ref() {
            let _ = window.request_redraw();
        }
    }

    pub(super) fn update_cursor(&self) {
        let feedback = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .pointer_feedback(presentation.interaction_frame())
            })
            .unwrap_or_default();
        let cursor = if let Some(orientation) = self.workbench.pane_resize_orientation() {
            match orientation {
                SashOrientation::Vertical => CursorIcon::ColResize,
                SashOrientation::Horizontal => CursorIcon::RowResize,
            }
        } else if self.workbench.tab_container_is_resizing()
            || self.workbench.inspector_is_resizing()
        {
            CursorIcon::ColResize
        } else {
            match feedback {
                CursorFeedback::Default => CursorIcon::Default,
                CursorFeedback::Text => CursorIcon::Text,
                CursorFeedback::Pointer => CursorIcon::Pointer,
                CursorFeedback::ResizeHorizontal => CursorIcon::ColResize,
                CursorFeedback::ResizeVertical => CursorIcon::RowResize,
            }
        };
        if let Some(window) = self.window.as_ref() {
            let _ = window.set_cursor(cursor);
        }
    }

    pub(super) fn sash_pointer_presence(&self, id: ElementId) -> HoverPresence {
        let Some(point) = self.cursor_position else {
            return HoverPresence::Outside;
        };
        let over = self.ui_dispatch.window_active()
            && self.presentation.as_ref().is_some_and(|presentation| {
                presentation.interaction_frame().target_at(point) == Some(id)
            });
        if over {
            HoverPresence::Over
        } else {
            HoverPresence::Outside
        }
    }

    pub(super) fn sync_sash_pointer_presence(&mut self, now: Instant) -> bool {
        let window_active = self.ui_dispatch.window_active();
        let session_hovered = window_active
            && self
                .ui_dispatch
                .is_hovered(crate::TAB_CONTAINER_RESIZE_HANDLE);
        let agent_hovered =
            window_active && self.ui_dispatch.is_hovered(crate::INSPECTOR_RESIZE_HANDLE);
        let session_presence = if session_hovered {
            HoverPresence::Over
        } else {
            HoverPresence::Outside
        };
        let agent_presence = if agent_hovered {
            HoverPresence::Over
        } else {
            HoverPresence::Outside
        };
        let session_changed = self
            .workbench
            .tab_sash_pointer_presence(session_presence, now);
        let agent_changed = self
            .workbench
            .inspector_sash_pointer_presence(agent_presence, now);
        session_changed || agent_changed
    }

    pub(super) fn apply_dispatch_outcome(&mut self, outcome: DispatchOutcome) {
        let sash_changed = self.sync_sash_pointer_presence(Instant::now());
        let activation = matches!(outcome.intent, Some(UiIntent::Activate(_)));
        if let Some(intent) = outcome.intent {
            match intent {
                UiIntent::StartWindowDrag(_) => {
                    if let Some(window) = self.window.as_ref()
                        && let Err(error) = window.start_window_drag()
                    {
                        eprintln!("could not begin desktop window drag: {error}");
                    }
                }
                UiIntent::Activate(id) => self.activate_shell_element(id),
            }
        }
        match outcome.invalidation {
            DispatchInvalidation::None => {}
            DispatchInvalidation::Paint => {
                self.sync_input_focus();
                self.rebuild_presentation_on_next_redraw();
            }
            DispatchInvalidation::Fragment => {
                self.sync_input_focus();
                if activation || outcome.fragment.is_some() {
                    self.rebuild_presentation_on_next_redraw();
                } else {
                    self.rebuild_overlay_on_next_redraw();
                }
            }
        }
        if sash_changed {
            self.rebuild_presentation_on_next_redraw();
        }
    }

    pub(super) fn activate_shell_element(&mut self, id: zui::ui::ElementId) {
        if self.activate_quick_access_element(id) {
            return;
        }
        if self.activate_settings_element(id) {
            return;
        }
        if self.activate_file_editor_element(id) {
            return;
        }
        let interaction_item_count = self
            .session_pane
            .composer_interaction_view()
            .map(|view| view.items().len())
            .unwrap_or(0);
        if let Some(index) =
            ash_session::interaction::composer_interaction_item_index(id, 0..interaction_item_count)
        {
            self.activate_composer_interaction_item(index);
            return;
        }
        if let Some(action) = self.files.activate(id) {
            match action {
                FilesAction::OpenFile { path } => self.open_file(path),
                FilesAction::LoadChildren { element, path } => {
                    self.load_file_tree_directory(element, path);
                }
                FilesAction::Handled | FilesAction::StateChanged | FilesAction::Focus(_) => {}
            }
            return;
        }
        if self.scm.editor_mut().toggle_fold_for_element(id) {
            return;
        }
        if self.activate_scm_element(id) {
            return;
        }
        if self.activate_remote_connection_manager_element(id) {
            return;
        }
        if self.activate_memory_element(id) {
            return;
        }
        if self.activate_remote_tunnel_manager_element(id) {
            return;
        }
        if self.activate_remote_connection_picker_element(id) {
            return;
        }
        if self.activate_git_branch_picker_element(id) {
            return;
        }
        if self.activate_directory_picker_element(id) {
            return;
        }
        if self.activate_tab_context_menu_element(id) {
            return;
        }
        if id == crate::TITLEBAR_SETTINGS_BUTTON {
            self.activate_settings_tab();
            return;
        }
        if let Some(intent) =
            crate::sidebar_intent_for_element(self.workbench.workbench().sidebar_part(), id)
        {
            match intent {
                crate::SidebarIntent::SetMode(mode) => {
                    if self.workbench.set_sidebar_mode(mode) {
                        self.rebuild_presentation();
                        self.request_redraw();
                    }
                }
                crate::SidebarIntent::ToggleGroup(group) => {
                    if self.workbench.toggle_sidebar_group(group) {
                        self.rebuild_presentation();
                        self.request_redraw();
                    }
                }
                crate::SidebarIntent::Activate(TabInputKey::Settings) => {
                    self.activate_settings_tab();
                }
                crate::SidebarIntent::Activate(tab @ TabInputKey::Session(_)) => {
                    if self.workbench.activate_tab(tab.clone()) {
                        self.mount_session_pane(&tab);
                    }
                }
                crate::SidebarIntent::Rename(tab) => {
                    if let Some(bounds) = self
                        .presentation
                        .as_ref()
                        .and_then(|presentation| presentation.element_bounds(id))
                    {
                        let _ = self.open_tab_rename(tab, bounds);
                    }
                }
                crate::SidebarIntent::OpenActions(tab) => {
                    if let Some(bounds) = self
                        .presentation
                        .as_ref()
                        .and_then(|presentation| presentation.element_bounds(id))
                    {
                        let point = Point::new(bounds.origin.x, bounds.bottom());
                        let _ = self.open_tab_context_menu(tab, point);
                    }
                }
                crate::SidebarIntent::Close(tab) => {
                    let _ = self.close_workbench_tab(&tab);
                }
            }
            return;
        }
        if let Some(command) = crate::command_for_element(id) {
            self.dispatch_command(command);
        }
    }

    fn activate_quick_access_element(&mut self, id: ElementId) -> bool {
        if !self.quick_access.shortcuts_open() {
            return false;
        }
        if id == ash_settings::KEYBOARD_SHORTCUTS_CLOSE {
            self.quick_access.close();
            self.settings.reset_keyboard_shortcut_recording();
        } else if let Some(command) = self.quick_access.shortcut_command(id) {
            self.settings.start_keyboard_shortcut_recording(command);
        } else {
            return false;
        }
        self.rebuild_presentation();
        self.request_redraw();
        true
    }

    fn activate_settings_element(&mut self, id: ElementId) -> bool {
        if !self.workbench.workbench().sidebar_part().is_settings() {
            return false;
        }
        match self.settings.activate(id) {
            ash_settings::SettingsActivation::Ignored => false,
            ash_settings::SettingsActivation::Changed => {
                if self.settings.section() != ash_settings::SettingsPageSection::Remote
                    && self.remote_connection_manager.is_settings()
                {
                    self.dismiss_remote_connection_manager();
                    return true;
                }
                self.rebuild_presentation();
                self.request_redraw();
                true
            }
            ash_settings::SettingsActivation::OpenRemote => self.open_remote_connection_settings(),
            ash_settings::SettingsActivation::Close => {
                self.close_settings_tab();
                true
            }
        }
    }

    pub(super) fn pointer_moved(&mut self, physical_x: f64, physical_y: f64) {
        let point = self.logical_pointer_position(physical_x, physical_y);
        self.cursor_position = Some(point);
        if self.route_remote_connection_manager_pointer_move(point) {
            return;
        }
        if self.memories.state.open {
            if let Some(presentation) = &self.presentation {
                let outcome = self
                    .ui_dispatch
                    .pointer_moved(point, presentation.interaction_frame());
                self.apply_dispatch_outcome(outcome);
            }
            self.update_cursor();
            return;
        }
        if self.route_remote_tunnel_manager_pointer_move(point) {
            return;
        }
        if self.route_remote_connection_picker_pointer_move(point) {
            return;
        }
        if self.route_git_branch_picker_pointer_move(point) {
            return;
        }
        if self.route_directory_picker_pointer_move(point) {
            return;
        }
        if self.route_tab_context_menu_pointer_move(point) {
            return;
        }
        if self.route_tab_container_scrollbar_move(point) {
            return;
        }
        if self.route_tab_container_resize_move(point) {
            return;
        }
        if self.route_inspector_resize_move(point) {
            return;
        }
        if self.route_terminal_pane_resize_move(point) {
            return;
        }
        if self.route_file_editor_pointer_move() {
            return;
        }
        if self.route_multi_diff_scrollbar_move(point) {
            return;
        }
        if self.route_settings_scrollbar_move(point) {
            return;
        }
        let terminal_position = self.terminal_mouse_position(point);
        let terminal_captured = self.route_terminal_pointer_move(terminal_position);
        if !terminal_captured && self.route_terminal_selection_move(terminal_position) {
            return;
        }
        let outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .pointer_moved(point, presentation.interaction_frame())
            })
            .unwrap_or_default();
        self.update_cursor();
        self.apply_dispatch_outcome(outcome);
    }

    pub(super) fn pointer_left(&mut self) {
        self.cursor_position = None;
        self.file_editor_input.cancel_pointer();
        let pane_resize_cancelled = self.cancel_terminal_pane_resize();
        if self.scm.editor_mut().scrollbar_pointer_left(Instant::now()) {
            self.rebuild_presentation();
            self.request_redraw();
        }
        if self
            .settings
            .keybindings_scrollbar_pointer_left(Instant::now())
        {
            self.rebuild_presentation_on_next_redraw();
        }
        if self
            .workbench
            .tab_container_scrollbar_pointer_left(Instant::now())
        {
            self.rebuild_presentation_on_next_redraw();
        }
        let outcome = self.ui_dispatch.pointer_left();
        if pane_resize_cancelled {
            self.rebuild_presentation();
            self.request_redraw();
        }
        self.update_cursor();
        self.apply_dispatch_outcome(outcome);
    }

    pub(super) fn primary_button_changed(&mut self, state: ElementState) {
        let composer_click = (state == ElementState::Pressed)
            .then(|| {
                let presentation = self.presentation.as_ref()?;
                let point = self.cursor_position?;
                (presentation.interaction_frame().target_at(point) == Some(COMPOSER))
                    .then_some((point, presentation))
            })
            .flatten()
            .and_then(|(point, presentation)| {
                presentation
                    .element_bounds(COMPOSER)
                    .map(|bounds| (point, bounds))
            });
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        let outcome = match state {
            ElementState::Pressed => self
                .ui_dispatch
                .press_primary(presentation.interaction_frame()),
            ElementState::Released => {
                let point = self.cursor_position.unwrap_or(Point::new(-1.0, -1.0));
                self.ui_dispatch
                    .release_primary(point, presentation.interaction_frame())
            }
        };
        self.apply_dispatch_outcome(outcome);
        if let Some((point, bounds)) = composer_click {
            let selection_mode = if self.modifiers.shift_key() {
                ash_editor::CodeEditorSelectionMode::Extend
            } else {
                ash_editor::CodeEditorSelectionMode::Move
            };
            if self
                .session_pane
                .move_composer_caret_to_point(bounds, point, selection_mode)
            {
                self.composer_changed();
            }
        }
    }

    pub(super) fn mouse_button_changed(&mut self, state: ElementState, button: MouseButton) {
        if self.route_remote_connection_manager_button(state, button) {
            return;
        }
        if self.memories.state.open {
            if button == MouseButton::Left {
                self.primary_button_changed(state);
            }
            return;
        }
        if self.route_remote_tunnel_manager_button(state, button) {
            return;
        }
        if self.route_remote_connection_picker_button(state, button) {
            return;
        }
        if self.route_git_branch_picker_button(state, button) {
            return;
        }
        if self.route_directory_picker_button(state, button) {
            return;
        }
        if self.route_tab_context_menu_button(state, button) {
            return;
        }
        if button == MouseButton::Left && self.route_tab_container_scrollbar_button(state) {
            return;
        }
        if button == MouseButton::Left && self.route_tab_container_resize_button(state) {
            return;
        }
        if button == MouseButton::Left && self.route_inspector_resize_button(state) {
            return;
        }
        if button == MouseButton::Left && self.route_terminal_pane_resize_button(state) {
            return;
        }
        if button == MouseButton::Left && self.route_multi_diff_scrollbar_button(state) {
            return;
        }
        if button == MouseButton::Left && self.route_settings_scrollbar_button(state) {
            return;
        }
        if button == MouseButton::Left
            && state == ElementState::Pressed
            && let Some(point) = self.cursor_position
        {
            let _ = self.activate_terminal_pane_at(point);
        }
        let position = self
            .cursor_position
            .and_then(|point| self.terminal_mouse_position(point));
        if self.route_terminal_pointer_button(position, button, state) {
            return;
        }
        if button == MouseButton::Left && self.route_terminal_selection_button(position, state) {
            return;
        }
        if button == MouseButton::Left {
            self.primary_button_changed(state);
            self.route_file_editor_pointer_button(state);
        }
    }

    pub(super) fn multi_diff_bounds(&self) -> Option<zui::ui::Rect> {
        self.presentation
            .as_ref()?
            .element_bounds(ash_scm::MULTI_DIFF_EDITOR)
    }

    pub(super) fn settings_keybindings_viewport(
        &self,
    ) -> Option<ash_settings::SettingsKeybindingsViewport> {
        if !self.workbench.workbench().sidebar_part().is_settings()
            || self.settings.section() != ash_settings::SettingsPageSection::Keybindings
            || self.quick_access.shortcuts_open()
        {
            return None;
        }
        let bounds = self
            .presentation
            .as_ref()?
            .element_bounds(ash_settings::SETTINGS_KEYBINDINGS_LIST)?;
        Some(ash_settings::SettingsKeybindingsViewport::new(
            bounds,
            ash_commands::AppCommandId::BINDABLE.len(),
            self.keybinding_diagnostics.len(),
            ash_settings::SettingsSectionStyle::from_theme(self.palette, &self.typography)
                .scroll_view,
        ))
    }

    fn route_settings_scrollbar_move(&mut self, point: Point) -> bool {
        let Some(viewport) = self.settings_keybindings_viewport() else {
            return false;
        };
        let outcome =
            self.settings
                .keybindings_scrollbar_pointer_moved(point, viewport, Instant::now());
        if outcome.presentation_changed {
            self.rebuild_presentation_on_next_redraw();
        }
        outcome.handled
    }

    fn route_tab_container_scrollbar_move(&mut self, point: Point) -> bool {
        let Some(view) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.tab_container_scroll_view)
        else {
            return false;
        };
        let outcome =
            self.workbench
                .tab_container_scrollbar_pointer_moved(view, point, Instant::now());
        if outcome.presentation_changed {
            self.rebuild_presentation_on_next_redraw();
        }
        outcome.handled
    }

    fn route_tab_container_scrollbar_button(&mut self, state: ElementState) -> bool {
        let Some(view) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.tab_container_scroll_view)
        else {
            return false;
        };
        let point = self.cursor_position.unwrap_or(Point::new(-1.0, -1.0));
        let now = Instant::now();
        let outcome = match state {
            ElementState::Pressed => self
                .workbench
                .press_tab_container_scrollbar(view, point, now),
            ElementState::Released => self
                .workbench
                .release_tab_container_scrollbar(view, point, now),
        };
        if outcome.presentation_changed {
            self.rebuild_presentation_on_next_redraw();
        }
        outcome.handled
    }

    fn route_settings_scrollbar_button(&mut self, state: ElementState) -> bool {
        let Some(viewport) = self.settings_keybindings_viewport() else {
            return false;
        };
        let point = self.cursor_position.unwrap_or(Point::new(-1.0, -1.0));
        let now = Instant::now();
        let outcome = match state {
            ElementState::Pressed => self
                .settings
                .press_keybindings_scrollbar(point, viewport, now),
            ElementState::Released => self
                .settings
                .release_keybindings_scrollbar(point, viewport, now),
        };
        if outcome.presentation_changed {
            self.rebuild_presentation_on_next_redraw();
        }
        outcome.handled
    }

    pub(super) fn route_multi_diff_scrollbar_move(&mut self, point: Point) -> bool {
        let Some(bounds) = self.multi_diff_bounds() else {
            return false;
        };
        let outcome = self
            .scm
            .editor_mut()
            .scrollbar_pointer_moved(point, bounds, Instant::now());
        if outcome.presentation_changed {
            self.rebuild_presentation_on_next_redraw();
        }
        outcome.handled
    }

    pub(super) fn route_multi_diff_scrollbar_button(&mut self, state: ElementState) -> bool {
        let Some(bounds) = self.multi_diff_bounds() else {
            return false;
        };
        let point = self.cursor_position.unwrap_or(Point::new(-1.0, -1.0));
        let now = Instant::now();
        let outcome = match state {
            ElementState::Pressed => self.scm.editor_mut().press_scrollbar(point, bounds, now),
            ElementState::Released => self.scm.editor_mut().release_scrollbar(point, bounds, now),
        };
        if outcome.presentation_changed {
            self.rebuild_presentation_on_next_redraw();
        }
        outcome.handled
    }
}
