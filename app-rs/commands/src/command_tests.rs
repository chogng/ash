use super::AppCommandId;

#[test]
fn command_ids_are_unique_and_round_trip() {
    let commands = AppCommandId::ALL;
    let ids: Vec<_> = commands.iter().map(|command| command.id()).collect();
    let unique_ids: std::collections::HashSet<_> = ids.iter().copied().collect();

    assert_eq!(ids.len(), unique_ids.len());
    for command in commands {
        assert_eq!(AppCommandId::from_id(command.id()), Some(command));
    }
}

#[test]
fn only_currently_supported_commands_are_bindable() {
    assert_eq!(
        AppCommandId::from_id("workbench.action.toggleComposerMode"),
        None
    );
    assert_eq!(
        AppCommandId::bindable_from_id("workbench.action.toggleTabContainer"),
        Some(AppCommandId::ToggleTabContainer)
    );
    assert_eq!(
        AppCommandId::bindable_from_id("workbench.action.newSession"),
        None
    );
    assert_eq!(
        AppCommandId::bindable_from_id("workbench.action.pickExecutionLocation"),
        Some(AppCommandId::PickExecutionLocation)
    );
    assert_eq!(
        AppCommandId::bindable_from_id("workbench.action.manageRemoteTunnels"),
        Some(AppCommandId::ManageRemoteTunnels)
    );
}
