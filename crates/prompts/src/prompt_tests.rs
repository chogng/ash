use super::*;

const TEST_PROMPT: PromptArtifact = PromptArtifact::new(
    "test-owner",
    "test/example",
    "test-example-v1",
    "Hello, {{ name }}.\n",
);

#[test]
fn preserves_owner_identity_revision_and_body() {
    assert_eq!(TEST_PROMPT.owner(), "test-owner");
    assert_eq!(TEST_PROMPT.id(), "test/example");
    assert_eq!(TEST_PROMPT.revision(), "test-example-v1");
    assert_eq!(TEST_PROMPT.body(), "Hello, {{ name }}.\n");
}

#[test]
fn rendered_body_remains_bound_to_its_source() {
    let rendered = TEST_PROMPT.render("Hello, Ash.\n".into());

    assert_eq!(rendered.source(), TEST_PROMPT);
    assert_eq!(rendered.body(), "Hello, Ash.\n");
}

#[test]
fn freezes_exact_asset_metadata_and_body_for_a_turn() {
    let instructions = TEST_PROMPT.freeze();

    assert_eq!(instructions.owner(), TEST_PROMPT.owner());
    assert_eq!(instructions.id(), TEST_PROMPT.id());
    assert_eq!(instructions.revision(), TEST_PROMPT.revision());
    assert_eq!(instructions.body(), TEST_PROMPT.body());
}

#[test]
#[should_panic(expected = "prompt owner must not be empty")]
fn rejects_an_empty_owner() {
    let _ = PromptArtifact::new("", "test/example", "test-example-v1", "body");
}
