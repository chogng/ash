use crate::{
    SlashCommandArgumentMode, SlashCommandCatalog, SlashCommandDefinition, SlashCommandInput,
};

fn catalog() -> SlashCommandCatalog {
    SlashCommandCatalog::new([
        SlashCommandDefinition {
            name: "model".into(),
            description: "select a model".into(),
            argument_mode: SlashCommandArgumentMode::Optional,
            argument_hint: Some("<model>".into()),
        },
        SlashCommandDefinition {
            name: "status".into(),
            description: "show status".into(),
            argument_mode: SlashCommandArgumentMode::None,
            argument_hint: None,
        },
    ])
    .unwrap()
}

#[test]
fn query_completion_and_submission_share_one_grammar() {
    let catalog = catalog();
    let input = SlashCommandInput::at_cursor("/mo", 3, &catalog);
    let matches = input.matching_commands().unwrap();
    assert_eq!(matches.len(), 1);
    let completion = input.completion(&matches[0]).unwrap();
    assert_eq!(completion.range, 0..3);
    assert_eq!(completion.replacement, "/model ");

    let invocation = SlashCommandInput::for_submission("/model provider/name", &catalog)
        .invocation()
        .unwrap();
    assert_eq!(invocation.command.name, "model");
    assert_eq!(
        &"/model provider/name"[invocation.arguments_range],
        "provider/name"
    );
}

#[test]
fn commands_without_arguments_reject_extra_text() {
    let catalog = catalog();
    assert!(
        SlashCommandInput::for_submission("/status now", &catalog)
            .invocation()
            .is_none()
    );
    assert!(
        SlashCommandInput::for_submission(" /status", &catalog)
            .invocation()
            .is_none()
    );
}

#[test]
fn unknown_command_name_uses_the_submission_grammar() {
    let catalog = catalog();
    assert_eq!(
        SlashCommandInput::for_submission("/modle now", &catalog).unknown_command_name(),
        Some("modle")
    );
    assert_eq!(
        SlashCommandInput::for_submission("/model now", &catalog).unknown_command_name(),
        None
    );
    assert_eq!(
        SlashCommandInput::for_submission("/", &catalog).unknown_command_name(),
        None
    );
    assert_eq!(
        SlashCommandInput::for_submission(" /modle", &catalog).unknown_command_name(),
        None
    );
}

#[test]
fn argument_hint_is_offered_only_after_command_with_empty_arguments() {
    let catalog = catalog();
    let input = SlashCommandInput::at_cursor("/model ", 7, &catalog);
    assert_eq!(input.argument_hint(), Some("<model>"));

    let input = SlashCommandInput::at_cursor("/model   ", 9, &catalog);
    assert_eq!(input.argument_hint(), Some("<model>"));

    let input = SlashCommandInput::at_cursor("/model", 6, &catalog);
    assert_eq!(input.argument_hint(), None);

    let input = SlashCommandInput::at_cursor("/model claude", 13, &catalog);
    assert_eq!(input.argument_hint(), None);

    let input = SlashCommandInput::at_cursor("/model ", 3, &catalog);
    assert_eq!(input.argument_hint(), None);

    let input = SlashCommandInput::at_cursor("/status ", 8, &catalog);
    assert_eq!(input.argument_hint(), None);
}
