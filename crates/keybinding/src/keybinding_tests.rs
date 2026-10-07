use super::BindingPriority;
use super::BindingSet;
use super::BindingSource;
use super::Chord;
use super::HostPlatform;
use super::KeySequence;
use super::KeySequenceError;
use super::KeyStroke;
use super::KeybindingParseError;
use super::KeybindingResolver;
use super::LogicalKey;
use super::Modifiers;
use super::PhysicalKey;
use super::ResolveResult;
use super::ShortcutModifiers;
use super::format_key_sequence;
use super::keycap_labels;
use super::parse_key_sequence;
use super::serialize_key_sequence;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command {
    Builtin,
    User,
    Chord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Condition {
    Always,
    Editor,
}

#[derive(Clone, Copy)]
struct Context {
    editor: bool,
}

#[test]
fn resolves_portable_modifiers_and_logical_or_physical_identity() {
    let logical = KeySequence::single(
        Chord::logical("p", ShortcutModifiers::primary()).expect("logical key"),
    );
    let physical = KeySequence::single(
        Chord::physical("KeyP", ShortcutModifiers::control()).expect("physical key"),
    );
    let mut bindings = BindingSet::default();
    bindings.register_command(
        logical,
        Command::Builtin,
        Condition::Always,
        BindingSource::Builtin,
        BindingPriority::NORMAL,
    );
    bindings.register_command(
        physical,
        Command::User,
        Condition::Always,
        BindingSource::Builtin,
        BindingPriority::new(1),
    );
    let event = KeyStroke::new(
        LogicalKey::new("P").expect("logical event key"),
        PhysicalKey::new("KeyP"),
        Modifiers::none().with_control(),
    );

    let result = resolver(&bindings, HostPlatform::Windows).resolve(
        &Context { editor: false },
        &[event],
        condition_matches,
    );

    assert!(matches!(
        result,
        ResolveResult::Command {
            command: Command::User,
            ..
        }
    ));
}

#[test]
fn user_rules_and_latest_registration_win_deterministically() {
    let binding = || {
        KeySequence::single(Chord::logical("p", ShortcutModifiers::control()).expect("logical key"))
    };
    let mut bindings = BindingSet::default();
    bindings.register_command(
        binding(),
        Command::Builtin,
        Condition::Always,
        BindingSource::Builtin,
        BindingPriority::NORMAL,
    );
    bindings.register_command(
        binding(),
        Command::User,
        Condition::Editor,
        BindingSource::User,
        BindingPriority::NORMAL,
    );
    let event = control_key("p");

    let inactive = resolver(&bindings, HostPlatform::Linux).resolve(
        &Context { editor: false },
        std::slice::from_ref(&event),
        condition_matches,
    );
    assert!(matches!(
        inactive,
        ResolveResult::Command {
            command: Command::Builtin,
            ..
        }
    ));

    let active = resolver(&bindings, HostPlatform::Linux).resolve(
        &Context { editor: true },
        &[event],
        condition_matches,
    );
    assert!(matches!(
        active,
        ResolveResult::Command {
            command: Command::User,
            ..
        }
    ));
}

#[test]
fn blocker_consumes_a_binding_and_chords_report_pending_state() {
    let first = Chord::logical("k", ShortcutModifiers::control()).expect("first chord");
    let second = Chord::logical("c", ShortcutModifiers::control()).expect("second chord");
    let chord = KeySequence::new(vec![first.clone(), second]).expect("key sequence");
    let mut bindings = BindingSet::default();
    bindings.register_command(
        chord,
        Command::Chord,
        Condition::Always,
        BindingSource::Builtin,
        BindingPriority::NORMAL,
    );
    bindings.register_blocker(
        KeySequence::single(first),
        Condition::Editor,
        BindingSource::User,
        BindingPriority::NORMAL,
    );

    let pending = resolver(&bindings, HostPlatform::Linux).resolve(
        &Context { editor: false },
        &[control_key("k")],
        condition_matches,
    );
    assert!(matches!(pending, ResolveResult::PendingChord { .. }));

    let blocked = resolver(&bindings, HostPlatform::Linux).resolve(
        &Context { editor: true },
        &[control_key("k")],
        condition_matches,
    );
    assert!(matches!(blocked, ResolveResult::Blocked { .. }));
}

#[test]
fn rejects_empty_or_oversized_sequences() {
    assert_eq!(KeySequence::new(Vec::new()), Err(KeySequenceError::Empty));
    let chords = (0..5)
        .map(|_| Chord::logical("x", ShortcutModifiers::none()).expect("logical key"))
        .collect();
    assert_eq!(
        KeySequence::new(chords),
        Err(KeySequenceError::TooManyChords {
            maximum: 4,
            actual: 5,
        })
    );
}

#[test]
fn parses_portable_logical_and_physical_chords() {
    let sequence = parse_key_sequence("primary+k ctrl+shift+[KeyC]").expect("keybinding");
    assert_eq!(sequence.chords().len(), 2);
    assert_eq!(
        format_key_sequence(&sequence, HostPlatform::MacOs),
        "⌘+K ⌃+⇧+[KeyC]"
    );
    assert_eq!(
        format_key_sequence(&sequence, HostPlatform::Linux),
        "Ctrl+K Ctrl+Shift+[KeyC]"
    );
    assert_eq!(
        keycap_labels(&sequence, HostPlatform::MacOs),
        vec![
            vec!["⌘".to_owned(), "K".to_owned()],
            vec!["⌃".to_owned(), "⇧".to_owned(), "[KeyC]".to_owned()],
        ]
    );
    assert_eq!(
        serialize_key_sequence(&sequence),
        "primary+k ctrl+shift+[KeyC]"
    );
}

#[test]
fn rejects_ambiguous_or_incomplete_chords() {
    assert_eq!(
        parse_key_sequence("primary+ctrl+k"),
        Err(KeybindingParseError::ConflictingPortableModifier { chord: 1 })
    );
    assert_eq!(
        parse_key_sequence("ctrl+shift"),
        Err(KeybindingParseError::MissingKey { chord: 1 })
    );
    assert!(matches!(
        parse_key_sequence("ctrl+k+c"),
        Err(KeybindingParseError::MultipleKeys { chord: 1 })
    ));
}

#[test]
fn normalizes_space_and_portable_modifier_aliases() {
    let sequence = parse_key_sequence("cmdorctrl+space windows+k").expect("keybinding");

    assert_eq!(serialize_key_sequence(&sequence), "primary+space meta+k");
}

fn resolver<C, A>(
    bindings: &BindingSet<C, A>,
    platform: HostPlatform,
) -> KeybindingResolver<'_, C, A> {
    KeybindingResolver::new(bindings, platform)
}

fn condition_matches(condition: &Condition, context: &Context) -> bool {
    match condition {
        Condition::Always => true,
        Condition::Editor => context.editor,
    }
}

fn control_key(key: &str) -> KeyStroke {
    KeyStroke::new(
        LogicalKey::new(key).expect("logical event key"),
        None,
        Modifiers::none().with_control(),
    )
}
