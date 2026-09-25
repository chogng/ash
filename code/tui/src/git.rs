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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPicker,
    Switch { name: String },
    Create { name: String },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenPicker => "ash-tui-list-git-branches",
            Self::Switch { .. } => "ash-tui-switch-git-branch",
            Self::Create { .. } => "ash-tui-create-git-branch",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BranchSelectionAction {
    NewWorktree,
    NewBranch,
    NewBranchWorktree,
    CreateBranch { branch_name: String },
    CreateBranchWorktree { branch_name: String },
    Occupied { name: String },
    Switch { name: String, current: bool },
}

#[derive(Debug)]
pub(crate) struct BranchPanel {
    branches: ListSelection<BranchSelectionAction>,
    branch_name: Option<ListSelection<BranchSelectionAction>>,
    new_task: bool,
    picker_hints: KeyHints,
    prompt_hints: KeyHints,
    language: crate::nls::Language,
}

impl BranchPanel {
    pub(crate) fn new(spec: BranchChoices) -> Self {
        Self::with_mode(spec, false)
    }

    pub(crate) fn new_task() -> Self {
        Self::with_mode(new_task_choices(), true)
    }

    fn with_mode(spec: BranchChoices, new_task: bool) -> Self {
        let picker_hints = if new_task {
            KeyHints::compact().with_compact_action("w", "New worktree")
        } else {
            KeyHints::compact()
        };
        let picker_hints = picker_hints.with_compact_action(
            "b",
            if new_task {
                "New branch worktree"
            } else {
                "New branch"
            },
        );
        let picker_hints = if new_task {
            picker_hints
        } else {
            picker_hints.with_compact_action("/", "search")
        };
        Self {
            branches: ListSelection::new(spec.model, spec.actions),
            branch_name: None,
            new_task,
            picker_hints: picker_hints.with_compact_action("Esc", "close"),
            prompt_hints: KeyHints::new()
                .with_action("Enter", "create")
                .with_action("Esc", "back"),
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        self.branch_name.as_ref().unwrap_or(&self.branches).state()
    }

    pub(crate) fn is_branch_name_prompt(&self) -> bool {
        self.branch_name.is_some()
    }

    pub(crate) fn parent_title(&self) -> Option<&str> {
        self.branch_name
            .as_ref()
            .map(|_| self.branches.state().title())
    }

    pub(crate) fn return_to_parent(&mut self) {
        self.branch_name = None;
    }

    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.branch_name
            .as_mut()
            .unwrap_or(&mut self.branches)
            .state_mut()
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.branches.state_mut().localize(language);
        if let Some(prompt) = &mut self.branch_name {
            prompt.state_mut().localize(language);
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        self.branch_name
            .as_ref()
            .map(|_| &self.prompt_hints)
            .unwrap_or(&self.picker_hints)
    }

    pub(crate) fn handle_key(
        &mut self,
        key: KeyEvent,
    ) -> ListSelectionOutcome<BranchSelectionAction> {
        if let Some(prompt) = &mut self.branch_name {
            if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc {
                self.return_to_parent();
                return ListSelectionOutcome::Consumed;
            }
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
                return ListSelectionOutcome::Activate(if self.new_task {
                    BranchSelectionAction::CreateBranchWorktree {
                        branch_name: branch_name.into(),
                    }
                } else {
                    BranchSelectionAction::CreateBranch {
                        branch_name: branch_name.into(),
                    }
                });
            }
            let before = prompt.state().query().to_owned();
            let outcome = prompt.handle_key(key);
            if prompt.state().query() != before {
                prompt.state_mut().set_message(None);
            }
            return outcome;
        }
        if key.kind == KeyEventKind::Press
            && key.modifiers == KeyModifiers::NONE
            && self.branches.state().items_focused()
        {
            match key.code {
                KeyCode::Char('w') if self.new_task => {
                    return ListSelectionOutcome::Activate(BranchSelectionAction::NewWorktree);
                }
                KeyCode::Char('b') => {
                    self.open_branch_prompt();
                    return ListSelectionOutcome::Consumed;
                }
                _ => {}
            }
        }
        match self.branches.handle_key(key) {
            ListSelectionOutcome::Activate(BranchSelectionAction::NewBranch) => {
                self.open_branch_prompt();
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Activate(BranchSelectionAction::NewBranchWorktree) => {
                self.open_branch_prompt();
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

    fn open_branch_prompt(&mut self) {
        let mut model = ListSelectionModel::new(
            if self.new_task {
                "New branch worktree"
            } else {
                "New branch"
            },
            vec![ListSelectionGroup::new("", Vec::new())],
        )
        .with_input(SearchBoxModel::new("Branch name").with_initial_query("ash/"))
        .with_action(
            ListSelectionItem::new(if self.new_task {
                "Create branch worktree"
            } else {
                "Create branch"
            })
            .with_id(ListSelectionItemId::new("worktree:create")),
        )
        .without_tab_bar()
        .with_empty_message(if self.new_task {
            "New task in an ash/ branch and its own worktree."
        } else {
            "Create a branch at HEAD without switching worktrees."
        });
        model.localize(self.language);
        let mut prompt = ListSelection::new(model, BTreeMap::new());
        prompt.state_mut().focus_search();
        self.branch_name = Some(prompt);
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        match &mut self.branch_name {
            Some(prompt) => {
                prompt.handle_paste(pasted);
                prompt.state_mut().set_message(None);
            }
            None => self.branches.handle_paste(pasted),
        }
    }
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

pub(crate) fn new_task_choices() -> BranchChoices {
    let worktree = ListSelectionItemId::new("task:detached");
    let branch = ListSelectionItemId::new("task:branch");
    BranchChoices {
        model: ListSelectionModel::new(
            "New task",
            vec![ListSelectionGroup::new(
                "",
                vec![
                    ListSelectionItem::new("New worktree")
                        .with_id(worktree.clone())
                        .with_description("Detached · new session"),
                    ListSelectionItem::new("New branch worktree")
                        .with_id(branch.clone())
                        .with_description("ash/ branch · new session"),
                ],
            )],
        )
        .without_tab_bar()
        .with_initial_selected(0),
        actions: BTreeMap::from([
            (worktree, BranchSelectionAction::NewWorktree),
            (branch, BranchSelectionAction::NewBranchWorktree),
        ]),
    }
}

enum GitAction {
    List,
    Switch,
    Create,
}

fn git_error_message(error: ash_app_server_client::ClientError, action: GitAction) -> String {
    match error {
        ash_app_server_client::ClientError::Server { code: -32601, .. } => {
            "The connected App Server does not support this branch action. Restart it to use the current version.".into()
        }
        ash_app_server_client::ClientError::Server { code: -32061, .. } => match action {
            GitAction::List => "Could not read project branches.".into(),
            GitAction::Switch => {
                "Could not switch branch. Check uncommitted changes and worktree use.".into()
            }
            GitAction::Create => {
                "Could not create branch. Check the branch name and whether it already exists."
                    .into()
            }
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
