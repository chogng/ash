use super::*;

pub(super) fn with_shell_presentation_model<R>(
    app: &mut WorkbenchApplication,
    window_control_insets: WindowControlInsets,
    operation: impl FnOnce(
        WorkbenchPresentationModel<'_>,
        &mut TextInputLayoutEngine,
        &mut dyn zui::ui::AnimationBinding,
    ) -> R,
) -> R {
    let tab_container = app.workbench.tab_container_state();
    let inspector_part = app.workbench.inspector_state();
    let pane_resize_split = app.workbench.pane_resize_split();
    let WorkbenchApplication {
        palette,
        typography,
        retained_runtime,
        workbench,
        terminal_pane_views,
        main_surface,
        session_pane,
        env,
        session_search,
        caret_blink,
        ui_dispatch,
        terminal_runtime,
        files,
        scm,
        files_pane_expanded,
        file_editor_host,
        file_editor_input,
        file_editor_search,
        language_service,
        code_editor_style,
        git_branch_picker,
        directory_picker,
        remote_connection_picker,
        remote_connection_manager,
        remote_tunnel_manager,
        memories,
        keybindings,
        quick_access,
        settings,
        theme_scheme,
        theme_follows_system,
        cursor_position,
        keybinding_diagnostics,
        text_layout,
        ..
    } = app;
    let terminal_view = terminal_pane_views.active_view();
    let workbench_model = workbench.workbench();
    let file_editor_diagnostics = language_service.active_editor_diagnostics(file_editor_host);
    let language_hover = language_service.active_hover(file_editor_host);
    let language_completions = language_service.active_completions(file_editor_host);
    let git_diff_summary = env.diff_summary_label();
    let active_tab_input = workbench_model.sidebar_part().active_tab_key();
    let content_tab_input = active_tab_input
        .filter(|input| input.is_session())
        .cloned()
        .or_else(|| {
            workbench_model
                .sidebar_part()
                .selected_session()
                .cloned()
                .map(TabInputKey::session)
        });
    let content_tab_input = content_tab_input.as_ref();
    let pane_group = content_tab_input.and_then(|key| workbench_model.pane_part(key));
    let active_pane = content_tab_input.and_then(|tab_key| {
        let layout = workbench_model.pane_part(tab_key)?;
        workbench.mount(tab_key, layout.active_group())
    });
    let active_pane_id = active_pane.map(|mount| mount.pane_id());
    let terminal_panes = pane_group
        .map(|layout| {
            let Some(tab_key) = content_tab_input else {
                return Vec::new();
            };
            layout
                .group_ids()
                .into_iter()
                .filter_map(|pane_id| {
                    let mount = workbench.mount(tab_key, pane_id)?;
                    let pane_id = mount.pane_id();
                    let kind = mount.kind();
                    let terminal_key = (kind == PaneInputKind::Terminal)
                        .then(|| mount.binding().terminal_key())
                        .flatten();
                    let (scroll_offset, scrollbar_presentation, selection) =
                        if active_pane_id == Some(pane_id) {
                            (
                                terminal_view.scroll.offset(),
                                terminal_view.scroll.scrollbar_presentation(),
                                terminal_view.selection.range(),
                            )
                        } else if let Some(state) = terminal_pane_views.inactive(mount.key()) {
                            (
                                state.scroll.offset(),
                                state.scroll.scrollbar_presentation(),
                                state.selection.range(),
                            )
                        } else {
                            (0, Default::default(), None)
                        };
                    Some(crate::PaneView {
                        pane_id: Some(pane_id),
                        kind,
                        core: terminal_key.and_then(|key| {
                            terminal_runtime.terminal(key).map(TerminalSession::core)
                        }),
                        scroll_offset,
                        scrollbar_presentation,
                        selection,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let terminal_key = active_pane
        .and_then(|mount| mount.binding().terminal_key())
        .or_else(|| terminal_runtime.active_key());
    operation(
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: *palette,
            typography: typography.clone(),
            terminal: terminal_key
                .and_then(|key| terminal_runtime.terminal(key))
                .map(TerminalSession::core),
            terminal_panes: &terminal_panes,
            pane_group,
            active_pane,
            terminal_pane_resize_split: pane_resize_split,
            terminal_scroll_offset: terminal_view.scroll.offset(),
            terminal_scrollbar_presentation: terminal_view.scroll.scrollbar_presentation(),
            terminal_selection: terminal_view.selection.range(),
            main_surface: main_surface.active(),
            file_editor_host,
            file_editor_prompt: file_editor_input.prompt(),
            file_editor_search,
            file_editor_diagnostics,
            language_hover,
            language_completions,
            completion_selection: file_editor_input.completion_selection(),
            code_editor_style,
            session_pane,
            environment_context: crate::EnvironmentContextView {
                location: env.location_label(),
                working_directory: env.working_directory_label(),
                git_branch: env.git_branch_label(),
                diff_summary: git_diff_summary,
                upstream_distance: env.upstream_distance(),
            },
            session_search,
            sidebar_part: workbench_model.sidebar_part(),
            active_tab_input,
            caret_visibility: caret_blink.visibility(),
            dispatch: ui_dispatch,
            tab_container,
            inspector_part,
            files,
            scm,
            files_pane_expanded: *files_pane_expanded,
            tab_context_menu: workbench.tab_context_menu().clone(),
            git_branch_picker,
            directory_picker,
            remote_connection_picker,
            remote_connection_manager,
            remote_tunnel_manager,
            memories: &memories.state,
            keybindings,
            quick_access,
            settings,
            keybinding_diagnostics,
            theme_scheme: *theme_scheme,
            theme_follows_system: *theme_follows_system,
            window_control_insets,
            pointer_position: *cursor_position,
        },
        text_layout,
        retained_runtime.animation_registry_mut(),
    )
}
