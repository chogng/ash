use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::approval_environment::ApprovalEnvironmentReadParams;
use ash_app_server_protocol::protocol::approval_environment::ApprovalEnvironmentSaveParams;
use ash_app_server_protocol::protocol::approval_environment::ApprovalEnvironmentScanParams;
use ash_app_server_protocol::protocol::approval_environment::ApprovalEnvironmentScope;
use crossterm::event::KeyEvent;
use guardian_environment::EntryInput;
use guardian_environment::EntryKind;
use guardian_environment::EnvironmentEntry;
use guardian_environment::ScanOptions;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Open(ApprovalEnvironmentScope),
    Scan(ApprovalEnvironmentScanParams),
    Save(ApprovalEnvironmentSaveParams),
}

pub(crate) struct Event(pub(crate) Panel);

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    command: Command,
) -> Result<Event, String> {
    let (scope, root, revision, draft_id, entries, options, history) = match command {
        Command::Open(scope) => {
            let result = client
                .read_approval_environment(ApprovalEnvironmentReadParams {
                    scope: scope.clone(),
                })
                .map_err(|error| error.to_string())?;
            let mut entries = result.profile.entries;
            for observation in result.profile.observations {
                if !entries
                    .iter()
                    .any(|entry| entry.current && entry.source.id == observation.source.id)
                {
                    entries.push(observation);
                }
            }
            (
                scope,
                result.root,
                result.profile.revision,
                None,
                entries,
                result.scan_options,
                None,
            )
        }
        Command::Scan(params) => {
            let scope = params.scope.clone();
            let options = params.options.clone();
            let result = client
                .scan_approval_environment(params)
                .map_err(|error| error.to_string())?;
            (
                scope,
                result.root,
                result.draft.base_revision,
                Some(result.draft.id),
                result.draft.entries,
                options,
                result.history,
            )
        }
        Command::Save(params) => {
            let scope = params.scope.clone();
            let result = client
                .save_approval_environment(params)
                .map_err(|error| error.to_string())?;
            (
                scope,
                result.root,
                result.profile.revision,
                None,
                result.profile.entries,
                result.scan_options,
                None,
            )
        }
    };
    Ok(Event(Panel::new(
        scope, root, revision, draft_id, entries, options, history,
    )))
}

#[derive(Clone, Debug)]
enum Action {
    Scan,
    Save,
    RecentCommands,
    HistorySessions,
    HistoryCommands,
    HistoryDays,
    Toggle(usize),
}

/// The panel edits descriptions only. Source refresh and permission decisions stay in the backend.
#[derive(Debug)]
pub(crate) struct Panel {
    scope: ApprovalEnvironmentScope,
    revision: u64,
    draft_id: Option<String>,
    entries: Vec<EnvironmentEntry>,
    root: String,
    selection: ListSelection<Action>,
    language: crate::nls::Language,
    options: ScanOptions,
    history: Option<guardian_environment::HistoryCoverage>,
}

impl Panel {
    fn new(
        scope: ApprovalEnvironmentScope,
        root: String,
        revision: u64,
        draft_id: Option<String>,
        entries: Vec<EnvironmentEntry>,
        options: ScanOptions,
        history: Option<guardian_environment::HistoryCoverage>,
    ) -> Self {
        let selection = Self::selection(&root, &entries, &options, history.as_ref(), 0);
        Self {
            scope,
            revision,
            draft_id,
            entries,
            root,
            selection,
            language: crate::nls::Language::English,
            options,
            history,
        }
    }

