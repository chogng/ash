use super::events::handle_terminal_event;
use super::*;

impl App<WorkbenchEvent> for WorkbenchApplication {
    fn ready(&mut self, context: &mut AppContext<'_, WorkbenchEvent>) {
        if self.window.is_some() {
            self.request_redraw();
            return;
        }

        let options = WindowOptions::new(APP_DISPLAY_NAME)
            .with_inner_size(LogicalSize::new(INITIAL_WIDTH, INITIAL_HEIGHT))
            .with_chrome(WindowChrome::ContentUnderTitlebar);
        let opened_window = match context.open_window(options) {
            Ok(opened_window) => opened_window,
            Err(error) => {
                self.fail(&error);
                context.exit_with_error(error);
                return;
            }
        };
        let window = opened_window.handle();
        let system_scheme = match window.theme() {
            Ok(Some(Theme::Dark)) => ColorScheme::Dark,
            Ok(Some(Theme::Light) | None) => ColorScheme::Light,
            Err(error) => {
                context
                    .exit_with_error(ApplicationError::host("initial window theme query", error));
                return;
            }
        };
        self.reload_theme(system_scheme);
        if let Err(error) = window.set_theme((!self.theme_follows_system).then_some(
            match self.theme_scheme {
                ColorScheme::Dark | ColorScheme::HighContrastDark => Theme::Dark,
                ColorScheme::Light | ColorScheme::HighContrastLight => Theme::Light,
            },
        )) {
            context.exit_with_error(ApplicationError::host("initial window theme update", error));
            return;
        }
        self.physical_extent = opened_window.metrics().physical_extent();
        self.scale_factor = opened_window.metrics().scale_factor();
        let terminal_size = terminal_grid_size_for_viewport(
            self.logical_viewport(),
            ScreenBuffer::Primary,
            self.workbench.tab_container_state(),
            self.workbench.inspector_state(),
        );
        if let Err(error) = self.terminal_runtime.spawn_initial(terminal_size) {
            self.fail(error);
            context.exit();
            return;
        }
        if self.app_server_host.is_remote()
            && let Err(error) = self
                .language_service
                .start_remote(Arc::new(self.app_server_host.clone()))
        {
            self.fail(error);
            context.exit();
            return;
        }
        let event_proxy = self.event_proxy.clone();
        self.session_runtime =
            match SessionRuntime::spawn(self.app_server_host.clone(), move |event| {
                event_proxy
                    .send_event(event.into())
                    .map_err(|_| "application event loop is unavailable".to_owned())
            }) {
                Ok(session) => Some(session),
                Err(error) => {
                    self.fail(error);
                    context.exit();
                    return;
                }
            };
        self.window = Some(window);
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }

    fn resumed(&mut self, _context: &mut AppContext<'_, WorkbenchEvent>) {
        self.request_redraw();
    }

    fn window_event(
        &mut self,
        context: &mut WindowContext<'_, WorkbenchEvent>,
        event: WindowEvent,
    ) {
        if self.window.as_ref().map(WindowHandle::id) != Some(context.id()) {
            return;
        }
        match event {
            WindowEvent::CloseRequested => {
                context.close();
            }
            WindowEvent::Resized(size) => {
                self.terminal_view_mut().selection.clear();
                self.physical_extent = PhysicalExtent::new(size.width, size.height);
                self.rebuild_presentation();
                self.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.terminal_view_mut().selection.clear();
                self.scale_factor = scale_factor;
                self.rebuild_presentation();
                self.request_redraw();
            }
            WindowEvent::ThemeChanged(theme) => {
                if !self.theme_follows_system {
                    return;
                }
                let system_scheme = match theme {
                    Theme::Dark => ColorScheme::Dark,
                    Theme::Light => ColorScheme::Light,
                };
                self.reload_theme(system_scheme);
                self.rebuild_presentation_on_next_redraw();
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.pointer_moved(position.x, position.y);
            }
            WindowEvent::CursorLeft { .. } => self.pointer_left(),
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            WindowEvent::KeyboardInput { event, .. } => self.keyboard_input(event),
            WindowEvent::Ime(event) => self.ime_input(event),
            WindowEvent::Focused(false) => {
                self.modifiers = ModifiersState::default();
                self.keybindings.cancel_chord();
                self.settings.keyboard_shortcuts_window_blurred();
                self.quick_access.cancel_query_composition();
                self.terminal_view_mut().pointer.cancel();
                self.file_editor_input.cancel_pointer();
                self.cancel_tab_container_resize();
                self.cancel_inspector_resize();
                if self.cancel_terminal_pane_resize() {
                    self.update_cursor();
                }
                self.scm.editor_mut().cancel_scrollbar_interaction();
                self.terminal_view_mut().scroll.cancel_scrollbar();
                self.workbench.cancel_tab_container_scrollbar();
                self.workbench.dismiss_tab_context_menu();
                self.git_branch_picker.dismiss();
                self.directory_picker.dismiss();
                self.ui_dispatch.window_blurred();
                self.sync_input_focus();
                self.rebuild_presentation();
                self.request_redraw();
            }
            WindowEvent::Focused(true) => {
                self.ui_dispatch.window_focused();
                self.sync_input_focus();
                self.rebuild_presentation();
                self.request_redraw();
            }
            WindowEvent::MouseInput { state, button, .. } => {
                self.mouse_button_changed(state, button);
            }
            WindowEvent::MouseWheel { delta, .. } => self.mouse_wheel(delta),
            WindowEvent::Occluded(false) => {
                // macOS can reject initial surface acquisition while the new window activates.
                // The visible transition is the next reliable opportunity to present that frame.
                self.request_redraw();
            }
            WindowEvent::Occluded(true) => {}
            _ => {}
        }
    }

