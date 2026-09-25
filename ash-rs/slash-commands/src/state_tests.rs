use crate::{
    SlashCommandArgumentMode, SlashCommandCatalog, SlashCommandDefinition, SlashCommandsState,
};

fn command(name: &str) -> SlashCommandDefinition {
    SlashCommandDefinition {
        name: name.into(),
        description: format!("run {name}"),
        argument_mode: SlashCommandArgumentMode::Optional,
        argument_hint: None,
    }
}

#[test]
fn state_owns_matching_selection_dismissal_and_completion() {
    let catalog = SlashCommandCatalog::new([command("model"), command("mcp")]).unwrap();
    let mut state = SlashCommandsState::new(catalog);
    state.sync_input("/m", 2);
    assert_eq!(state.view().unwrap().commands.len(), 2);
    state.select_next();
    assert_eq!(state.selected_command().unwrap().name, "mcp");
    assert_eq!(state.selected_completion().unwrap().replacement, "/mcp ");

    state.dismiss();
    assert!(state.view().is_none());
    state.sync_input("/mo", 3);
    assert_eq!(state.view().unwrap().commands[0].name, "model");
}

#[test]
fn state_direct_selection_only_changes_the_selected_command() {
    let catalog =
        SlashCommandCatalog::new((0..12).map(|index| command(&format!("command-{index}"))))
            .unwrap();
    let mut state = SlashCommandsState::new(catalog);
    state.sync_input("/", 1);
    assert!(state.select(8));
    assert_eq!(state.view().unwrap().selected, Some(8));
    assert_eq!(state.selected_command().unwrap().name, "command-8");
}

#[test]
fn weak_name_and_description_matches_need_explicit_selection() {
    let catalog = SlashCommandCatalog::new([
        SlashCommandDefinition {
            description: "Open settings".into(),
            ..command("config")
        },
        SlashCommandDefinition {
            description: "Inspect health and settings".into(),
            ..command("doctor")
        },
    ])
    .unwrap();
    let mut state = SlashCommandsState::new(catalog);
    state.sync_input("/confi", 6);
    assert_eq!(state.view().unwrap().selected, Some(0));
    state.sync_input("/cofig", 6);
    assert_eq!(state.view().unwrap().selected, None);
    assert!(state.selected_completion().is_none());
    state.select_next();
    assert_eq!(state.selected_command().unwrap().name, "config");
    state.sync_input("/settings", 9);
    assert_eq!(state.view().unwrap().selected, None);
    assert_eq!(state.view().unwrap().commands.len(), 2);
}
