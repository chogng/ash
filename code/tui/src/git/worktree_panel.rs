use crate::nls::Language;
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
use ash_app_server_protocol::protocol::git::GitWorktreeListResult;
use ash_app_server_protocol::protocol::git::GitWorktreeStateDto;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use std::collections::BTreeMap;

pub(crate) type WorktreeChoices = ListSelectionSpec<WorktreeSelectionAction>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorktreeSelectionAction {
    New,
    Create {
        name: String,
    },
    Open {
        checkout_root: String,
        current: bool,
    },
    Unavailable {
        message: &'static str,
    },
}

#[derive(Debug)]
pub(crate) struct WorktreePanel {
    picker: ListSelection<WorktreeSelectionAction>,
    name: Option<ListSelection<WorktreeSelectionAction>>,
    language: Language,
    picker_hints: KeyHints,
    prompt_hints: KeyHints,
}

impl WorktreePanel {
    pub(crate) fn new(spec: WorktreeChoices) -> Self {
        Self {
            picker: ListSelection::new(spec.model, spec.actions),
            name: None,
            language: Language::English,
            picker_hints: KeyHints::compact()
                .with_compact_action("n", "New worktree")
                .with_compact_action("/", "search")
                .with_compact_action("Esc", "close"),
            prompt_hints: KeyHints::new()
                .with_action("Enter", "create")
                .with_action("Esc", "back"),
        }
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        self.name.as_ref().unwrap_or(&self.picker).state()
    }

    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.name.as_mut().unwrap_or(&mut self.picker).state_mut()
    }

    pub(crate) fn is_name_prompt(&self) -> bool {
        self.name.is_some()
    }

    pub(crate) fn parent_title(&self) -> Option<&str> {
        self.name.as_ref().map(|_| self.picker.state().title())
    }

    pub(crate) fn return_to_parent(&mut self) {
        self.name = None;
    }

    pub(crate) fn localize(&mut self, language: Language) {
        self.language = language;
        self.picker.state_mut().localize(language);
        if let Some(name) = &mut self.name {
            name.state_mut().localize(language);
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        if self.name.is_some() {
            &self.prompt_hints
        } else {
            &self.picker_hints
        }
    }

    pub(crate) fn handle_key(
        &mut self,
        key: KeyEvent,
    ) -> ListSelectionOutcome<WorktreeSelectionAction> {
        if key.kind == KeyEventKind::Press && key.code == KeyCode::Esc && self.name.is_some() {
            self.name = None;
            return ListSelectionOutcome::Consumed;
        }
        if let Some(name) = &mut self.name {
            return handle_name_key(name, key);
        }
        let outcome = if key.kind == KeyEventKind::Press
            && key.modifiers == KeyModifiers::NONE
            && key.code == KeyCode::Char('n')
            && self.picker.state().items_focused()
        {
            ListSelectionOutcome::Activate(WorktreeSelectionAction::New)
        } else {
            self.picker.handle_key(key)
        };
        match outcome {
            ListSelectionOutcome::Activate(WorktreeSelectionAction::New) => {
                self.name = Some(name_prompt(self.language));
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Activate(WorktreeSelectionAction::Unavailable { message }) => {
                self.picker.state_mut().set_message(Some(message.into()));
                ListSelectionOutcome::Consumed
            }
            outcome => outcome,
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if let Some(name) = &mut self.name {
            name.handle_paste(pasted);
            name.state_mut().set_message(None);
        } else {
            self.picker.handle_paste(pasted);
        }
    }
}

fn name_prompt(language: Language) -> ListSelection<WorktreeSelectionAction> {
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

fn handle_name_key(
    prompt: &mut ListSelection<WorktreeSelectionAction>,
    key: KeyEvent,
) -> ListSelectionOutcome<WorktreeSelectionAction> {
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
        return ListSelectionOutcome::Activate(WorktreeSelectionAction::Create {
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

pub(crate) fn worktree_choices(
    result: GitWorktreeListResult,
    selected_checkout: Option<&str>,
) -> WorktreeChoices {
    let mut actions = BTreeMap::new();
    let create_id = ListSelectionItemId::new("worktree:new");
    actions.insert(create_id.clone(), WorktreeSelectionAction::New);
    let mut selected = 1;
    let mut items = vec![
        ListSelectionItem::new("New worktree")
            .with_id(create_id)
            .with_description("Create at HEAD · no session"),
    ];
    for (index, worktree) in result.worktrees.into_iter().enumerate() {
        if selected_checkout == Some(worktree.checkout_root.as_str())
            || (selected_checkout.is_none() && worktree.current)
        {
            selected = index + 1;
        }
        let id = ListSelectionItemId::new(format!("worktree:{}", worktree.checkout_root));
        let message = state_message(worktree.state);
        let action = if worktree.state == GitWorktreeStateDto::Ready {
            WorktreeSelectionAction::Open {
                checkout_root: worktree.checkout_root.clone(),
                current: worktree.current,
            }
        } else {
            WorktreeSelectionAction::Unavailable { message }
        };
        actions.insert(id.clone(), action);
        let reference = match worktree.branch {
            Some(branch) => Text::literal(branch),
            None => Text::template(
                "{0} {1}",
                vec![
                    Text::from("Detached at"),
                    Text::literal(&worktree.head[..7.min(worktree.head.len())]),
                ],
            ),
        };
        let state = if worktree.current { "Current" } else { message };
        let checkout = worktree.checkout_root.trim_end_matches(['/', '\\']);
        let name = if checkout.is_empty() {
            worktree.checkout_root.as_str()
        } else {
            checkout
                .rsplit(['/', '\\'])
                .next()
                .expect("a non-empty path has a final component")
        };
        items.push(
            ListSelectionItem::new(Text::literal(name))
                .with_id(id)
                .with_description(Text::template(
                    "{0} · {1} · {2}",
                    vec![Text::from(state), reference, Text::literal(worktree.path)],
                )),
        );
    }
    WorktreeChoices {
        model: ListSelectionModel::new(
            "Project worktrees",
            vec![ListSelectionGroup::new("", items)],
        )
        .with_search(SearchBoxModel::new("Search worktrees"))
        .with_initial_selected(selected)
        .without_tab_bar()
        .with_empty_message("No matching worktrees"),
        actions,
    }
}

fn state_message(state: GitWorktreeStateDto) -> &'static str {
    match state {
        GitWorktreeStateDto::Ready => "Enter to open",
        GitWorktreeStateDto::ThreadOwned => "Used by another session",
        GitWorktreeStateDto::Locked => "Worktree is locked",
        GitWorktreeStateDto::Prunable => "Worktree is missing",
        GitWorktreeStateDto::Invalid => "Worktree ownership is invalid",
        GitWorktreeStateDto::MissingDirectory => "Working directory is missing",
    }
}
