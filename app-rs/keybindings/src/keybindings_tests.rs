use std::time::Duration;
use std::time::Instant;

use ash_keybinding::BindingPriority;
use ash_keybinding::BindingSet;
use ash_keybinding::BindingSource;
use ash_keybinding::Chord;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::KeyStroke;
use ash_keybinding::Modifiers;
use serde_json::json;

use super::KeybindingCatalog;
use super::KeybindingResolution;
use super::Keybindings;
use super::UserBinding;
use super::UserBindingTarget;
use super::compile_user_bindings;
use super::edited_user_bindings;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command {
    Toggle,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Condition {
    Always,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Context;

struct Catalog;

impl KeybindingCatalog for Catalog {
    type Command = Command;
    type Condition = Condition;
    type Context = Context;

    fn builtin_bindings(_platform: HostPlatform) -> BindingSet<Self::Condition, Self::Command> {
        let mut bindings = BindingSet::default();
        bindings.register_command(
            KeySequence::single(
                Chord::logical("k", ash_keybinding::ShortcutModifiers::control()).expect("key"),
            ),
            Command::Toggle,
            Condition::Always,
            BindingSource::Builtin,
            BindingPriority::NORMAL,
        );
        bindings
    }

    fn default_keybinding(_command: Self::Command) -> Option<&'static KeySequence> {
        None
    }

    fn command_id(_command: Self::Command) -> &'static str {
        "test.toggle"
    }

    fn command_from_id(id: &str) -> Option<Self::Command> {
        (id == "test.toggle").then_some(Command::Toggle)
    }

    fn parse_condition(source: Option<&str>) -> Result<Self::Condition, String> {
        match source {
            None => Ok(Condition::Always),
            Some("always") => Ok(Condition::Always),
            Some(source) => Err(format!("unknown condition `{source}`")),
        }
    }

    fn condition_matches(_condition: &Self::Condition, _context: &Self::Context) -> bool {
        true
    }
}

#[test]
fn resolves_builtin_and_user_chord_rules() {
    let mut keybindings = Keybindings::<Catalog>::for_platform(HostPlatform::Linux);
    let context = Context;
    assert_eq!(
        keybindings.resolve_stroke_at(
            &stroke("k", Modifiers::none().with_control()),
            &context,
            Instant::now(),
        ),
        KeybindingResolution::Command(Command::Toggle)
    );

    keybindings.replace_user_bindings(vec![UserBinding {
        keybinding: ash_keybinding::parse_key_sequence("ctrl+x ctrl+c").expect("chord"),
        target: UserBindingTarget::Command(Command::Toggle),
        when: Condition::Always,
        when_source: None,
    }]);
    let now = Instant::now();
    assert_eq!(
        keybindings.resolve_stroke_at(
            &stroke("x", Modifiers::none().with_control()),
            &context,
            now,
        ),
        KeybindingResolution::Consumed
    );
    assert_eq!(
        keybindings.resolve_stroke_at(
            &stroke("c", Modifiers::none().with_control()),
            &context,
            now + Duration::from_millis(100),
        ),
        KeybindingResolution::Command(Command::Toggle)
    );
}

#[test]
fn rejected_config_does_not_replace_the_previous_rule_set() {
    let now = Instant::now();
    let mut keybindings = Keybindings::<Catalog>::default();
    let rules = compile_user_bindings::<Catalog>(
        Some(&json!([{"key":"ctrl+x","command":"test.toggle"}])),
        HostPlatform::Linux,
    )
    .expect("valid config");
    keybindings.replace_user_bindings(rules);
    assert!(compile_user_bindings::<Catalog>(Some(&json!({})), HostPlatform::Linux).is_err());
    let context = Context;
    assert_eq!(
        keybindings.resolve_stroke_at(
            &stroke("x", Modifiers::none().with_control()),
            &context,
            now + Duration::from_secs(1),
        ),
        KeybindingResolution::Command(Command::Toggle)
    );
}

#[test]
fn recorder_edit_replaces_only_the_commands_rules() {
    let existing = json!([
        {"key":"ctrl+b","command":"test.toggle"},
        {"key":"ctrl+x","block":true}
    ]);
    let sequence = ash_keybinding::parse_key_sequence("primary+k primary+b").unwrap();

    let edited = edited_user_bindings::<Catalog>(
        Some(&existing),
        Command::Toggle,
        &sequence,
        HostPlatform::Linux,
    )
    .expect("valid edit");

    assert_eq!(edited.as_array().unwrap().len(), 2);
    assert_eq!(edited[0], json!({"key":"ctrl+x","block":true}));
    assert_eq!(edited[1]["key"], "primary+k primary+b");
}

fn stroke(key: &str, modifiers: Modifiers) -> KeyStroke {
    KeyStroke::new(
        ash_keybinding::LogicalKey::new(key).expect("logical key"),
        None,
        modifiers,
    )
}
