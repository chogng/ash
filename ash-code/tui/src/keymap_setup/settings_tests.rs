use std::collections::BTreeMap;

use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use serde_json::json;

use super::KeymapEdit;
use super::KeymapEditIntent;
use super::KeymapEditKind;
use super::edited_document;
use super::settings_from_tui;
use crate::keymap::AppKeymapAction;
use crate::keymap::AppKeymapContext;

fn context() -> AppKeymapContext {
    AppKeymapContext {
        accepts_input: true,
        has_selection: false,
        chat_input_empty: true,
        is_press: true,
    }
}

#[test]
fn configured_rules_replace_user_keybindings() {
    let section = FrontendConfigDto(BTreeMap::from([(
        "keybindings".into(),
        json!([{
            "key": "ctrl+y",
            "command": "ashCode.action.copyLastResponse"
        }]),
    )]));

    let settings = settings_from_tui(&section).unwrap();

    assert_eq!(
        settings.keymap.resolve_single(
            &KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL),
            context(),
        ),
        Some(AppKeymapAction::CopyLastResponse)
    );
}

#[test]
fn missing_keybindings_restore_builtins_without_user_rules() {
    let settings = settings_from_tui(&FrontendConfigDto::default()).unwrap();

    assert_eq!(
        settings.keymap.resolve_single(
            &KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL),
            context(),
        ),
        None
    );
}

#[test]
fn shortcut_edit_preserves_unrelated_rules() {
    let document = json!([{
        "key": "ctrl+x",
        "command": "ashCode.action.cycleApprovalMode"
    }]);
    let edit = KeymapEdit {
        expected_revision: 7,
        command_id: "ashCode.action.copyLastResponse".into(),
        kind: KeymapEditKind::Set {
            key: "ctrl+y".into(),
            intent: KeymapEditIntent::AddAlternate,
        },
    };

    let (edited, notice) = edited_document(document, &edit).unwrap();

    assert_eq!(notice, "Added user shortcut `ctrl+y`.");
    assert_eq!(edited.as_array().unwrap().len(), 2);
    let section = FrontendConfigDto(BTreeMap::from([("keybindings".into(), edited)]));
    let settings = settings_from_tui(&section).unwrap();
    assert_eq!(
        settings.keymap.resolve_single(
            &KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL),
            context(),
        ),
        Some(AppKeymapAction::CopyLastResponse)
    );
}

#[test]
fn invalid_keybinding_root_and_rules_are_rejected() {
    for keybindings in [json!({}), json!([{"key": "ctrl+k escape", "block": true}])] {
        let section = FrontendConfigDto(BTreeMap::from([("keybindings".into(), keybindings)]));
        assert!(settings_from_tui(&section).is_err());
    }
}

#[test]
fn explicit_block_represents_a_toml_blocker() {
    let section = FrontendConfigDto(BTreeMap::from([(
        "keybindings".into(),
        json!([{"key": "ctrl+o", "block": true}]),
    )]));

    assert!(settings_from_tui(&section).is_ok());
}
