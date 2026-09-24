use super::ImePurpose;
use super::WindowButtons;

#[test]
fn window_button_policy_retains_each_independent_control() {
    let buttons = WindowButtons::NONE
        .with_close(true)
        .with_minimize(false)
        .with_maximize(true);

    assert!(buttons.close());
    assert!(!buttons.minimize());
    assert!(buttons.maximize());
    assert_eq!(WindowButtons::from_native(buttons.into_native()), buttons);
    assert_eq!(WindowButtons::default(), WindowButtons::ALL);
}

#[test]
fn ime_purpose_maps_without_exporting_the_native_enum() {
    assert_eq!(
        ImePurpose::Terminal.into_native(),
        winit::window::ImePurpose::Terminal
    );
}
