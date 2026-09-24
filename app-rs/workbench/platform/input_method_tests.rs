use super::{
    InputMethodContext, InputMethodTarget, encode_terminal_ime_event, text_input_composition_event,
};
use crate::MainSurfaceKind;
use ash_settings::RemoteConnectionManagerField;
use ash_terminal::{GridSize, TerminalCore};
use zui::input::Ime;
use zui::ui::{TextInputCompositionCursor, TextInputCompositionEvent};

#[test]
fn target_requires_an_active_window_and_the_appropriate_editable_surface() {
    let composer = InputMethodContext {
        window_active: true,
        main_surface: MainSurfaceKind::Agent,
        composer_focused: true,
        file_editor_focused: false,
        file_editor_find_focused: false,
        file_editor_replace_focused: false,
        session_search_focused: false,
        tab_rename_focused: false,
        file_search_focused: false,
        commit_message_focused: false,
        git_branch_search_focused: false,
        path_search_focused: false,
        remote_connection_search_focused: false,
        remote_connection_manager_field: None,
        remote_tunnel_port_focused: false,
        keyboard_shortcuts_search_focused: false,
        settings_search_focused: false,
    };
    let toolbar = InputMethodContext {
        composer_focused: false,
        ..composer
    };
    let terminal_grid = InputMethodContext {
        main_surface: MainSurfaceKind::Terminal,
        composer_focused: false,
        ..composer
    };
    let file_editor = InputMethodContext {
        main_surface: MainSurfaceKind::Editor,
        file_editor_focused: true,
        composer_focused: false,
        ..composer
    };
    let file_editor_find = InputMethodContext {
        main_surface: MainSurfaceKind::Editor,
        file_editor_find_focused: true,
        composer_focused: false,
        ..composer
    };
    let file_editor_replace = InputMethodContext {
        main_surface: MainSurfaceKind::Editor,
        file_editor_replace_focused: true,
        composer_focused: false,
        ..composer
    };
    let session_search = InputMethodContext {
        session_search_focused: true,
        ..terminal_grid
    };
    let tab_rename = InputMethodContext {
        tab_rename_focused: true,
        ..terminal_grid
    };
    let file_search = InputMethodContext {
        file_search_focused: true,
        ..terminal_grid
    };
    let commit_message = InputMethodContext {
        commit_message_focused: true,
        ..terminal_grid
    };
    let git_branch_search = InputMethodContext {
        git_branch_search_focused: true,
        ..terminal_grid
    };
    let path_search = InputMethodContext {
        path_search_focused: true,
        ..terminal_grid
    };
    let remote_connection_search = InputMethodContext {
        remote_connection_search_focused: true,
        ..terminal_grid
    };
    let settings_search = InputMethodContext {
        settings_search_focused: true,
        ..terminal_grid
    };
    let keyboard_shortcuts_search = InputMethodContext {
        keyboard_shortcuts_search_focused: true,
        ..terminal_grid
    };
    let remote_connection_dir = InputMethodContext {
        remote_connection_manager_field: Some(RemoteConnectionManagerField::Directory),
        ..terminal_grid
    };
    let remote_tunnel_port = InputMethodContext {
        remote_tunnel_port_focused: true,
        ..terminal_grid
    };
    let inactive_window = InputMethodContext {
        window_active: false,
        ..composer
    };

    assert_eq!(
        InputMethodTarget::for_context(composer),
        InputMethodTarget::Composer
    );
    assert_eq!(
        InputMethodTarget::for_context(toolbar),
        InputMethodTarget::Disabled
    );
    assert_eq!(
        InputMethodTarget::for_context(terminal_grid),
        InputMethodTarget::TerminalGrid
    );
    assert_eq!(
        InputMethodTarget::for_context(file_editor),
        InputMethodTarget::FileEditor
    );
    assert_eq!(
        InputMethodTarget::for_context(file_editor_find),
        InputMethodTarget::FileEditorFind
    );
    assert_eq!(
        InputMethodTarget::for_context(file_editor_replace),
        InputMethodTarget::FileEditorReplace
    );
    assert_eq!(
        InputMethodTarget::for_context(session_search),
        InputMethodTarget::SessionSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(tab_rename),
        InputMethodTarget::TabRename
    );
    assert_eq!(
        InputMethodTarget::for_context(file_search),
        InputMethodTarget::FileSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(commit_message),
        InputMethodTarget::CommitMessage
    );
    assert_eq!(
        InputMethodTarget::for_context(git_branch_search),
        InputMethodTarget::GitBranchSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(path_search),
        InputMethodTarget::DirectoryPathSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(remote_connection_search),
        InputMethodTarget::RemoteConnectionSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(remote_connection_dir),
        InputMethodTarget::RemoteConnectionDirectory
    );
    assert_eq!(
        InputMethodTarget::for_context(remote_tunnel_port),
        InputMethodTarget::RemoteTunnelPort
    );
    assert_eq!(
        InputMethodTarget::for_context(settings_search),
        InputMethodTarget::SettingsSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(keyboard_shortcuts_search),
        InputMethodTarget::KeyboardShortcutsSearch
    );
    assert_eq!(
        InputMethodTarget::for_context(inactive_window),
        InputMethodTarget::Disabled
    );
}

#[test]
fn composer_conversion_preserves_preedit_cursor_and_commit_boundaries() {
    assert_eq!(
        text_input_composition_event(Ime::Preedit("你好".to_owned(), Some((0, 3)))),
        Some(TextInputCompositionEvent::Preedit {
            text: "你好".to_owned(),
            cursor: TextInputCompositionCursor::Visible(0..3),
        })
    );
    assert_eq!(
        text_input_composition_event(Ime::Preedit("世界".to_owned(), None)),
        Some(TextInputCompositionEvent::Preedit {
            text: "世界".to_owned(),
            cursor: TextInputCompositionCursor::Hidden,
        })
    );
    assert_eq!(
        text_input_composition_event(Ime::Commit("完成".to_owned())),
        Some(TextInputCompositionEvent::Commit("完成".to_owned()))
    );
    assert_eq!(
        text_input_composition_event(Ime::Disabled),
        Some(TextInputCompositionEvent::Cancel)
    );
    assert_eq!(text_input_composition_event(Ime::Enabled), None);
}

#[test]
fn terminal_grid_forwards_only_committed_ime_text() {
    let terminal = TerminalCore::new(GridSize::new(24, 80));

    assert_eq!(
        encode_terminal_ime_event(&terminal, &Ime::Commit("终端".to_owned())),
        "终端".as_bytes().to_vec()
    );
    assert!(encode_terminal_ime_event(&terminal, &Ime::Preedit("终".to_owned(), None)).is_empty());
    assert!(encode_terminal_ime_event(&terminal, &Ime::Disabled).is_empty());
}