    fn selection(
        root: &str,
        entries: &[EnvironmentEntry],
        options: &ScanOptions,
        history: Option<&guardian_environment::HistoryCoverage>,
        selected: usize,
    ) -> ListSelection<Action> {
        let mut items = Vec::new();
        let mut actions = BTreeMap::new();
        for (id, label, detail, action) in [
            ("scan".to_owned(), "Scan project…".to_owned(), "Reads bounded project files, including ASH.md. Shell history and other repositories are excluded.".to_owned(), Action::Scan),
            ("save".to_owned(), "Save reviewed background".to_owned(), "Follow project facts before review. New observations do not confirm ownership or grant permissions.".to_owned(), Action::Save),
        ] {
            let id = ListSelectionItemId::new(id);
            items.push(ListSelectionItem::new(label).with_details(detail).with_id(id.clone()));
            actions.insert(id, action);
        }
        for (index, entry) in entries.iter().enumerate() {
            let id = ListSelectionItemId::new(entry.id.clone());
            let status = if !entry.current {
                "Source changed"
            } else if entry.accepted {
                "Accepted"
            } else {
                "Unconfirmed observation"
            };
            let details = if let Some(source) = &entry.source.command {
                let samples = source
                    .samples
                    .iter()
                    .map(|sample| {
                        crate::nls::Text::template(
                            "Session {0}\nChat {1}\nTurn {2}\nRecorded at {3}",
                            vec![
                                sample.session_id.clone().into(),
                                sample.thread_id.clone().into(),
                                sample.turn_id.clone().into(),
                                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                                    i64::try_from(sample.recorded_at_unix_ms)
                                        .expect("history timestamps fit milliseconds"),
                                )
                                .expect("Guardian history timestamps are valid")
                                .format("%Y-%m-%d %H:%M UTC")
                                .to_string()
                                .into(),
                            ],
                        )
                    })
                    .reduce(|left, right| crate::nls::Text::template("{0}\n{1}", vec![left, right]))
                    .expect("a historical fact has a source sample");
                crate::nls::Text::template(
                    "{0} occurrences in {1} sessions\n{2}\n{3}",
                    vec![
                        source.occurrences.to_string().into(),
                        source.session_count.to_string().into(),
                        samples,
                        crate::nls::Text::literal(entry.content.clone()),
                    ],
                )
            } else {
                crate::nls::Text::literal(format!(
                    "{}\n{}\n{}",
                    entry.source.label, entry.source.revision, entry.content
                ))
            };
            items.push(
                ListSelectionItem::new(entry.title.clone())
                    .with_columns(entry.title.clone(), "", status)
                    .with_details(details)
                    .with_id(id.clone()),
            );
            if entry.current {
                actions.insert(id, Action::Toggle(index));
            }
        }
        let id = ListSelectionItemId::new("recent-commands");
        items.push(ListSelectionItem::new("Include recent project sessions")
            .with_columns("Include recent project sessions", "", if options.recent_commands { "Enabled" } else { "Disabled" })
            .with_details("Reads this directory’s sessions by recency. Aggregates command names and targets; excludes messages and ordinary arguments.")
            .with_id(id.clone()));
        actions.insert(id, Action::RecentCommands);
        if options.recent_commands {
            for (id, title, value, detail, action) in [
                (
                    "history-sessions",
                    "Session limit",
                    options.history.sessions.to_string(),
                    "Press Enter to cycle 50, 100, or 200 sessions.",
                    Action::HistorySessions,
                ),
                (
                    "history-commands",
                    "Commands per session",
                    options.history.commands_per_session.to_string(),
                    "Press Enter to cycle 200, 500, or 2000 commands per session.",
                    Action::HistoryCommands,
                ),
                (
                    "history-days",
                    "Time range",
                    options
                        .history
                        .days
                        .map_or("All dates".into(), |days| format!("{days}")),
                    "Press Enter to cycle all dates, 30 days, or 90 days.",
                    Action::HistoryDays,
                ),
            ] {
                let id = ListSelectionItemId::new(id);
                items.push(
                    ListSelectionItem::new(title)
                        .with_columns(title, "", value)
                        .with_details(detail)
                        .with_id(id.clone()),
                );
                actions.insert(id, action);
            }
        }
        if let Some(history) = history {
            items.push(ListSelectionItem::new("History scan coverage").with_id(ListSelectionItemId::new("history-coverage")).with_details(crate::nls::Text::template(
                "Scanned {0}/{1} sessions, {2}/{3} commands; kept {4}/{5} facts. Budgets can leave coverage partial.",
                [u64::from(history.sessions_scanned), history.sessions_available, u64::from(history.commands_scanned), history.commands_available, u64::from(history.facts_included), u64::from(history.facts_available)]
                    .into_iter().map(|value| value.to_string().into()).collect(),
            )));
        }
        let model = ListSelectionModel::new("Guardian", vec![ListSelectionGroup::new("", items)])
            .without_tab_bar()
            .with_expandable_descriptions()
            .with_initial_selected(selected);
        let mut selection = ListSelection::new(model, actions);
        selection.state_mut().set_message(Some(root.into()));
        selection
    }

    pub(crate) fn state(&self) -> &ListSelectionState {
        self.selection.state()
    }
    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.selection.state_mut()
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.selection.state_mut().localize(language);
    }
    pub(crate) fn paste(&mut self, text: String) {
        self.selection.handle_paste(text);
    }
    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        self.selection.key_hints()
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionOutcome<Command> {
        match self.selection.handle_key(key) {
            ListSelectionOutcome::Activate(Action::Scan) => {
                ListSelectionOutcome::Activate(Command::Scan(ApprovalEnvironmentScanParams {
                    scope: self.scope.clone(),
                    operation_id: crate::client::new_command_id("guardian-scan").to_string(),
                    options: self.options.clone(),
                    model: None,
                }))
            }
            ListSelectionOutcome::Activate(Action::Save) => {
                ListSelectionOutcome::Activate(Command::Save(ApprovalEnvironmentSaveParams {
                    scope: self.scope.clone(),
                    command_id: crate::client::new_command_id("guardian-save").to_string(),
                    expected_revision: self.revision,
                    draft_id: self.draft_id.clone(),
                    entries: self
                        .entries
                        .iter()
                        .filter(|entry| entry.accepted && entry.current)
                        .map(|entry| EntryInput {
                            id: entry.id.clone(),
                            kind: entry.kind,
                            title: entry.title.clone(),
                            content: entry.content.clone(),
                            source_id: Some(entry.source.id.clone()),
                        })
                        .collect(),
                }))
            }
            ListSelectionOutcome::Activate(Action::Toggle(index)) => {
                let selected = self.selection.state().selected_visible_index().unwrap_or(0);
                let entry = &mut self.entries[index];
                entry.accepted = !entry.accepted;
                // A fresh selection accepts factual background, never renews target ownership.
                if entry.accepted {
                    entry.kind = EntryKind::Fact;
                }
                self.selection = Self::selection(
                    &self.root,
                    &self.entries,
                    &self.options,
                    self.history.as_ref(),
                    selected,
                );
                self.selection.state_mut().localize(self.language);
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Activate(Action::RecentCommands) => {
                let selected = self.selection.state().selected_visible_index().unwrap_or(0);
                self.options.recent_commands = !self.options.recent_commands;
                self.selection = Self::selection(
                    &self.root,
                    &self.entries,
                    &self.options,
                    self.history.as_ref(),
                    selected,
                );
                self.selection.state_mut().localize(self.language);
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Activate(
                action @ (Action::HistorySessions | Action::HistoryCommands | Action::HistoryDays),
            ) => {
                match action {
                    Action::HistorySessions => {
                        self.options.history.sessions = match self.options.history.sessions {
                            50 => 100,
                            100 => 200,
                            _ => 50,
                        }
                    }
                    Action::HistoryCommands => {
                        self.options.history.commands_per_session =
                            match self.options.history.commands_per_session {
                                200 => 500,
                                500 => 2000,
                                _ => 200,
                            }
                    }
                    Action::HistoryDays => {
                        self.options.history.days = match self.options.history.days {
                            None => Some(30),
                            Some(30) => Some(90),
                            Some(_) => None,
                        }
                    }
                    Action::Scan | Action::Save | Action::RecentCommands | Action::Toggle(_) => {
                        unreachable!()
                    }
                }
                let selected = self.selection.state().selected_visible_index().unwrap_or(0);
                self.selection = Self::selection(
                    &self.root,
                    &self.entries,
                    &self.options,
                    self.history.as_ref(),
                    selected,
                );
                self.selection.state_mut().localize(self.language);
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Dismiss => ListSelectionOutcome::Dismiss,
            ListSelectionOutcome::Consumed
            | ListSelectionOutcome::Adjust(_, _)
            | ListSelectionOutcome::FocusPrevious => ListSelectionOutcome::Consumed,
        }
    }
}
