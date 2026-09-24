use super::InspectorPartState;

#[test]
fn inspector_is_collapsed_by_default_and_toggles_visibility() {
    let mut inspector = InspectorPartState::default();

    assert!(!inspector.is_expanded());
    inspector.toggle();
    assert!(inspector.is_expanded());
    inspector.toggle();
    assert!(!inspector.is_expanded());
}

#[test]
fn expand_is_idempotent_and_keeps_the_inspector_visible() {
    let mut inspector = InspectorPartState::default();

    inspector.expand();
    inspector.expand();

    assert!(inspector.is_expanded());
}

#[test]
fn preferred_width_is_pure_state_and_rejects_invalid_values() {
    let mut inspector = InspectorPartState::expanded();

    assert_eq!(inspector.preferred_width(), 520.0);
    assert!(inspector.set_preferred_width(640.0));
    assert_eq!(inspector.preferred_width(), 640.0);
    assert!(!inspector.set_preferred_width(640.0));
    assert!(!inspector.set_preferred_width(f32::NAN));
    assert!(!inspector.set_preferred_width(-1.0));
    assert_eq!(inspector.preferred_width(), 640.0);
}
