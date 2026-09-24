use ash_commands::AppCommandId;
use ash_session::interaction::ContextAction;
use zui::ui::ElementId;

use super::WorkbenchApplication;
use crate::ADD_SESSION;
use crate::CHANGES_PANE_BUTTON;
use crate::PaneSplitDirection;
use crate::TAB_CONTAINER_TOGGLE;

/// Resolves a command-like Workbench element into its stable command identity.
pub(crate) fn command_for_element(element: ElementId) -> Option<AppCommandId> {
    match element {
        ash_settings::OPEN_MEMORIES => Some(AppCommandId::ManageMemories),
        TAB_CONTAINER_TOGGLE => Some(AppCommandId::ToggleTabContainer),
        CHANGES_PANE_BUTTON => Some(AppCommandId::ShowAgentChanges),
        ADD_SESSION => Some(AppCommandId::AddSession),
        ash_files::FILES_REFRESH => Some(AppCommandId::RefreshAgentFiles),
        ash_files::FILES_SEARCH => Some(AppCommandId::ToggleAgentFileSearch),
        _ => match ContextAction::from_element_id(element)? {
            ContextAction::Location => Some(AppCommandId::PickExecutionLocation),
            ContextAction::WorkingDirectory => Some(AppCommandId::PickWorkingDirectory),
            ContextAction::GitBranch => Some(AppCommandId::PickGitBranch),
            ContextAction::Diff => Some(AppCommandId::ShowGitDiff),
        },
    }
}

impl WorkbenchApplication {
    pub(super) fn dispatch_command(&mut self, command: AppCommandId) {
        match command {
            AppCommandId::StartMemoryDiagnostics
            | AppCommandId::ReadMemoryDiagnostics
            | AppCommandId::StopMemoryDiagnostics
            | AppCommandId::ExportMemoryDiagnostics => {
                self.memory.execute(command, self.app_server_client.clone())
            }
            AppCommandId::ManageMemories => self.open_memories(),
            AppCommandId::Copy => execute_copy(self),
            AppCommandId::Paste => execute_paste(self),
            AppCommandId::Save => execute_save(self),
            AppCommandId::ToggleTerminalSurface => execute_toggle_terminal_surface(self),
            AppCommandId::OpenKeyboardShortcuts => execute_open_keyboard_shortcuts(self),
            AppCommandId::ManageRemoteTunnels => execute_manage_remote_tunnels(self),
            AppCommandId::ToggleTabContainer => self.workbench.toggle_tab_container(),
            AppCommandId::ToggleFilesPane => execute_toggle_files_pane(self),
            AppCommandId::AddSession => execute_add_session(self),
            AppCommandId::ShowAgentChanges => execute_show_agent_changes(self),
            AppCommandId::ShowAgentFiles => execute_show_agent_files(self),
            AppCommandId::RefreshAgentFiles => execute_refresh_agent_files(self),
            AppCommandId::ToggleAgentFileSearch => execute_toggle_agent_file_search(self),
            AppCommandId::PinSession
            | AppCommandId::CloseSession
            | AppCommandId::RenameSession
            | AppCommandId::GroupSession
            | AppCommandId::ForkSession => execute_tab_context_menu_action(self, command),
            AppCommandId::PickExecutionLocation => execute_pick_execution_location(self),
            AppCommandId::PickWorkingDirectory => execute_pick_working_directory(self),
            AppCommandId::PickGitBranch => execute_pick_git_branch(self),
            AppCommandId::ShowGitDiff => execute_show_git_diff(self),
            AppCommandId::SplitTerminalHorizontal => execute_split_terminal_horizontal(self),
            AppCommandId::SplitTerminalVertical => execute_split_terminal_vertical(self),
            AppCommandId::FocusNextPane => execute_focus_next_pane(self),
            AppCommandId::FocusPreviousPane => execute_focus_previous_pane(self),
            AppCommandId::ClosePane => execute_close_pane(self),
        }
    }
}

fn execute_copy(app: &mut WorkbenchApplication) {
    app.copy_keybinding_target();
}

fn execute_paste(app: &mut WorkbenchApplication) {
    app.paste_keybinding_target();
}

fn execute_save(app: &mut WorkbenchApplication) {
    app.save_active_file();
}

fn execute_toggle_terminal_surface(app: &mut WorkbenchApplication) {
    let was_terminal = app.main_surface.is_terminal();
    app.main_surface.toggle_terminal();
    if app.main_surface.is_terminal() {
        if let Some(session_id) = app
            .active_session_tab_key()
            .and_then(|key| key.session_id().cloned())
        {
            let _ = app.activate_terminal_for_session(&session_id);
        }
    } else if was_terminal {
        app.restore_main_pane_after_terminal();
    }
    app.pending_focus = if app.main_surface.is_editor() {
        Some(ash_editor_host::FILE_EDITOR_DOCUMENT)
    } else if app.main_surface.is_terminal() {
        None
    } else {
        Some(ash_session::interaction::COMPOSER)
    };
    app.terminal_view_mut().selection.clear();
    app.terminal_view_mut().scroll.reset();
    app.keybindings.cancel_chord();
}

