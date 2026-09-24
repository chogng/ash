use super::super::ComposerRoute;
use super::ChatInputInteractionState;
use super::ComposerInteractionActivation;
use super::ComposerModelOption;
use super::SelectionDirection;
use ash_protocol::{ModelId, ModelRef, ProviderId};

fn model_option(provider: &str, model: &str, display_name: &str) -> ComposerModelOption {
    let model = ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    );
    ComposerModelOption {
        description: format!("{}/{}", model.provider, model.model),
        label: display_name.into(),
        model,
    }
}

#[test]
fn slash_model_pushes_model_picker_and_escape_returns_to_commands() {
    let mut model = ChatInputInteractionState::new();
    model
        .set_catalog(Vec::new(), vec![model_option("openai", "gpt", "GPT")])
        .unwrap();
    model.sync_input("/model", ComposerRoute::Agent);

    assert_eq!(
        model.activate_selected(),
        Some(ComposerInteractionActivation::ViewChanged)
    );
    assert!(model.is_model_picker_visible());
    assert!(model.dismiss("/model"));
    assert!(!model.is_model_picker_visible());
    assert!(model.is_visible());
}

#[test]
fn model_activation_returns_exact_catalog_identity_and_closes() {
    let mut model = ChatInputInteractionState::new();
    let expected = model_option("anthropic", "sonnet", "Sonnet");
    model
        .set_catalog(Vec::new(), vec![expected.clone()])
        .unwrap();
    model.sync_input("/model", ComposerRoute::Agent);
    model.activate_selected();

    assert_eq!(
        model.activate_selected(),
        Some(ComposerInteractionActivation::Model(expected.model))
    );
    assert!(!model.is_visible());
}

#[test]
fn slash_filter_and_keyboard_selection_share_one_visible_list() {
    let mut model = ChatInputInteractionState::new();
    model.sync_input("/mo", ComposerRoute::Agent);
    let view = model.view().unwrap();
    assert_eq!(view.items().len(), 1);
    assert_eq!(view.items()[0].label(), "/model");

    model.move_selection(SelectionDirection::Next);
    assert_eq!(model.view().unwrap().selected(), 0);
}

#[test]
fn dismissed_slash_view_stays_closed_until_chat_input_text_changes() {
    let mut model = ChatInputInteractionState::new();
    model.sync_input("/", ComposerRoute::Agent);
    assert!(model.dismiss("/"));
    model.sync_input("/", ComposerRoute::Agent);
    assert!(!model.is_visible());

    model.sync_input("/m", ComposerRoute::Agent);
    assert!(model.is_visible());
}

#[test]
fn shell_route_closes_agent_interactions() {
    let mut model = ChatInputInteractionState::new();
    model.sync_input("/m", ComposerRoute::Agent);
    assert!(model.is_visible());

    model.sync_input("echo done", ComposerRoute::Shell);

    assert!(!model.is_visible());
}
