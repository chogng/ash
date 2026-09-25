use crate::nls::Text;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::git::GitBranchCreateParams;
use ash_app_server_protocol::protocol::git::GitBranchDeleteParams;
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateParams;
use ash_app_server_protocol::protocol::git::GitWorktreeDeleteParams;
use ash_app_server_protocol::protocol::git::GitWorktreeResolveParams;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::collections::BTreeMap;

mod worktree_panel;
pub(crate) use worktree_panel::WorktreeChoices;
pub(crate) use worktree_panel::WorktreePanel;
pub(crate) use worktree_panel::WorktreeSelectionAction;
pub(crate) use worktree_panel::worktree_choices;

pub(crate) type BranchChoices = ListSelectionSpec<BranchSelectionAction>;

pub(crate) enum Event {
    PickerOpened(BranchChoices),
    SwitchFinished(Result<GitStatusResult, String>),
    CreateFinished {
        name: String,
        result: Result<GitBranchListResult, String>,
    },
    BranchDeleted(Result<BranchChoices, String>),
    WorktreePickerOpened(WorktreeChoices),
    WorktreeCreated {
        path: String,
        choices: Result<WorktreeChoices, String>,
    },
    WorktreeCreateFailed(String),
    WorktreeDeleted(Result<WorktreeChoices, String>),
    WorktreeResolved(Result<String, String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPicker,
    Switch { name: String },
    Create { name: String },
    DeleteBranch { name: String },
    OpenWorktrees,
    CreateWorktree { name: String },
    DeleteWorktree { checkout_root: String },
    ResolveWorktree { checkout_root: String },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenPicker => "ash-tui-list-git-branches",
            Self::Switch { .. } => "ash-tui-switch-git-branch",
            Self::Create { .. } => "ash-tui-create-git-branch",
            Self::DeleteBranch { .. } => "ash-tui-delete-git-branch",
            Self::OpenWorktrees => "ash-tui-list-git-worktrees",
            Self::CreateWorktree { .. } => "ash-tui-create-git-worktree",
            Self::DeleteWorktree { .. } => "ash-tui-delete-git-worktree",
            Self::ResolveWorktree { .. } => "ash-tui-resolve-git-worktree",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BranchSelectionAction {
    NewBranch,
    CreateBranch { branch_name: String },
    DeleteBranch { name: String },
    Occupied { name: String },
    Switch { name: String, current: bool },
}

#[derive(Debug)]
pub(crate) struct BranchPanel {
    branches: ListSelection<BranchSelectionAction>,
    branch_name: Option<ListSelection<BranchSelectionAction>>,
    delete: Option<ListSelection<BranchSelectionAction>>,
    language: crate::nls::Language,
    picker_hints: KeyHints,
    prompt_hints: KeyHints,
    delete_hints: KeyHints,
}

impl BranchPanel {
    pub(crate) fn new(spec: BranchChoices) -> Self {
        Self {
            branches: ListSelection::new(spec.model, spec.actions),
            branch_name: None,
            delete: None,
            language: crate::nls::Language::English,
            picker_hints: KeyHints::compact()
                .with_compact_action("b", "New branch")
                .with_compact_action("d", "delete")
                .with_compact_action("/", "search")
                .with_compact_action("Esc", "close"),
            prompt_hints: KeyHints::new()
                .with_action("Enter", "create")
                .with_action("Esc", "back"),
            delete_hints: KeyHints::new()
                .with_action("Enter", "delete")
                .with_action("Esc", "back"),
        }
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        self.delete
            .as_ref()
            .or(self.branch_name.as_ref())
            .unwrap_or(&self.branches)
            .state()
    }

    pub(crate) fn is_subpage(&self) -> bool {
        self.branch_name.is_some() || self.delete.is_some()
    }

    pub(crate) fn parent_title(&self) -> Option<&str> {
        self.is_subpage().then(|| self.branches.state().title())
    }

    pub(crate) fn return_to_parent(&mut self) {
        self.branch_name = None;
        self.delete = None;
    }

    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.delete
            .as_mut()
            .or(self.branch_name.as_mut())
            .unwrap_or(&mut self.branches)
            .state_mut()
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.branches.state_mut().localize(language);
        if let Some(prompt) = &mut self.branch_name {
            prompt.state_mut().localize(language);
        }
        if let Some(prompt) = &mut self.delete {
            prompt.state_mut().localize(language);
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        if self.delete.is_some() {
            &self.delete_hints
        } else if self.branch_name.is_some() {
            &self.prompt_hints
        } else {
            &self.picker_hints
        }
    }

    pub(crate) fn handle_key(
        &mut self,
        key: KeyEvent,
    ) -> ListSelectionOutcome<BranchSelectionAction> {
        if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc && self.is_subpage() {
            self.return_to_parent();
            return ListSelectionOutcome::Consumed;
        }
        if let Some(prompt) = &mut self.branch_name {
            return handle_branch_name_key(prompt, key);
        }
        if let Some(prompt) = &mut self.delete {
            return prompt.handle_key(key);
        }
        if key.kind == KeyEventKind::Press
            && key.modifiers == KeyModifiers::NONE
            && key.code == KeyCode::Char('d')
            && self.branches.state().items_focused()
        {
            let selected = self
                .branches
                .state()
                .selected_item()
                .and_then(|item| item.id());
            let action = selected.and_then(|id| self.branches.action(id)).cloned();
            match action {
                Some(BranchSelectionAction::Switch {
                    name,
                    current: false,
                }) => {
                    self.delete = Some(branch_delete_prompt(self.language, name));
                }
                Some(BranchSelectionAction::Switch { current: true, .. })
                | Some(BranchSelectionAction::Occupied { .. }) => self
                    .branches
                    .state_mut()
                    .set_message(Some("Cannot delete a checked-out branch.".into())),
                _ => {}
            }
            return ListSelectionOutcome::Consumed;
        }
        let outcome = if key.kind == KeyEventKind::Press
            && key.modifiers == KeyModifiers::NONE
            && self.branches.state().items_focused()
            && key.code == KeyCode::Char('b')
        {
            ListSelectionOutcome::Activate(BranchSelectionAction::NewBranch)
        } else {
            self.branches.handle_key(key)
        };
        match outcome {
            ListSelectionOutcome::Activate(BranchSelectionAction::NewBranch) => {
                self.branch_name = Some(branch_name_prompt(self.language));
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Activate(BranchSelectionAction::Occupied { .. }) => {
                self.branches
                    .state_mut()
                    .set_message(Some("Branch is checked out in another worktree".into()));
                ListSelectionOutcome::Consumed
            }
            outcome => outcome,
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if self.delete.is_some() {
            return;
        }
        if let Some(prompt) = &mut self.branch_name {
            prompt.handle_paste(pasted);
            prompt.state_mut().set_message(None);
        } else {
            self.branches.handle_paste(pasted);
        }
    }
}

fn branch_delete_prompt(
    language: crate::nls::Language,
    name: String,
) -> ListSelection<BranchSelectionAction> {
    let id = ListSelectionItemId::new("branch:delete-confirm");
    let mut model = ListSelectionModel::new(
        "Delete branch",
        vec![ListSelectionGroup::new(
            "",
            vec![
                ListSelectionItem::new(Text::literal(&name))
                    .with_id(id.clone())
                    .with_description(
                        "Only merged branches can be deleted. This cannot be undone.",
                    ),
            ],
        )],
    )
    .without_tab_bar();
    model.localize(language);
    ListSelection::new(
        model,
        BTreeMap::from([(id, BranchSelectionAction::DeleteBranch { name })]),
    )
}

fn branch_name_prompt(language: crate::nls::Language) -> ListSelection<BranchSelectionAction> {
    let mut model =
        ListSelectionModel::new("New branch", vec![ListSelectionGroup::new("", Vec::new())])
            .with_input(SearchBoxModel::new("Branch name").with_initial_query("ash/"))
            .with_action(
                ListSelectionItem::new("Create branch")
                    .with_id(ListSelectionItemId::new("branch:create")),
            )
            .without_tab_bar()
            .with_empty_message("Create a branch at HEAD without switching worktrees.");
    model.localize(language);
    let mut prompt = ListSelection::new(model, BTreeMap::new());
    prompt.state_mut().focus_search();
    prompt
}

fn handle_branch_name_key(
    prompt: &mut ListSelection<BranchSelectionAction>,
    key: KeyEvent,
) -> ListSelectionOutcome<BranchSelectionAction> {
    if key.kind == KeyEventKind::Press
        && key.code == KeyCode::Enter
        && key.modifiers == KeyModifiers::NONE
    {
        let branch_name = prompt.state().query().trim();
        if branch_name.is_empty() || branch_name == "ash/" {
            let message = if branch_name.is_empty() {
                "Enter a branch name"
            } else {
                "Enter a branch name after ash/"
            };
            prompt.state_mut().set_message(Some(message.into()));
            return ListSelectionOutcome::Consumed;
        }
        return ListSelectionOutcome::Activate(BranchSelectionAction::CreateBranch {
            branch_name: branch_name.into(),
        });
    }
    let before = prompt.state().query().to_owned();
    let outcome = prompt.handle_key(key);
    if prompt.state().query() != before {
        prompt.state_mut().set_message(None);
    }
    outcome
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
            .map_err(|error| git_error_message(error, GitAction::List)),
        Command::Switch { name } => Ok(Event::SwitchFinished(
            client
                .switch_git_branch(GitBranchSwitchParams {
                    repository_id: None,
                    name,
                })
                .map(|result| result.status)
                .map_err(|error| git_error_message(error, GitAction::Switch)),
        )),
        Command::Create { name } => {
            let result = client
                .create_git_branch(GitBranchCreateParams {
                    repository_id: None,
                    name: name.clone(),
                })
                .map_err(|error| git_error_message(error, GitAction::Create));
            Ok(Event::CreateFinished { name, result })
        }
        Command::DeleteBranch { name } => Ok(Event::BranchDeleted(
            client
                .delete_git_branch(GitBranchDeleteParams {
                    repository_id: None,
                    name,
                })
                .map(choices)
                .map_err(|error| git_error_message(error, GitAction::DeleteBranch)),
        )),
        Command::OpenWorktrees => client
            .list_git_worktrees()
            .map(|result| Event::WorktreePickerOpened(worktree_choices(result, None)))
            .map_err(|error| git_error_message(error, GitAction::ListWorktrees)),
        Command::CreateWorktree { name } => {
            let created = match client.create_git_worktree(GitWorktreeCreateParams {
                repository_id: None,
                name,
            }) {
                Ok(created) => created,
                Err(error) => {
                    return Ok(Event::WorktreeCreateFailed(git_error_message(
                        error,
                        GitAction::CreateWorktree,
                    )));
                }
            };
            let choices = client
                .list_git_worktrees()
                .map(|result| worktree_choices(result, Some(&created.path)))
                .map_err(|error| git_error_message(error, GitAction::ListWorktrees));
            Ok(Event::WorktreeCreated {
                path: created.path,
                choices,
            })
        }
        Command::DeleteWorktree { checkout_root } => Ok(Event::WorktreeDeleted(
            client
                .delete_git_worktree(GitWorktreeDeleteParams {
                    repository_id: None,
                    checkout_root,
                })
                .map(|result| worktree_choices(result, None))
                .map_err(|error| git_error_message(error, GitAction::DeleteWorktree)),
        )),
        Command::ResolveWorktree { checkout_root } => Ok(Event::WorktreeResolved(
            client
                .resolve_git_worktree(GitWorktreeResolveParams {
                    repository_id: None,
                    checkout_root,
                })
                .map(|result| result.path)
                .map_err(|error| git_error_message(error, GitAction::ResolveWorktree)),
        )),
    }
}

pub(crate) fn choices(result: GitBranchListResult) -> BranchChoices {
    choices_with_selected(result, None)
}

pub(crate) fn choices_after_create(
    result: GitBranchListResult,
    name: &str,
) -> Result<BranchChoices, String> {
    let selected = result
        .branches
        .iter()
        .position(|branch| branch.name == name)
        .ok_or_else(|| "Created branch is no longer available.".to_owned())?;
    Ok(choices_with_selected(result, Some(selected)))
}

fn choices_with_selected(result: GitBranchListResult, selected: Option<usize>) -> BranchChoices {
    let mut actions = BTreeMap::new();
    let create_id = ListSelectionItemId::new("branch:create");
    actions.insert(create_id.clone(), BranchSelectionAction::NewBranch);
    let mut current = 0;
    let mut items = vec![
        ListSelectionItem::new("New branch")
            .with_id(create_id)
            .with_description("At HEAD · no checkout change"),
        ListSelectionItem::new("Project branches").as_section_heading(),
    ];
    items.extend(
        result
            .branches
            .into_iter()
            .enumerate()
            .map(|(index, branch)| {
                if branch.current {
                    current = index;
                }
                let id = ListSelectionItemId::new(format!("branch:{}", branch.name));
                let action = if branch.checked_out_elsewhere == Some(true) {
                    BranchSelectionAction::Occupied {
                        name: branch.name.clone(),
                    }
                } else {
                    BranchSelectionAction::Switch {
                        name: branch.name.clone(),
                        current: branch.current,
                    }
                };
                actions.insert(id.clone(), action);
                let description = if branch.current {
                    "Current"
                } else if branch.checked_out_elsewhere == Some(true) {
                    "In another worktree"
                } else if branch.checked_out_elsewhere.is_none() {
                    "Switch · worktree use unknown"
                } else {
                    "Switch"
                };
                ListSelectionItem::new(branch.name)
                    .with_id(id)
                    .with_description(description)
            })
            .collect::<Vec<_>>(),
    );
    BranchChoices {
        model: ListSelectionModel::new(
            "Project branches",
            vec![ListSelectionGroup::new("", items)],
        )
        .with_search(SearchBoxModel::new("Search branches"))
        .with_initial_selected(selected.unwrap_or(current) + 2)
        .without_tab_bar()
        .with_empty_message("No matching branches"),
        actions,
    }
}

enum GitAction {
    List,
    ListWorktrees,
    ResolveWorktree,
    Switch,
    Create,
    DeleteBranch,
    CreateWorktree,
    DeleteWorktree,
}

fn git_error_message(error: ash_app_server_client::ClientError, action: GitAction) -> String {
    match error {
        ash_app_server_client::ClientError::Server { code: -32601, .. } => match action {
            GitAction::CreateWorktree | GitAction::DeleteWorktree | GitAction::ListWorktrees | GitAction::ResolveWorktree => "The connected App Server does not support worktree management. Restart it to use the current version.".into(),
            _ => "The connected App Server does not support this branch action. Restart it to use the current version.".into(),
        },
        ash_app_server_client::ClientError::Server { code: -32061, .. } => match action {
            GitAction::List => "Could not read project branches.".into(),
            GitAction::ListWorktrees => "Could not read project worktrees.".into(),
            GitAction::ResolveWorktree => "Could not open worktree. It may have changed or is in use.".into(),
            GitAction::Switch => {
                "Could not switch branch. Check uncommitted changes and worktree use.".into()
            }
            GitAction::Create => {
                "Could not create branch. Check the branch name and whether it already exists."
                    .into()
            }
            GitAction::DeleteBranch => "Could not delete branch. It may be unmerged or checked out.".into(),
            GitAction::CreateWorktree => "Could not create worktree. Check its name and existing directories.".into(),
            GitAction::DeleteWorktree => "Could not delete worktree. It may have changes or be in use.".into(),
        },
        ash_app_server_client::ClientError::Server { code: -32060, .. } => {
            "Git is unavailable for this project.".into()
        }
        ash_app_server_client::ClientError::Server { code: -32062, .. } => {
            "This project is not a Git repository.".into()
        }
        ash_app_server_client::ClientError::Server { .. } => "Git request failed.".into(),
        error => error.to_string(),
    }
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