fn execute_open_keyboard_shortcuts(app: &mut WorkbenchApplication) {
    app.remote_connection_picker.dismiss();
    app.dismiss_remote_connection_manager();
    app.dismiss_remote_tunnel_manager();
    app.quick_access.open_shortcuts();
    app.settings.reset_keyboard_shortcut_recording();
    app.pending_focus = Some(ash_settings::KEYBOARD_SHORTCUTS_SEARCH);
    app.keybindings.cancel_chord();
}

fn execute_manage_remote_tunnels(app: &mut WorkbenchApplication) {
    if app.remote_tunnel_host.is_none() {
        eprintln!("Remote tunnels are available only in a Remote app window");
        app.keybindings.cancel_chord();
        return;
    }
    let restore_focus = app.ui_dispatch.focused();
    app.quick_access.close();
    app.settings.reset_keyboard_shortcut_recording();
    app.activate_session_workbench_tab();
    app.open_remote_tunnel_manager(restore_focus);
    app.keybindings.cancel_chord();
}

fn execute_toggle_files_pane(app: &mut WorkbenchApplication) {
    if app.main_surface.is_editor() {
        app.show_agent_pane();
        app.workbench.collapse_inspector();
        app.pending_focus = Some(ash_session::interaction::COMPOSER);
        return;
    }
    match app.active_main_pane_kind() {
        Some(crate::PaneInputKind::Files) => app.show_agent_pane(),
        Some(crate::PaneInputKind::Diff) => {
            if app.files_pane_expanded {
                app.files_pane_expanded = false;
            } else {
                app.show_files_pane();
            }
        }
        _ => app.show_files_pane(),
    }
}

fn execute_add_session(app: &mut WorkbenchApplication) {
    app.add_session();
}

fn execute_show_agent_changes(app: &mut WorkbenchApplication) {
    app.show_changes_pane();
}

fn execute_show_agent_files(app: &mut WorkbenchApplication) {
    app.show_files_pane();
}

fn execute_refresh_agent_files(app: &mut WorkbenchApplication) {
    if let Err(error) = app.refresh_git_from_app_server() {
        eprintln!("could not refresh Git snapshot: {error}");
    }
    app.refresh_files_from_app_server();
}

fn execute_toggle_agent_file_search(app: &mut WorkbenchApplication) {
    let visible = !app.files.search_visible();
    app.files.set_search_visible(visible);
    if visible {
        app.rebuild_presentation();
        if let Some(presentation) = app.presentation.as_ref() {
            let _ = app.ui_dispatch.focus_element(
                presentation.interaction_frame(),
                ash_files::FILE_SEARCH_INPUT,
            );
        }
    }
}

fn execute_tab_context_menu_action(app: &mut WorkbenchApplication, command: AppCommandId) {
    debug_assert!(matches!(
        command,
        AppCommandId::PinSession
            | AppCommandId::CloseSession
            | AppCommandId::RenameSession
            | AppCommandId::GroupSession
            | AppCommandId::ForkSession
    ));
    let target_tab = app
        .workbench
        .tab_context_menu()
        .target_tab()
        .cloned()
        .or_else(|| {
            app.workbench
                .workbench()
                .sidebar_part()
                .active_tab_key()
                .cloned()
        });
    app.dismiss_tab_context_menu();
    if command == AppCommandId::CloseSession {
        if let Some(target_tab) = target_tab {
            let _ = app.close_workbench_tab(&target_tab);
        }
        return;
    }
    if command == AppCommandId::PinSession {
        if let Some(target_tab) = target_tab {
            let _ = app.workbench.toggle_tab_pin(&target_tab);
            app.rebuild_presentation_on_next_redraw();
        }
        return;
    }
    if command == AppCommandId::GroupSession
        && let Some(target_tab) = target_tab
    {
        let _ = app
            .workbench
            .move_tab_to_new_group(&target_tab, "New group");
        app.rebuild_presentation_on_next_redraw();
    }
}

fn execute_pick_execution_location(app: &mut WorkbenchApplication) {
    app.toggle_remote_connection_picker();
}

fn execute_pick_working_directory(app: &mut WorkbenchApplication) {
    app.toggle_directory_picker();
}

fn execute_pick_git_branch(app: &mut WorkbenchApplication) {
    app.toggle_git_branch_picker();
}

fn execute_show_git_diff(app: &mut WorkbenchApplication) {
    if let Err(error) = app.refresh_git_from_app_server() {
        eprintln!("could not refresh Git snapshot: {error}");
    }
    app.show_changes_pane();
}

fn execute_split_terminal_horizontal(app: &mut WorkbenchApplication) {
    app.split_active_pane(PaneSplitDirection::Horizontal);
}

fn execute_split_terminal_vertical(app: &mut WorkbenchApplication) {
    app.split_active_pane(PaneSplitDirection::Vertical);
}

fn execute_focus_next_pane(app: &mut WorkbenchApplication) {
    app.focus_next_pane();
}

fn execute_focus_previous_pane(app: &mut WorkbenchApplication) {
    app.focus_previous_pane();
}

fn execute_close_pane(app: &mut WorkbenchApplication) {
    app.close_active_pane();
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
