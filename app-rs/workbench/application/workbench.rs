use super::*;

impl WorkbenchApplication {
    pub(super) const fn terminal_view(&self) -> &TerminalPaneViewState {
        self.terminal_pane_views.active_view()
    }

    pub(super) const fn terminal_view_mut(&mut self) -> &mut TerminalPaneViewState {
        self.terminal_pane_views.active_view_mut()
    }

    /// Closes one logical tab and releases every application resource keyed by that tab.
    pub(super) fn close_workbench_tab(&mut self, tab_key: &TabInputKey) -> bool {
        if self
            .workbench
            .workbench()
            .sidebar_part()
            .input(tab_key)
            .is_none()
        {
            return false;
        }
        if let Some(session) = self.session_runtime.as_ref()
            && let Some(session_id) = tab_key.session_id()
            && let Err(error) = session.stop_session(session_id.clone())
        {
            eprintln!("could not close Session {session_id}: {error}");
            return false;
        }
        self.remove_workbench_tab(tab_key)
    }

    pub(super) fn fork_workbench_session(&mut self, tab_key: &TabInputKey) -> bool {
        if self
            .workbench
            .workbench()
            .sidebar_part()
            .input(tab_key)
            .is_none()
        {
            return false;
        }
        let Some(session_id) = tab_key.session_id() else {
            return false;
        };
        let Some(runtime) = self.session_runtime.as_ref() else {
            return false;
        };
        if let Err(error) = runtime.fork_session(session_id.clone()) {
            eprintln!("could not fork Session {session_id}: {error}");
            return false;
        }
        self.rebuild_presentation_on_next_redraw();
        true
    }

    pub(super) fn archive_workbench_session(&mut self, tab_key: &TabInputKey) -> bool {
        if self
            .workbench
            .workbench()
            .sidebar_part()
            .input(tab_key)
            .is_none()
        {
            return false;
        }
        let Some(session_id) = tab_key.session_id() else {
            return false;
        };
        let Some(runtime) = self.session_runtime.as_ref() else {
            return false;
        };
        if let Err(error) = runtime.archive_session(session_id.clone()) {
            eprintln!("could not archive Session {session_id}: {error}");
            return false;
        }
        self.remove_workbench_tab(tab_key)
    }

    pub(super) fn delete_workbench_session(&mut self, tab_key: &TabInputKey) -> bool {
        if self
            .workbench
            .workbench()
            .sidebar_part()
            .input(tab_key)
            .is_none()
        {
            return false;
        }
        let Some(session_id) = tab_key.session_id() else {
            return false;
        };
        let Some(runtime) = self.session_runtime.as_ref() else {
            return false;
        };
        if let Err(error) = runtime.delete_session(session_id.clone()) {
            eprintln!("could not delete Session {session_id}: {error}");
            return false;
        }
        self.remove_workbench_tab(tab_key)
    }

    pub(super) fn remove_workbench_tab(&mut self, tab_key: &TabInputKey) -> bool {
        if self
            .workbench
            .workbench()
            .sidebar_part()
            .input(tab_key)
            .is_none()
        {
            return false;
        }
        if tab_key.is_settings() && self.remote_connection_manager.is_settings() {
            self.dismiss_remote_connection_manager();
        }
        let was_active =
            self.workbench.workbench().sidebar_part().active_tab_key() == Some(tab_key);
        let Some((closed, bindings)) = self.workbench.close_tab(tab_key) else {
            return false;
        };
        for binding in bindings {
            if let Some(terminal_key) = binding.terminal_key() {
                let _ = self.terminal_runtime.remove_key(terminal_key);
            }
        }
        let active_terminal_view = self
            .terminal_pane_views
            .active()
            .is_some_and(|key| key.tab() == tab_key);
        self.terminal_pane_views.retain(|key| key.tab() != tab_key);
        if active_terminal_view {
            self.terminal_view_mut().selection.clear();
            self.terminal_view_mut().pointer.cancel();
        }
        if tab_key.is_settings() {
            self.settings.close();
        }
        if was_active {
            match closed.active_tab().cloned() {
                Some(tab_key @ TabInputKey::Session(_)) => {
                    self.mount_session_pane(&tab_key);
                }
                Some(TabInputKey::Settings) => self.activate_settings_tab(),
                None => {
                    self.main_surface.show_agent();
                    self.pending_focus = Some(ash_session::interaction::COMPOSER);
                }
            }
        }
        self.rebuild_presentation_on_next_redraw();
        true
    }

