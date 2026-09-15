use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

use super::KeymapCaptureOutcome;
use super::keymap_capture;
use crate::keymap::AppKeymap;
use crate::keymap_setup::KeymapCaptureMode;
use crate::keymap_setup::KeymapEditIntent;
use crate::keymap_setup::KeymapEditKind;
use crate::render::test_context;
use crate::widgets::list_selection::ListSelectionState;
use ash_keybinding::HostPlatform;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

fn copy_action() -> crate::keymap::KeymapActionSnapshot {
    AppKeymap::default()
        .setup_actions()
        .into_iter()
        .find(|action| action.command_id == "ashCode.action.copyLastResponse")
        .unwrap()
}

#[test]
fn chord_capture_waits_for_two_strokes_and_emits_canonical_edit() {
    let mut capture = keymap_capture(
        copy_action(),
        4,
        KeymapEditIntent::AddAlternate,
        KeymapCaptureMode::Chord,
    );

    assert!(matches!(
        capture.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL,)),
        KeymapCaptureOutcome::Pending
    ));
    let KeymapCaptureOutcome::Edit(edit) =
        capture.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL))
    else {
        panic!("expected completed chord edit");
    };

    assert_eq!(edit.expected_revision, 4);
    assert_eq!(edit.command_id, "ashCode.action.copyLastResponse");
    assert_eq!(
        edit.kind,
        KeymapEditKind::Set {
            key: "ctrl+k ctrl+y".into(),
            intent: KeymapEditIntent::AddAlternate,
        }
    );
}

#[test]
fn escape_cancels_capture_without_emitting_an_edit() {
    let mut capture = keymap_capture(
        copy_action(),
        1,
        KeymapEditIntent::ReplaceUser,
        KeymapCaptureMode::SingleKey,
    );

    assert!(matches!(
        capture.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        KeymapCaptureOutcome::Cancelled
    ));
}

#[test]
fn keymap_choices_lists_keys_before_responsibilities() {
    let view = super::keymap_choices(AppKeymap::default().setup_actions(), &[], 1);
    let state = ListSelectionState::new(view.model);
    let labels = state
        .visible_items()
        .into_iter()
        .map(|item| item.label())
        .collect::<Vec<_>>();

    assert_eq!(
        labels,
        vec![
            "shift+tab",
            "unbound",
            "ctrl+v",
            "ctrl+c",
            "ctrl+d",
            "ctrl+o",
            "ctrl+z",
            "ctrl+r",
            "Esc Esc",
            "↑/k · ↓/j",
            "Home/End · PageUp/PageDown",
            "/",
            "Tab/Shift+Tab",
            "Esc",
        ]
    );
}

#[test]
fn shortcut_rows_align_responsibility_and_source_columns_without_command_ids() {
    let rules = crate::keymap::compile_app_user_bindings(
        &serde_json::json!([{"key":"ctrl+y","command":"ashCode.action.copyLastResponse"}]),
        HostPlatform::Linux,
    )
    .unwrap();
    let mut keymap = AppKeymap::default();
    keymap.replace_user_bindings(rules).unwrap();
    let view = super::keymap_choices(keymap.setup_actions(), &[], 1);
    let state = ListSelectionState::new(view.model);
    let backend = TestBackend::new(100, 20);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| {
            crate::widgets::list_selection::draw_body_with_pointer(
                frame,
                crate::render::horizontal_margin(frame.area(), 2),
                &state,
                false,
                false,
                None,
                None,
                test_context(),
            )
        })
        .unwrap();

    let buffer = terminal.backend().buffer();
    let rows = (0..20)
        .map(|row| {
            (0..100)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let default_row = rows.iter().find(|row| row.contains("ctrl+o")).unwrap();
    let user_row = rows.iter().find(|row| row.contains("ctrl+y")).unwrap();
    let fixed_row = rows.iter().find(|row| row.contains("Esc Esc")).unwrap();

    let responsibility_column = default_row.find("Copy last response").unwrap();
    assert_eq!(
        user_row.find("Copy last response"),
        Some(responsibility_column)
    );
    assert_eq!(
        fixed_row.find("open rewind checkpoints"),
        Some(responsibility_column)
    );
    assert_eq!(default_row.find("default"), fixed_row.find("default"));
    assert_eq!(user_row.find("user"), default_row.find("default"));
    assert!(!rows.join("\n").contains("ashCode."));
    assert!(!rows.join("\n").contains("Built in"));
}

#[test]
fn capture_records_navigation_letters_instead_of_interpreting_them() {
    for character in ['j', 'k', '/', 'i', 'p'] {
        let mut capture = keymap_capture(
            copy_action(),
            4,
            KeymapEditIntent::AddAlternate,
            KeymapCaptureMode::SingleKey,
        );
        let KeymapCaptureOutcome::Edit(edit) =
            capture.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE))
        else {
            panic!("expected a captured key");
        };
        assert!(
            matches!(edit.kind, KeymapEditKind::Set { key, .. } if key == character.to_string())
        );
    }
}
