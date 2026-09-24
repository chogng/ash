use super::Icon;
use super::IconDefinition;
use super::IconId;
use super::IconRendering;

#[test]
fn icon_retains_identity_artwork_and_rendering_contract() {
    let icon = Icon::new(
        IconId::new("test-icon"),
        IconDefinition::symbolic(b"<svg />"),
    );

    assert_eq!(icon.id().as_str(), "test-icon");
    assert_eq!(icon.definition().svg(), b"<svg />");
    assert_eq!(icon.definition().rendering(), IconRendering::Symbolic);
}

#[test]
#[should_panic(expected = "icon ID must be lowercase kebab-case ASCII")]
fn icon_id_rejects_non_kebab_case_values() {
    let _ = IconId::new("Invalid Icon");
}