    pub(super) fn ensure_terminal_for_session(&mut self, session_id: &SessionId) -> bool {
        match self
            .terminal_runtime
            .ensure_for_session(session_id, self.terminal_size())
        {
            Ok(()) => {
                let tab_key = TabInputKey::session(session_id.clone());
                if let Some(terminal_key) = self.terminal_runtime.key_for_session(session_id) {
                    let input = PaneInput::terminal(session_id.clone());
                    let Some((_, binding)) = self.workbench.ensure_root_binding_with(
                        tab_key,
                        input.clone(),
                        PaneBinding::new,
                    ) else {
                        return false;
                    };
                    if !binding.bind_terminal(&input, session_id, terminal_key) {
                        return false;
                    }
                }
                true
            }
            Err(error) => {
                eprintln!("could not start terminal for session: {error}");
                false
            }
        }
    }

    pub(super) fn activate_terminal_for_session(&mut self, session_id: &SessionId) -> bool {
        let tab_key = TabInputKey::session(session_id.clone());
        let Some(pane) = self
            .workbench
            .workbench()
            .pane_part(&tab_key)
            .map(|pane_part| pane_part.active_pane())
        else {
            return false;
        };
        let Some(terminal_key) = self.terminal_runtime.key_for_session(session_id) else {
            return false;
        };
        let Some(activation) = self.workbench.open_or_activate_input_with(
            &tab_key,
            pane,
            PaneInput::terminal(session_id.clone()),
            || PaneBinding::terminal(terminal_key),
        ) else {
            return false;
        };
        if self
            .workbench
            .binding(activation.current())
            .and_then(PaneBinding::terminal_key)
            != Some(terminal_key)
        {
            return false;
        }
        if !self.activate_pane_context(tab_key, pane) {
            return false;
        }
        if let Some(window) = self.window.as_ref()
            && let Some(terminal) = self.active_terminal()
        {
            let _ = window.set_title(terminal.core().title().unwrap_or(APP_DISPLAY_NAME));
        }
        true
    }

    pub(super) fn activate_pane_context(&mut self, tab_key: TabInputKey, pane: PaneId) -> bool {
        if !self.workbench.activate_pane(&tab_key, pane) {
            return false;
        }
        let Some(mount) = self.workbench.mount(&tab_key, pane) else {
            return false;
        };
        let binding = mount.key().clone();
        let terminal_key = mount.binding().terminal_key();
        self.terminal_pane_views.activate(binding);
        let Some(terminal_key) = terminal_key else {
            return true;
        };
        self.terminal_runtime.activate_key(terminal_key)
            || self.terminal_runtime.active_key() == Some(terminal_key)
    }

    pub(super) fn active_pane_terminal_key(&self) -> Option<TerminalSessionKey> {
        self.workbench
            .active_mount()
            .and_then(|mount| mount.binding().terminal_key())
            .or_else(|| self.terminal_runtime.active_key())
    }

    pub(super) fn active_terminal(&self) -> Option<&TerminalSession> {
        self.active_pane_terminal_key()
            .and_then(|key| self.terminal_runtime.terminal(key))
    }

    pub(super) fn active_terminal_mut(&mut self) -> Option<&mut TerminalSession> {
        let key = self.active_pane_terminal_key()?;
        self.terminal_runtime.terminal_mut(key)
    }

