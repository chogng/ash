use std::time::Instant;

use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_commands::AppCommandId;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeyStroke;
use ash_keybinding::LogicalKey;
use ash_keybinding::Modifiers;
use ash_keybinding::parse_key_sequence;
use serde_json::json;
use std::collections::BTreeMap;

use super::binding_diagnostics;
use super::compile_user_bindings;
use super::edited_gui_config;
use crate::keybindings::WorkbenchKeybindingContext;
use crate::keybindings::WorkbenchKeybindingResolution;
use crate::keybindings::WorkbenchKeybindings;

#[test]
fn compiles_platform_overrides_chords_and_blockers() {
    let value = json!([
        {
            "key": "ctrl+k ctrl+c",
            "mac": "primary+k primary+c",
            "command": "workbench.action.toggleTabContainer",
            "when": "textInputFocus && composerRoute == 'agent'"
        },
        {
            "key": "ctrl+v",
            "block": true,
            "when": "terminalFocus"
        }
    ]);

    let rules = compile_user_bindings(Some(&value), HostPlatform::MacOs).expect("valid config");

    assert_eq!(rules.len(), 2);
}

#[test]
fn exact_duplicate_contexts_produce_a_non_fatal_conflict_diagnostic() {
    let value = json!([
        {"key":"ctrl+k","command":"workbench.action.toggleTabContainer","when":"textInputFocus"},
        {"key":"ctrl+k","command":"workbench.action.toggleAuxiliaryBar","when":"textInputFocus"}
    ]);
    let rules =
        compile_user_bindings(Some(&value), HostPlatform::Linux).expect("valid conflicting config");

    let diagnostics = binding_diagnostics(&rules, HostPlatform::Linux);

    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].contains("later rule wins"));
}

#[test]
fn rejects_unknown_commands_fields_context_keys_and_ambiguous_targets() {
    for value in [
        json!([{"key":"ctrl+x","command":"missing.command"}]),
        json!([{"key":"ctrl+x","block":true,"args":[]}]),
        json!([{"key":"ctrl+x","mac":42,"block":true}]),
        json!([{"key":"ctrl+x","block":true,"when":"composerMode == 'agent'"}]),
        json!([{"key":"ctrl+x","command":"workbench.action.toggleTabContainer","block":true}]),
    ] {
        assert!(compile_user_bindings(Some(&value), HostPlatform::Linux).is_err());
    }
}

#[test]
fn user_blocker_consumes_an_otherwise_unmatched_key() {
    let value = json!([{"key":"ctrl+x","block":true,"when":"terminalFocus"}]);
    let rules = compile_user_bindings(Some(&value), HostPlatform::Linux).expect("valid blocker");
    let mut keybindings = WorkbenchKeybindings::for_platform(HostPlatform::Linux);
    keybindings.replace_user_bindings(rules);

    assert_eq!(
        keybindings.resolve_stroke_at(
            &stroke("x"),
            &WorkbenchKeybindingContext::direct_terminal(),
            Instant::now(),
        ),
        WorkbenchKeybindingResolution::Consumed
    );
}

#[test]
fn recorder_edit_preserves_unrelated_gui_fields_and_replaces_the_command() {
    let section = FrontendConfigDto(BTreeMap::from([
        ("theme".into(), json!("system")),
        (
            "keybindings".into(),
            json!([
                {"key":"ctrl+b","command":"workbench.action.toggleTabContainer"},
                {"key":"ctrl+x","block":true}
            ]),
        ),
    ]));
    let sequence = parse_key_sequence("primary+k primary+b").expect("recorded shortcut");

    let edited = edited_gui_config(
        section,
        AppCommandId::ToggleTabContainer,
        &sequence,
        HostPlatform::Linux,
    )
    .expect("save recording");

    assert_eq!(edited.0["theme"], "system");
    assert_eq!(edited.0["keybindings"].as_array().unwrap().len(), 2);
    assert_eq!(
        edited.0["keybindings"][0],
        json!({"key":"ctrl+x","block":true})
    );
    assert_eq!(edited.0["keybindings"][1]["key"], "primary+k primary+b");
}

fn stroke(key: &str) -> KeyStroke {
    KeyStroke::new(
        LogicalKey::new(key).expect("logical key"),
        None,
        Modifiers::none().with_control(),
    )
}
