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
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateParams;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateResult;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::collections::BTreeMap;

pub(crate) type BranchChoices = ListSelectionSpec<BranchSelectionAction>;

pub(crate) enum Event {
    PickerOpened(BranchChoices),
    SwitchFinished(Result<GitStatusResult, String>),
    CreateFinished {
        name: String,
        result: Result<GitBranchListResult, String>,
    },
    WorktreeCreated(Result<GitWorktreeCreateResult, String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPicker,
    Switch { name: String },
    Create { name: String },
    CreateWorktree { name: String },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenPicker => "ash-tui-list-git-branches",
            Self::Switch { .. } => "ash-tui-switch-git-branch",
            Self::Create { .. } => "ash-tui-create-git-branch",
            Self::CreateWorktree { .. } => "ash-tui-create-git-worktree",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BranchSelectionAction {
    NewBranch,
    CreateBranch { branch_name: String },
    CreateWorktree { name: String },
    Occupied { name: String },
    Switch { name: String, current: bool },
}

#[derive(Debug)]
pub(crate) struct BranchPanel {
    view: BranchView,
    language: crate::nls::Language,
}

#[derive(Debug)]
enum BranchView {
    Picker {
        branches: ListSelection<BranchSelectionAction>,
        branch_name: Option<ListSelection<BranchSelectionAction>>,
        picker_hints: KeyHints,
        prompt_hints: KeyHints,
    },
    NewBranch {
        prompt: ListSelection<BranchSelectionAction>,
        hints: KeyHints,
    },
    NewWorktree {
        prompt: ListSelection<BranchSelectionAction>,
        hints: KeyHints,
    },
}

impl BranchPanel {
    pub(crate) fn new(spec: BranchChoices) -> Self {
        Self {
            view: BranchView::Picker {
                branches: ListSelection::new(spec.model, spec.actions),
                branch_name: None,
                picker_hints: KeyHints::compact()
                    .with_compact_action("b", "New branch")
                    .with_compact_action("/", "search")
                    .with_compact_action("Esc", "close"),
                prompt_hints: KeyHints::new()
                    .with_action("Enter", "create")
                    .with_action("Esc", "back"),
            },
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn new_branch() -> Self {
        Self {
            view: BranchView::NewBranch {
                prompt: branch_name_prompt(crate::nls::Language::English),
                hints: KeyHints::new()
                    .with_action("Enter", "create")
                    .with_action("Esc", "close"),
            },
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn new_worktree() -> Self {
        Self {
            view: BranchView::NewWorktree {
                prompt: worktree_name_prompt(crate::nls::Language::English),
                hints: KeyHints::new()
                    .with_action("Enter", "create")
                    .with_action("Esc", "close"),
            },
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        match &self.view {
            BranchView::Picker {
                branches,
                branch_name,
                ..
            } => branch_name.as_ref().unwrap_or(branches).state(),
            BranchView::NewBranch { prompt, .. } | BranchView::NewWorktree { prompt, .. } => {
                prompt.state()
            }
        }
    }

    pub(crate) fn is_branch_name_prompt(&self) -> bool {
        match &self.view {
            BranchView::Picker { branch_name, .. } => branch_name.is_some(),
            BranchView::NewBranch { .. } | BranchView::NewWorktree { .. } => true,
        }
    }

    pub(crate) fn parent_title(&self) -> Option<&str> {
        match &self.view {
            BranchView::Picker {
                branches,
                branch_name: Some(_),
                ..
            } => Some(branches.state().title()),
            _ => None,
        }
    }

    pub(crate) fn return_to_parent(&mut self) {
        if let BranchView::Picker { branch_name, .. } = &mut self.view {
            *branch_name = None;
        }
    }

    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        match &mut self.view {
            BranchView::Picker {
                branches,
                branch_name,
                ..
            } => branch_name.as_mut().unwrap_or(branches).state_mut(),
            BranchView::NewBranch { prompt, .. } | BranchView::NewWorktree { prompt, .. } => {
                prompt.state_mut()
            }
        }
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        match &mut self.view {
            BranchView::Picker {
                branches,
                branch_name,
                ..
            } => {
                branches.state_mut().localize(language);
                if let Some(prompt) = branch_name {
                    prompt.state_mut().localize(language);
                }
            }
            BranchView::NewBranch { prompt, .. } | BranchView::NewWorktree { prompt, .. } => {
                prompt.state_mut().localize(language)
            }
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        match &self.view {
            BranchView::Picker {
                branch_name: Some(_),
                prompt_hints,
                ..
            } => prompt_hints,
            BranchView::Picker { picker_hints, .. } => picker_hints,
            BranchView::NewBranch { hints, .. } | BranchView::NewWorktree { hints, .. } => hints,
        }
    }

    pub(crate) fn handle_key(
        &mut self,
        key: KeyEvent,
    ) -> ListSelectionOutcome<BranchSelectionAction> {
        match &mut self.view {
            BranchView::NewBranch { prompt, .. } => {
                if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc {
                    ListSelectionOutcome::Dismiss
                } else {
                    handle_branch_name_key(prompt, key)
                }
            }
            BranchView::NewWorktree { prompt, .. } => {
                if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc {
                    ListSelectionOutcome::Dismiss
                } else {
                    handle_worktree_name_key(prompt, key)
                }
            }
            BranchView::Picker {
                branch_name: Some(_),
                ..
            } if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc => {
                self.return_to_parent();
                ListSelectionOutcome::Consumed
            }
            BranchView::Picker {
                branch_name: Some(prompt),
                ..
            } => handle_branch_name_key(prompt, key),
            BranchView::Picker {
                branches,
                branch_name,
                ..
            } => {
                let outcome = if key.kind == KeyEventKind::Press
                    && key.modifiers == KeyModifiers::NONE
                    && branches.state().items_focused()
                    && key.code == KeyCode::Char('b')
                {
                    ListSelectionOutcome::Activate(BranchSelectionAction::NewBranch)
                } else {
                    branches.handle_key(key)
                };
                match outcome {
                    ListSelectionOutcome::Activate(BranchSelectionAction::NewBranch) => {
                        *branch_name = Some(branch_name_prompt(self.language));
                        ListSelectionOutcome::Consumed
                    }
                    ListSelectionOutcome::Activate(BranchSelectionAction::Occupied { .. }) => {
                        branches
                            .state_mut()
                            .set_message(Some("Branch is checked out in another worktree".into()));
                        ListSelectionOutcome::Consumed
                    }
                    outcome => outcome,
                }
            }
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        match &mut self.view {
            BranchView::Picker {
                branch_name: Some(prompt),
                ..
            }
            | BranchView::NewBranch { prompt, .. }
            | BranchView::NewWorktree { prompt, .. } => {
                prompt.handle_paste(pasted);
                prompt.state_mut().set_message(None);
            }
            BranchView::Picker { branches, .. } => branches.handle_paste(pasted),
        }
    }
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

fn worktree_name_prompt(language: crate::nls::Language) -> ListSelection<BranchSelectionAction> {
    let mut model = ListSelectionModel::new(
        "New worktree",
        vec![ListSelectionGroup::new("", Vec::new())],
    )
    .with_input(SearchBoxModel::new("Worktree name"))
    .with_action(
        ListSelectionItem::new("Create worktree")
            .with_id(ListSelectionItemId::new("worktree:create")),
    )
    .without_tab_bar()
    .with_empty_message("Create at HEAD. No session starts.");
    model.localize(language);
    let mut prompt = ListSelection::new(model, BTreeMap::new());
    prompt.state_mut().focus_search();
    prompt
}

fn handle_worktree_name_key(
    prompt: &mut ListSelection<BranchSelectionAction>,
    key: KeyEvent,
) -> ListSelectionOutcome<BranchSelectionAction> {
    if key.kind == KeyEventKind::Press
        && key.code == KeyCode::Enter
        && key.modifiers == KeyModifiers::NONE
    {
        let name = prompt.state().query().trim();
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            prompt
                .state_mut()
                .set_message(Some("Use 1–64 letters, numbers, '-' or '_'".into()));
            return ListSelectionOutcome::Consumed;
        }
        return ListSelectionOutcome::Activate(BranchSelectionAction::CreateWorktree {
            name: name.into(),
        });
    }
    let before = prompt.state().query().to_owned();
    let outcome = prompt.handle_key(key);
    if prompt.state().query() != before {
        prompt.state_mut().set_message(None);
    }
    outcome
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
        Command::CreateWorktree { name } => Ok(Event::WorktreeCreated(
            client
                .create_git_worktree(GitWorktreeCreateParams {
                    repository_id: None,
                    name,
                })
                .map_err(|error| git_error_message(error, GitAction::CreateWorktree)),
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
    Switch,
    Create,
    CreateWorktree,
}

fn git_error_message(error: ash_app_server_client::ClientError, action: GitAction) -> String {
    match error {
        ash_app_server_client::ClientError::Server { code: -32601, .. } => match action {
            GitAction::CreateWorktree => "The connected App Server does not support worktree creation. Restart it to use the current version.".into(),
            _ => "The connected App Server does not support this branch action. Restart it to use the current version.".into(),
        },
        ash_app_server_client::ClientError::Server { code: -32061, .. } => match action {
            GitAction::List => "Could not read project branches.".into(),
            GitAction::Switch => {
                "Could not switch branch. Check uncommitted changes and worktree use.".into()
            }
            GitAction::Create => {
                "Could not create branch. Check the branch name and whether it already exists."
                    .into()
            }
            GitAction::CreateWorktree => "Could not create worktree. Check its name and existing directories.".into(),
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