    pub(super) fn active_session_tab_key(&self) -> Option<TabInputKey> {
        self.workbench
            .workbench()
            .sidebar_part()
            .active_tab_key()
            .filter(|key| key.is_session())
            .cloned()
    }

    pub(super) fn split_active_pane(&mut self, direction: PaneSplitDirection) {
        if !self.main_surface.is_terminal() {
            return;
        }
        let Some(tab_key) = self.active_session_tab_key() else {
            return;
        };
        let Some(session_id) = tab_key.session_id().cloned() else {
            return;
        };
        if !self.ensure_terminal_for_session(&session_id) {
            return;
        }
        let terminal_size = self.terminal_size();
        let (workbench, terminal_runtime) = (&mut self.workbench, &mut self.terminal_runtime);
        let key = match workbench.try_split_active_with(
            PaneInput::terminal(session_id.clone()),
            direction,
            || {
                let terminal_key = terminal_runtime.spawn_pane(terminal_size)?;
                terminal_runtime.bind_key_to_session(terminal_key, session_id);
                Ok::<_, anyhow::Error>(PaneBinding::terminal(terminal_key))
            },
        ) {
            Ok(Some(key)) => key,
            Ok(None) => return,
            Err(error) => {
                eprintln!("could not create split terminal Pane: {error}");
                return;
            }
        };
        let _ = self.activate_pane_context(tab_key, key.pane());
        self.rebuild_presentation_on_next_redraw();
    }

    pub(super) fn close_active_pane(&mut self) {
        if !self.main_surface.is_terminal() {
            return;
        }
        let Some(tab_key) = self.active_session_tab_key() else {
            return;
        };
        let Some(closed) = self.workbench.close_active_pane() else {
            return;
        };
        for pane in closed.panes() {
            let key = PaneKey::new(tab_key.clone(), pane.id(), pane.input_id());
            self.terminal_pane_views.remove(&key);
        }
        let replacement_pane = closed.active_pane();
        for binding in closed.into_bindings() {
            if let Some(key) = binding.terminal_key() {
                let _ = self.terminal_runtime.remove_key(key);
            }
        }
        let _ = self.activate_pane_context(tab_key, replacement_pane);
        self.rebuild_presentation_on_next_redraw();
    }

    pub(super) fn focus_next_pane(&mut self) {
        self.focus_adjacent_pane(true);
    }

    pub(super) fn focus_previous_pane(&mut self) {
        self.focus_adjacent_pane(false);
    }

    pub(super) fn focus_adjacent_pane(&mut self, next: bool) {
        if !self.main_surface.is_terminal() {
            return;
        }
        let Some(tab_key) = self.active_session_tab_key() else {
            return;
        };
        let Some(pane) = (if next {
            self.workbench.focus_next_pane(&tab_key)
        } else {
            self.workbench.focus_previous_pane(&tab_key)
        }) else {
            return;
        };
        let _ = self.activate_pane_context(tab_key, pane);
        self.rebuild_presentation_on_next_redraw();
    }

    pub(super) fn terminal_pane_sash_at(
        &self,
        point: Point,
    ) -> Option<(
        TabInputKey,
        PaneSplitId,
        SplitViewOrientation,
        SplitViewResizeSnapshot,
    )> {
        if !self.main_surface.is_terminal() {
            return None;
        }
        let tab_key = self.active_session_tab_key()?;
        let layout = self.workbench.workbench().pane_part(&tab_key)?;
        terminal_pane_sash_for_viewport(
            self.logical_viewport(),
            self.active_screen(),
            self.workbench.tab_container_state(),
            self.workbench.inspector_state(),
            layout,
            point,
        )
        .map(|(split_id, orientation, snapshot)| (tab_key, split_id, orientation, snapshot))
    }

