use ash_commands::AppCommandId;

use super::command_for_element;
use crate::ADD_SESSION;
use crate::CHANGES_PANE_BUTTON;
use crate::TAB_CONTAINER_TOGGLE;
use ash_files::FILES_REFRESH;
use ash_session::interaction::CONTEXT_DIFF;

#[test]
fn workbench_elements_resolve_to_their_stable_commands() {
    assert_eq!(
        command_for_element(TAB_CONTAINER_TOGGLE),
        Some(AppCommandId::ToggleTabContainer)
    );
    assert_eq!(
        command_for_element(CHANGES_PANE_BUTTON),
        Some(AppCommandId::ShowAgentChanges)
    );
    assert_eq!(
        command_for_element(ADD_SESSION),
        Some(AppCommandId::AddSession)
    );
    assert_eq!(
        command_for_element(FILES_REFRESH),
        Some(AppCommandId::RefreshAgentFiles)
    );
    assert_eq!(
        command_for_element(CONTEXT_DIFF),
        Some(AppCommandId::ShowGitDiff)
    );
}

#[test]
fn only_commands_with_current_execution_are_user_bindable() {
    assert_eq!(
        AppCommandId::bindable_from_id("workbench.action.toggleTabContainer"),
        Some(AppCommandId::ToggleTabContainer)
    );
    assert_eq!(
        AppCommandId::bindable_from_id("workbench.action.newSession"),
        None
    );
}
