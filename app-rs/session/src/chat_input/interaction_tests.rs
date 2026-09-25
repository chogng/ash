use super::super::ComposerRoute;
use super::ChatInputInteractionState;
use super::ComposerInteractionActivation;
use super::ComposerModelOption;
use super::SelectionDirection;
use ash_protocol::{ModelId, ModelRef, ProviderId};
use ash_slash_commands::SlashCommandArgumentMode;
use ash_slash_commands::SlashCommandDefinition;

fn model_option(provider: &str, model: &str, display_name: &str) -> ComposerModelOption {
    let model = ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    );
    ComposerModelOption {
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

    assert_eq!(model.view().unwrap().items()[0].description(), "");

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
    assert_eq!(model.view().unwrap().selected(), Some(0));
}

#[test]
fn slash_typo_completion_requires_keyboard_selection() {
    let mut model = ChatInputInteractionState::new();
    model
        .set_catalog(
            ["update-config", "config"]
                .into_iter()
                .map(|name| SlashCommandDefinition {
                    name: name.into(),
                    description: format!("open {name}"),
                    argument_mode: SlashCommandArgumentMode::None,
                    argument_hint: None,
                })
                .collect(),
            Vec::new(),
        )
        .unwrap();
    model.sync_input("/cofig", ComposerRoute::Agent);

    let view = model.view().unwrap();
    assert_eq!(
        view.items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        ["/config", "/update-config"]
    );
    assert_eq!(view.selected(), None);
    assert_eq!(model.activate_selected(), None);
    model.move_selection(SelectionDirection::Next);
    assert_eq!(
        model.activate_selected(),
        Some(ComposerInteractionActivation::ComposerText(
            "/config ".into()
        ))
    );
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