    pub(super) fn route_terminal_pane_resize_move(&mut self, point: Point) -> bool {
        if self.workbench.pane_resize_split().is_none() {
            return false;
        }
        let changed = self.workbench.resize_pane(point);
        if changed {
            self.terminal_view_mut().selection.clear();
            self.rebuild_presentation();
            self.request_redraw();
        }
        self.update_cursor();
        true
    }

    pub(super) fn route_terminal_pane_resize_button(&mut self, state: ElementState) -> bool {
        let now = Instant::now();
        match state {
            ElementState::Pressed => {
                if self.workbench.pane_resize_split().is_some() {
                    return true;
                }
                let Some(point) = self.cursor_position else {
                    return false;
                };
                let Some((tab_key, split_id, orientation, snapshot)) =
                    self.terminal_pane_sash_at(point)
                else {
                    return false;
                };
                let identity = crate::pane_sash_element_id(split_id);
                let over_sash = self.presentation.as_ref().is_some_and(|presentation| {
                    presentation.interaction_frame().target_at(point) == Some(identity)
                });
                if !over_sash {
                    return false;
                }
                let orientation = match orientation {
                    SplitViewOrientation::Horizontal => SashOrientation::Vertical,
                    SplitViewOrientation::Vertical => SashOrientation::Horizontal,
                };
                if !self.workbench.start_pane_resize(
                    tab_key,
                    split_id,
                    orientation,
                    snapshot,
                    point,
                    now,
                ) {
                    return false;
                }
            }
            ElementState::Released => {
                let Some(split) = self.workbench.pane_resize_split() else {
                    return false;
                };
                let identity = crate::pane_sash_element_id(split);
                let presence = self.sash_pointer_presence(identity);
                let _ = self.workbench.finish_pane_resize(presence, now);
            }
        }
        self.rebuild_presentation();
        self.update_cursor();
        self.request_redraw();
        true
    }

    pub(super) fn cancel_terminal_pane_resize(&mut self) -> bool {
        self.workbench.cancel_pane_resize()
    }
}

impl WorkbenchApplication {
    /// Selects the singleton Settings workbench item and prepares its feature-owned state.
    pub(super) fn activate_settings_tab(&mut self) {
        let remote_selected = self.settings.section() == ash_settings::SettingsPageSection::Remote;
        let remote_is_mounted = self.remote_connection_manager.is_settings();
        self.settings.reopen();
        let _ = self.workbench.activate_settings();
        let _ = self.git_branch_picker.dismiss();
        let _ = self.directory_picker.dismiss();
        let _ = self.remote_connection_picker.dismiss();
        if !remote_selected || !remote_is_mounted {
            self.dismiss_remote_connection_manager();
        }
        self.dismiss_remote_tunnel_manager();
        self.dismiss_tab_context_menu();
        if remote_selected && !remote_is_mounted {
            let _ = self.open_remote_connection_settings();
        } else if !remote_selected {
            self.pending_focus = Some(ash_settings::SETTINGS_SEARCH_INPUT);
        }
        self.keybindings.cancel_chord();
    }

    /// Returns to the last selected session without fabricating a session for Settings.
    pub(super) fn activate_session_workbench_tab(&mut self) {
        let was_terminal = self.main_surface.is_terminal();
        let _ = self.workbench.activate_last_session();
        if let Some(session_id) = self
            .workbench
            .workbench()
            .sidebar_part()
            .selected_session()
            .cloned()
        {
            let _ = self.activate_terminal_for_session(&session_id);
            if !was_terminal {
                let _ = self.bind_agent_pane();
            }
        }
        self.settings.close();
        self.pending_focus = Some(if self.main_surface.is_editor() {
            ash_editor_host::FILE_EDITOR_DOCUMENT
        } else {
            ash_session::interaction::COMPOSER
        });
    }

    pub(super) fn close_settings_tab(&mut self) {
        let _ = self.close_workbench_tab(&TabInputKey::Settings);
    }
}
