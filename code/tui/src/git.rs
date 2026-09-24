use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use std::collections::BTreeMap;

pub(crate) type BranchChoices = ListSelectionSpec<BranchSelectionAction>;

pub(crate) enum Event {
    PickerOpened(BranchChoices),
    SwitchFinished(Result<GitStatusResult, String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPicker,
    Switch { name: String },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenPicker => "ash-tui-list-git-branches",
            Self::Switch { .. } => "ash-tui-switch-git-branch",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BranchSelectionAction {
    pub(crate) name: String,
    pub(crate) current: bool,
}

pub(crate) fn execute<T>(client: &mut AppServerClient<T>, command: Command) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::OpenPicker => client
            .list_git_branches()
            .map(choices)
            .map(Event::PickerOpened)
            .map_err(|error| error.to_string()),
        Command::Switch { name } => Ok(Event::SwitchFinished(
            client
                .switch_git_branch(GitBranchSwitchParams {
                    repository_id: None,
                    name,
                })
                .map(|result| result.status)
                .map_err(|error| error.to_string()),
        )),
    }
}

pub(crate) fn choices(result: GitBranchListResult) -> BranchChoices {
    let mut actions = BTreeMap::new();
    let mut current = 0;
    let items = result
        .branches
        .into_iter()
        .enumerate()
        .map(|(index, branch)| {
            if branch.current {
                current = index;
            }
            let id = ListSelectionItemId::new(format!("branch:{}", branch.name));
            actions.insert(
                id.clone(),
                BranchSelectionAction {
                    name: branch.name.clone(),
                    current: branch.current,
                },
            );
            let description = if branch.current { "Current" } else { "Switch" };
            ListSelectionItem::new(branch.name)
                .with_id(id)
                .with_description(description)
        })
        .collect();
    BranchChoices {
        model: ListSelectionModel::new(
            "Switch branch",
            vec![ListSelectionGroup::new("Branches", items)],
        )
        .with_search(SearchBoxModel::new("Search branches"))
        .with_initial_selected(current)
        .without_tab_bar()
        .with_empty_message("No matching branches"),
        actions,
    }
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
