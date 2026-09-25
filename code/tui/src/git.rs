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
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
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
pub(crate) enum BranchSelectionAction {
    NewWorktree,
    NewBranch,
    CreateBranch { branch_name: String },
    Switch { name: String, current: bool },
}

#[derive(Debug)]
pub(crate) struct BranchPanel {
    branches: ListSelection<BranchSelectionAction>,
    worktree_name: Option<ListSelection<BranchSelectionAction>>,
    picker_hints: KeyHints,
    prompt_hints: KeyHints,
    language: crate::nls::Language,
}

impl BranchPanel {
    pub(crate) fn new(spec: BranchChoices) -> Self {
        Self {
            branches: ListSelection::new(spec.model, spec.actions),
            worktree_name: None,
            picker_hints: KeyHints::compact()
                .with_compact_action("w", "New worktree")
                .with_compact_action("b", "New branch")
                .with_compact_action("/", "search")
                .with_compact_action("Esc", "close"),
            prompt_hints: KeyHints::new()
                .with_action("Enter", "create")
                .with_action("Esc", "back"),
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        self.worktree_name
            .as_ref()
            .unwrap_or(&self.branches)
            .state()
    }

    pub(crate) fn is_worktree_name_prompt(&self) -> bool {
        self.worktree_name.is_some()
    }

    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.worktree_name
            .as_mut()
            .unwrap_or(&mut self.branches)
            .state_mut()
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.branches.state_mut().localize(language);
        if let Some(prompt) = &mut self.worktree_name {
            prompt.state_mut().localize(language);
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        self.worktree_name
            .as_ref()
            .map(|_| &self.prompt_hints)
            .unwrap_or(&self.picker_hints)
    }

    pub(crate) fn handle_key(
        &mut self,
        key: KeyEvent,
    ) -> ListSelectionOutcome<BranchSelectionAction> {
        if let Some(prompt) = &mut self.worktree_name {
            if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc {
                self.worktree_name = None;
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
                return ListSelectionOutcome::Activate(BranchSelectionAction::CreateBranch {
                    branch_name: branch_name.into(),
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
                KeyCode::Char('w') => {
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
            outcome => outcome,
        }
    }

    fn open_branch_prompt(&mut self) {
        let mut model =
            ListSelectionModel::new("New branch", vec![ListSelectionGroup::new("", Vec::new())])
                .with_input(SearchBoxModel::new("Branch name").with_initial_query("ash/"))
                .with_action(
                    ListSelectionItem::new("Create branch")
                        .with_id(ListSelectionItemId::new("worktree:create")),
                )
                .without_tab_bar()
                .with_empty_message("New session on this branch. Project branch unchanged.");
        model.localize(self.language);
        let mut prompt = ListSelection::new(model, BTreeMap::new());
        prompt.state_mut().focus_search();
        self.worktree_name = Some(prompt);
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        match &mut self.worktree_name {
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
    let worktree_id = ListSelectionItemId::new("worktree:new");
    let branch_worktree_id = ListSelectionItemId::new("worktree:new-branch");
    actions.insert(worktree_id.clone(), BranchSelectionAction::NewWorktree);
    actions.insert(branch_worktree_id.clone(), BranchSelectionAction::NewBranch);
    let mut current = 0;
    let mut items = vec![
        ListSelectionItem::new("Worktrees").as_section_heading(),
        ListSelectionItem::new("New worktree")
            .with_id(worktree_id)
            .with_description("Detached · new session"),
        ListSelectionItem::new("New branch")
            .with_id(branch_worktree_id)
            .with_description("ash/ branch · new session"),
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
                actions.insert(
                    id.clone(),
                    BranchSelectionAction::Switch {
                        name: branch.name.clone(),
                        current: branch.current,
                    },
                );
                let description = if branch.current { "Current" } else { "Switch" };
                ListSelectionItem::new(branch.name)
                    .with_id(id)
                    .with_description(description)
            })
            .collect::<Vec<_>>(),
    );
    BranchChoices {
        model: ListSelectionModel::new(
            "Project branches and worktrees",
            vec![ListSelectionGroup::new("", items)],
        )
        .with_search(SearchBoxModel::new("Search branches"))
        .with_initial_selected(current + 4)
        .without_tab_bar()
        .with_empty_message("No matching branches"),
        actions,
    }
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