    fn redraw(&mut self, context: &mut WindowContext<'_, WorkbenchEvent>) {
        self.redraw_frame(context);
    }

    fn accessibility_action(
        &mut self,
        _context: &mut AppContext<'_, WorkbenchEvent>,
        action: AccessibilityAction,
    ) {
        if self.window.as_ref().map(WindowHandle::id) != Some(action.window()) {
            return;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        let outcome = match action.kind() {
            AccessibilityActionKind::Focus => self
                .ui_dispatch
                .focus_element(presentation.interaction_frame(), action.target()),
            AccessibilityActionKind::Activate => self
                .ui_dispatch
                .activate_element(presentation.interaction_frame(), action.target()),
        };
        self.apply_dispatch_outcome(outcome);
    }

    fn user_event(&mut self, _context: &mut AppContext<'_, WorkbenchEvent>, event: WorkbenchEvent) {
        match event {
            WorkbenchEvent::InputHistoryReady => {
                if self.session_pane.poll_input_history() {
                    self.composer_changed();
                }
                return;
            }
            WorkbenchEvent::InputClassified(result) => {
                self.classification_task = None;
                match self.session_pane.finish_composer_classification(result) {
                    ash_session::ComposerClassificationUpdate::Stale => {}
                    ash_session::ComposerClassificationUpdate::Updated => {
                        self.rebuild_presentation_on_next_redraw();
                    }
                    ash_session::ComposerClassificationUpdate::Submit => {
                        self.submit_composer();
                        self.rebuild_presentation_on_next_redraw();
                    }
                }
                return;
            }
            WorkbenchEvent::Session(event) => {
                self.handle_session_runtime_event(event);
                return;
            }
            WorkbenchEvent::EditorLanguage(event) => {
                self.language_service
                    .handle_event(event, &self.file_editor_host);
                if let Some(target) = self
                    .language_service
                    .take_definitions()
                    .and_then(|definitions| definitions.targets.into_iter().next())
                {
                    self.open_language_definition(target);
                    return;
                }
                self.rebuild_presentation();
                self.request_redraw();
                return;
            }
            WorkbenchEvent::RemoteWindowLaunch(event) => {
                self.handle_remote_window_launch_event(event);
                return;
            }
            WorkbenchEvent::RemoteTunnel(event) => {
                self.handle_remote_tunnel_event(event);
                return;
            }
            WorkbenchEvent::Memories(completion) => {
                self.memories.finish(completion);
                self.rebuild_presentation_on_next_redraw();
                return;
            }
            WorkbenchEvent::Memory(completion) => {
                self.memory.finish(completion);
                self.rebuild_presentation_on_next_redraw();
                return;
            }
            WorkbenchEvent::ScmOperationFinished(result) => {
                if let Err(error) = result {
                    eprintln!("SCM operation failed: {error}");
                }
                if let Err(error) = self.refresh_git_from_app_server() {
                    eprintln!("could not refresh Git after SCM operation: {error}");
                }
                self.rebuild_presentation_on_next_redraw();
                return;
            }
            WorkbenchEvent::Terminal(event) => {
                handle_terminal_event(self, event.key, event.event);
                return;
            }
            WorkbenchEvent::TerminalReady(ready) => {
                match self.terminal_runtime.handle_ready(ready) {
                    TerminalReadyOutcome::Active {
                        key,
                        buffered_events,
                    } => {
                        if buffered_events.is_empty() {
                            self.rebuild_presentation_on_next_redraw();
                        } else {
                            for event in buffered_events {
                                handle_terminal_event(self, key, event);
                            }
                        }
                    }
                    TerminalReadyOutcome::Inactive {
                        key,
                        buffered_events,
                    } => {
                        for event in buffered_events {
                            handle_terminal_event(self, key, event);
                        }
                    }
                    TerminalReadyOutcome::Failed { error, .. } => {
                        eprintln!("could not create terminal runtime: {error}");
                        self.rebuild_presentation_on_next_redraw();
                    }
                    TerminalReadyOutcome::Ignored { .. } => {}
                }
                return;
            }
        }
    }

    fn about_to_wait(&mut self, context: &mut AppContext<'_, WorkbenchEvent>) {
        let now = Instant::now();
        if self.classification_task.is_none()
            && let Some(window) = self.window.as_ref()
            && let Some(task) = self.session_pane.take_composer_classification_task(now)
        {
            self.classification_task = Some(
                context
                    .background_executor()
                    .spawn(zui::runtime::TaskScope::Window(window.id()), async move {
                        WorkbenchEvent::InputClassified(task.run())
                    }),
            );
        }
        self.keybindings.advance_chord(now);
        if let Some(commit) = self.settings.advance_keyboard_shortcuts(now) {
            match self.save_keybinding(commit.command, &commit.keybinding) {
                Ok(()) => self.settings.keyboard_shortcuts_saved(commit.command),
                Err(error) => self
                    .settings
                    .keyboard_shortcuts_save_failed(error.to_string()),
            }
            self.rebuild_presentation();
            self.request_redraw();
        }
        let caret_changed = matches!(
            self.caret_blink.advance(now),
            CaretBlinkAdvance::VisibilityChanged(_)
        );
        let scrollbar_changed = self.scm.editor_mut().advance_scrollbar(now);
        let settings_scrollbar_changed = self.settings.advance_keybindings_scrollbar(now);
        let terminal_scrollbar_changed = self.terminal_view_mut().scroll.advance_scrollbar(now);
        let tab_container_scrollbar_changed = self.workbench.advance_tab_container_scrollbar(now);
        let sash_changed = self.workbench.advance_layout_sashes(now);
        let retained_runtime_due = self
            .retained_runtime
            .next_deadline()
            .is_some_and(|deadline| deadline <= now);
        let file_search_changed = self.files.poll_search();
        let file_editor_auto_scrolled = self.advance_file_editor_auto_scroll(now);
        if caret_changed
            || scrollbar_changed
            || settings_scrollbar_changed
            || terminal_scrollbar_changed
            || tab_container_scrollbar_changed
            || file_search_changed
            || file_editor_auto_scrolled
            || sash_changed
        {
            self.rebuild_presentation_on_next_redraw();
        } else if retained_runtime_due {
            self.request_redraw();
        }
        let mut deadlines = FrameDeadlineSet::default();
        if self.classification_task.is_none()
            && let Some(deadline) = self.session_pane.composer_classification_deadline()
        {
            deadlines.include(deadline);
        }
        for deadline in [
            self.caret_blink.next_deadline(),
            self.scm.editor().scrollbar_deadline(),
            self.settings.keybindings_scrollbar_deadline(),
            self.terminal_view().scroll.scrollbar_deadline(),
            self.workbench.tab_container_scrollbar_deadline(),
            self.retained_runtime.next_deadline(),
            self.workbench.tab_sash_deadline(),
            self.workbench.inspector_sash_deadline(),
            self.keybindings.chord_deadline(),
            self.settings.keyboard_shortcuts_deadline(),
            self.file_editor_input.auto_scroll_deadline(),
        ]
        .into_iter()
        .flatten()
        {
            deadlines.include(deadline);
        }
        if self.files.search_pending() {
            deadlines.include(now + std::time::Duration::from_millis(50));
        }
        let control_flow = match deadlines.next_deadline() {
            Some(deadline) => ControlFlow::WaitUntil(deadline),
            None => ControlFlow::Wait,
        };
        context.set_control_flow(control_flow);
    }
}
