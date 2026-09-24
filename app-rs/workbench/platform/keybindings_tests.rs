use super::{
    WorkbenchBindingCondition, WorkbenchKeybindingContext, WorkbenchKeybindingFacts,
    WorkbenchKeybindingResolution, WorkbenchKeybindings, WorkbenchUserBinding,
    WorkbenchUserBindingTarget,
};
use ash_commands::AppCommandId;
use ash_keybinding::{
    ContextExpression, HostPlatform, KeyStroke, LogicalKey, Modifiers, parse_key_sequence,
};
use std::time::{Duration, Instant};

#[test]
fn text_inputs_use_portable_copy_and_paste() {
    let mut bindings = WorkbenchKeybindings::for_platform(HostPlatform::Linux);

    assert_eq!(
        bindings.resolve_stroke(
            &stroke("c", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::Copy)
    );
    assert_eq!(
        bindings.resolve_stroke(
            &stroke("v", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::Paste)
    );
    assert_eq!(
        bindings.resolve_stroke(
            &stroke("c", Modifiers::none().with_control().with_shift()),
            &WorkbenchKeybindingContext::text_input(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::Copy)
    );
}

#[test]
fn workspace_save_is_available_independently_from_the_focused_surface() {
    let mut bindings = WorkbenchKeybindings::for_platform(HostPlatform::Linux);

    assert_eq!(
        bindings.resolve_stroke(
            &stroke("s", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::direct_terminal(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::Save)
    );
}

#[test]
fn direct_terminal_preserves_unshifted_control_keys() {
    let mut bindings = WorkbenchKeybindings::for_platform(HostPlatform::Linux);

    assert_eq!(
        bindings.resolve_stroke(
            &stroke("c", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::direct_terminal(),
        ),
        WorkbenchKeybindingResolution::NoMatch
    );
    assert_eq!(
        bindings.resolve_stroke(
            &stroke("c", Modifiers::none().with_control().with_shift()),
            &WorkbenchKeybindingContext::direct_terminal(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::Copy)
    );
}

#[test]
fn macos_direct_terminal_uses_command_modifier() {
    let mut bindings = WorkbenchKeybindings::for_platform(HostPlatform::MacOs);

    assert_eq!(
        bindings.resolve_stroke(
            &stroke("c", Modifiers::none().with_meta()),
            &WorkbenchKeybindingContext::direct_terminal(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::Copy)
    );
}

#[test]
fn chord_completes_or_expires_as_one_consumed_interaction() {
    let mut bindings = WorkbenchKeybindings::for_platform(HostPlatform::Linux);
    bindings.replace_user_bindings(vec![WorkbenchUserBinding {
        keybinding: parse_key_sequence("ctrl+k ctrl+c").expect("chord"),
        target: WorkbenchUserBindingTarget::Command(AppCommandId::ToggleTabContainer),
        when: WorkbenchBindingCondition::Always,
        when_source: None,
    }]);
    let now = Instant::now();

    assert_eq!(
        bindings.resolve_stroke_at(
            &stroke("k", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
            now,
        ),
        WorkbenchKeybindingResolution::Consumed
    );
    assert_eq!(
        bindings.resolve_stroke_at(
            &stroke("c", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
            now + Duration::from_millis(100),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::ToggleTabContainer)
    );

    assert_eq!(
        bindings.resolve_stroke_at(
            &stroke("k", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
            now + Duration::from_secs(1),
        ),
        WorkbenchKeybindingResolution::Consumed
    );
    assert!(bindings.advance_chord(now + Duration::from_secs(3)));
    assert_eq!(bindings.chord_deadline(), None);

    assert_eq!(
        bindings.resolve_stroke_at(
            &stroke("k", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
            now + Duration::from_secs(4),
        ),
        WorkbenchKeybindingResolution::Consumed
    );
    assert_eq!(
        bindings.resolve_stroke_at(
            &stroke("x", Modifiers::none().with_control()),
            &WorkbenchKeybindingContext::text_input(),
            now + Duration::from_millis(4_100),
        ),
        WorkbenchKeybindingResolution::Consumed
    );
    assert_eq!(bindings.chord_deadline(), None);
}

#[test]
fn desktop_context_exposes_boolean_and_string_facts_to_when_expressions() {
    let mut bindings = WorkbenchKeybindings::for_platform(HostPlatform::Linux);
    bindings.replace_user_bindings(vec![WorkbenchUserBinding {
        keybinding: parse_key_sequence("ctrl+k").expect("binding"),
        target: WorkbenchUserBindingTarget::Command(AppCommandId::ToggleTabContainer),
        when: WorkbenchBindingCondition::Expression(
            ContextExpression::parse(
                "agentSurfaceVisible && composerRoute == 'agent' && !fileSearchVisible",
            )
            .expect("condition"),
        ),
        when_source: Some(
            "agentSurfaceVisible && composerRoute == 'agent' && !fileSearchVisible".to_owned(),
        ),
    }]);
    let context = &WorkbenchKeybindingContext::from_facts(WorkbenchKeybindingFacts {
        direct_terminal: false,
        terminal_surface_visible: false,
        tab_container_visible: false,
        inspector_visible: false,
        file_search_visible: false,
        composer_route: "agent",
    });

    assert_eq!(
        bindings.resolve_stroke_at(
            &stroke("k", Modifiers::none().with_control()),
            context,
            Instant::now(),
        ),
        WorkbenchKeybindingResolution::Command(AppCommandId::ToggleTabContainer)
    );
}

fn stroke(key: &str, modifiers: Modifiers) -> KeyStroke {
    KeyStroke::new(LogicalKey::new(key).expect("logical key"), None, modifiers)
}
