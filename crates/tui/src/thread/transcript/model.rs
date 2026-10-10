use super::exec_cell::ExecCell;
use super::history_cell::CellMode;
use super::history_cell::CellView;
use super::history_cell::ContentCell;
use super::history_cell::HistoryCell;
use super::history_cell::LocalCommandCell;
use crate::thread::presentation::present_turn_error;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::MessageRole;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::CommandId;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct TranscriptCellId(String);

impl TranscriptCellId {
    fn for_entry(entry_id: &str) -> Self {
        Self(format!("entry:{entry_id}"))
    }

    pub(in crate::thread) fn for_tool_call(tool_call_id: &ToolCallId) -> Self {
        Self(format!("exec:{}", tool_call_id.as_str()))
    }

    fn local(kind: &str, sequence: u64) -> Self {
        Self(format!("local:{kind}:{sequence}"))
    }

    pub(crate) fn from_render_key(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CellLifecycle {
    Live,
    Final,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum TranscriptCellBody {
    Content(ContentCell),
    Exec(ExecCell),
    LocalCommand(LocalCommandCell),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TranscriptCell {
    cell_id: TranscriptCellId,
    source_entry_id: Option<String>,
    client_id: Option<CommandId>,
    turn_id: Option<TurnId>,
    lifecycle: CellLifecycle,
    render_revision: u64,
    body: TranscriptCellBody,
}

impl TranscriptCell {
    pub(crate) fn history_view(&self) -> CellView<'_> {
        let mut view = self.view(false, false);
        view.mode = CellMode::History;
        view.can_expand = false;
        view.has_details = false;
        view
    }

    pub(crate) fn cell_id(&self) -> &TranscriptCellId {
        &self.cell_id
    }

    pub(super) fn turn_id(&self) -> Option<&TurnId> {
        self.turn_id.as_ref()
    }

    pub(crate) fn lifecycle(&self) -> CellLifecycle {
        match &self.body {
            TranscriptCellBody::Exec(exec) if exec.is_live() => CellLifecycle::Live,
            TranscriptCellBody::Exec(_) => CellLifecycle::Final,
            _ => self.lifecycle,
        }
    }

    pub(super) fn history_cell(&self) -> &dyn HistoryCell {
        match &self.body {
            TranscriptCellBody::Content(cell) => cell,
            TranscriptCellBody::Exec(cell) => cell,
            TranscriptCellBody::LocalCommand(cell) => cell,
        }
    }

    /// Empty provider reasoning can later receive a public summary; retain its
    /// source identity while omitting it from presentation and keyboard navigation.
    pub(crate) fn is_visible(&self) -> bool {
        !matches!(&self.body, TranscriptCellBody::Content(ContentCell { role: MessageRole::Reasoning, text }) if text.trim().is_empty())
    }

    pub(crate) fn can_expand(&self) -> bool {
        self.history_cell().can_expand()
    }
    pub(crate) fn has_details(&self) -> bool {
        self.history_cell().has_details()
    }
    pub(crate) fn details(&self) -> Option<String> {
        self.history_cell().full_details()
    }

    fn view(&self, expanded: bool, selected: bool) -> CellView<'_> {
        CellView {
            cell: Cow::Borrowed(self),
            cell_id: Some(self.cell_id.as_str().to_owned()),
            render_revision: self.render_revision,
            visible_source_end: None,
            can_expand: self.can_expand(),
            expanded,
            has_details: self.has_details(),
            selected,
            mode: if expanded {
                CellMode::Expanded
            } else {
                CellMode::Collapsed
            },
        }
    }

    fn source_ids(&self) -> Vec<&str> {
        match &self.body {
            TranscriptCellBody::Exec(exec) => exec.source_ids(),
            _ => self.source_entry_id.iter().map(String::as_str).collect(),
        }
    }

    fn is_local_user(&self) -> bool {
        self.source_entry_id.is_none()
            && matches!(
                &self.body,
                TranscriptCellBody::Content(ContentCell {
                    role: MessageRole::User,
                    ..
                })
            )
    }
}

#[derive(Debug, Default)]
pub(crate) struct TranscriptModel {
    cells: Vec<TranscriptCell>,
    unloaded_local_cells: Vec<(Option<String>, TranscriptCell)>,
    next_local_id: u64,
    next_render_revision: u64,
}

impl TranscriptModel {
    /// Only a final prefix outside the active turn can leave the editable viewport.
    pub(in crate::thread) fn history_prefix(&self, active: Option<&TurnId>) -> &[TranscriptCell] {
        let length = self
            .cells
            .iter()
            .take_while(|cell| {
                cell.lifecycle() == CellLifecycle::Final
                    && !active.is_some_and(|turn| cell.turn_id() == Some(turn))
                    && !cell.is_local_user()
            })
            .count();
        &self.cells[..length]
    }

    pub(in crate::thread) fn replace(&mut self, snapshot: ThreadTranscriptSnapshot) {
        let confirmed_local_users = snapshot
            .entries
            .iter()
            .filter_map(|entry| match entry {
                ThreadTranscriptEntry::Item { entry_id, item, .. } => {
                    item.client_id().map(|id| (id.clone(), entry_id.clone()))
                }
                ThreadTranscriptEntry::HookRun { .. }
                | ThreadTranscriptEntry::TurnPlan { .. }
                | ThreadTranscriptEntry::TurnError { .. }
                | ThreadTranscriptEntry::ToolOutput { .. } => None,
            })
            .collect::<BTreeMap<_, _>>();
        let mut local_cells = std::mem::take(&mut self.unloaded_local_cells);
        let mut preceding_source_id = None;
        for cell in std::mem::take(&mut self.cells) {
            let source_ids = cell.source_ids();
            if let Some(source_id) = source_ids.last() {
                preceding_source_id = Some((*source_id).to_owned());
            } else {
                local_cells.push((preceding_source_id.clone(), cell));
            }
        }
        self.cells.clear();
        for entry in snapshot.entries {
            self.upsert(entry);
        }
        let mut confirmed_anchors = BTreeMap::new();
        for (anchor, cell) in local_cells {
            if let Some(entry_id) = cell
                .client_id
                .as_ref()
                .and_then(|id| confirmed_local_users.get(id))
            {
                confirmed_anchors.insert(anchor.clone(), entry_id.clone());
                continue;
            }
            let effective_anchor = confirmed_anchors
                .get(&anchor)
                .map(String::as_str)
                .or(anchor.as_deref());
            let Some(mut insert_at) = self.local_insert_index(effective_anchor) else {
                self.unloaded_local_cells
                    .push((effective_anchor.map(str::to_owned), cell));
                continue;
            };
            while self
                .cells
                .get(insert_at)
                .is_some_and(|existing| existing.source_ids().is_empty())
            {
                insert_at += 1;
            }
            self.cells.insert(insert_at, cell);
        }
    }

    pub(in crate::thread) fn prepend_history(&mut self, snapshot: ThreadTranscriptSnapshot) {
        let existing = self
            .cells
            .iter()
            .flat_map(TranscriptCell::source_ids)
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let mut current = std::mem::take(&mut self.cells);
        for entry in snapshot.entries {
            if !existing.contains(entry.entry_id()) {
                self.upsert(entry);
            }
        }
        self.cells.append(&mut current);
        self.restore_local_cells();
    }

    pub(in crate::thread) fn apply(&mut self, update: ThreadTranscriptUpdateEnvelope) {
        for change in update.changes {
            match change {
                ThreadTranscriptChange::Upsert { entry } => self.upsert(entry),
                ThreadTranscriptChange::Remove { entry_ids } => self.remove(&entry_ids),
                ThreadTranscriptChange::ClearTransient => self.clear_transient(),
            }
        }
    }

    pub(in crate::thread) fn clear(&mut self) {
        self.cells.clear();
        self.unloaded_local_cells.clear();
    }

    pub(in crate::thread) fn views(
        &self,
        expanded: &BTreeSet<TranscriptCellId>,
        selected: Option<&TranscriptCellId>,
    ) -> Vec<CellView<'_>> {
        self.cells
            .iter()
            .filter(|cell| cell.is_visible())
            .map(|cell| {
                cell.view(
                    expanded.contains(cell.cell_id()),
                    selected == Some(cell.cell_id()),
                )
            })
            .collect()
    }

    pub(in crate::thread) fn has_user_message(&self) -> bool {
        self.cells.iter().any(|cell| {
            matches!(
                &cell.body,
                TranscriptCellBody::Content(ContentCell {
                    role: MessageRole::User,
                    ..
                })
            )
        })
    }

    pub(in crate::thread) fn latest_agent_response(&self) -> Option<&str> {
        self.cells.iter().rev().find_map(|cell| match &cell.body {
            TranscriptCellBody::Content(ContentCell {
                role: MessageRole::Agent,
                text,
            }) => Some(text.as_str()),
            _ => None,
        })
    }

    pub(in crate::thread) fn cells(&self) -> &[TranscriptCell] {
        &self.cells
    }

    pub(in crate::thread) fn details(&self, cell_id: &TranscriptCellId) -> Option<String> {
        self.cells
            .iter()
            .find(|cell| cell.cell_id() == cell_id)
            .and_then(TranscriptCell::details)
    }

    pub(in crate::thread) fn push_user_message(&mut self, command_id: CommandId, text: String) {
        let cell_id = self.local_id("message");
        let render_revision = self.render_revision();
        self.cells.push(TranscriptCell {
            cell_id,
            source_entry_id: None,
            client_id: Some(command_id),
            turn_id: None,
            lifecycle: CellLifecycle::Final,
            render_revision,
            body: TranscriptCellBody::Content(ContentCell {
                role: MessageRole::User,
                text,
            }),
        });
    }

    pub(in crate::thread) fn push_notice(&mut self, text: String) {
        let cell_id = self.local_id("notice");
        let render_revision = self.render_revision();
        self.cells.push(TranscriptCell {
            cell_id,
            source_entry_id: None,
            client_id: None,
            turn_id: None,
            lifecycle: CellLifecycle::Final,
            render_revision,
            body: TranscriptCellBody::Content(ContentCell::new(MessageRole::Notice, text)),
        });
    }

    pub(in crate::thread) fn push_error(&mut self, text: String) {
        let cell_id = self.local_id("error");
        let render_revision = self.render_revision();
        self.cells.push(TranscriptCell {
            cell_id,
            source_entry_id: None,
            client_id: None,
            turn_id: None,
            lifecycle: CellLifecycle::Final,
            render_revision,
            body: TranscriptCellBody::Content(ContentCell::new(MessageRole::Error, text)),
        });
    }

    pub(in crate::thread) fn command_submitted(
        &mut self,
        command: String,
        completion: super::LocalCommandCompletion,
    ) {
        let cell_id = self.local_id("command");
        let render_revision = self.render_revision();
        self.cells.push(TranscriptCell {
            cell_id,
            source_entry_id: None,
            client_id: None,
            turn_id: None,
            lifecycle: match completion {
                super::LocalCommandCompletion::Immediate => CellLifecycle::Final,
                super::LocalCommandCompletion::Deferred => CellLifecycle::Live,
            },
            render_revision,
            body: TranscriptCellBody::LocalCommand(LocalCommandCell {
                command,
                result: None,
                status: CommandStatus::Submitted,
            }),
        });
    }

    pub(in crate::thread) fn command_started(&mut self, command: String) {
        let render_revision = self.render_revision();
        if let Some(cell) = self.cells.iter_mut().rev().find(|cell| {
            matches!(
                &cell.body,
                TranscriptCellBody::LocalCommand(LocalCommandCell {
                    command: submitted,
                    result: None,
                    status: CommandStatus::Submitted,
                }) if submitted == &command
            )
        }) {
            cell.lifecycle = CellLifecycle::Live;
            cell.render_revision = render_revision;
            cell.body = TranscriptCellBody::LocalCommand(LocalCommandCell {
                command,
                result: None,
                status: CommandStatus::Running,
            });
            return;
        }
        let cell_id = self.local_id("command");
        self.cells.push(TranscriptCell {
            cell_id,
            source_entry_id: None,
            client_id: None,
            turn_id: None,
            lifecycle: CellLifecycle::Live,
            render_revision,
            body: TranscriptCellBody::LocalCommand(LocalCommandCell {
                command,
                result: None,
                status: CommandStatus::Running,
            }),
        });
    }

    pub(in crate::thread) fn command_completed(
        &mut self,
        command: String,
        result: String,
        status: CommandStatus,
    ) {
        let render_revision = self.render_revision();
        if let Some(cell) = self.cells.iter_mut().rev().find(|cell| {
            matches!(
                &cell.body,
                TranscriptCellBody::LocalCommand(LocalCommandCell {
                    command: active,
                    result: None,
                    status: CommandStatus::Submitted | CommandStatus::Running,
                    ..
                }) if active == &command
            )
        }) {
            cell.lifecycle = CellLifecycle::Final;
            cell.render_revision = render_revision;
            cell.body = TranscriptCellBody::LocalCommand(LocalCommandCell {
                command,
                result: Some(result),
                status,
            });
            return;
        }
        let cell_id = self.local_id("command");
        self.cells.push(TranscriptCell {
            cell_id,
            source_entry_id: None,
            client_id: None,
            turn_id: None,
            lifecycle: CellLifecycle::Final,
            render_revision,
            body: TranscriptCellBody::LocalCommand(LocalCommandCell {
                command,
                result: Some(result),
                status,
            }),
        });
    }

    pub(in crate::thread) fn command_failed(&mut self, command: String, error: String) {
        let pending = self.cells.iter().any(|cell| {
            cell.lifecycle() == CellLifecycle::Live
                && matches!(&cell.body, TranscriptCellBody::LocalCommand(local) if local.command == command)
        });
        if pending {
            self.command_completed(command, error, CommandStatus::Failed);
        } else {
            // Panel requests have already acknowledged their input. Their failure is
            // new content, not a revision of the command already in scrollback.
            self.push_error(error);
        }
    }

    fn upsert(&mut self, entry: ThreadTranscriptEntry) {
        let render_revision = self.render_revision();
        match entry {
            // Hook observations are retained by Thread history; terminal tool feedback is
            // already presented through the canonical ToolResult in this client.
            ThreadTranscriptEntry::HookRun { .. } => {}
            ThreadTranscriptEntry::Item {
                entry_id,
                turn_id,
                item:
                    ThreadItem::ToolCall {
                        tool_call_id,
                        name,
                        arguments_json,
                        binding,
                        ..
                    },
                ..
            } => self.upsert_tool_call(
                entry_id,
                turn_id,
                tool_call_id,
                name,
                pretty_json(&arguments_json),
                binding.and_then(|binding| binding.activity),
                render_revision,
            ),
            ThreadTranscriptEntry::Item {
                entry_id,
                turn_id,
                item:
                    ThreadItem::ToolResult {
                        tool_call_id,
                        text,
                        is_error,
                        ..
                    },
                ..
            } => self.complete_tool(
                entry_id,
                turn_id,
                tool_call_id,
                text,
                is_error,
                render_revision,
            ),
            ThreadTranscriptEntry::ToolOutput {
                entry_id,
                turn_id,
                tool_call_id,
                stream,
                text,
                ..
            } => self.apply_tool_output(
                entry_id,
                turn_id,
                tool_call_id,
                stream,
                text,
                render_revision,
            ),
            entry => self.upsert_regular(cell_from_entry(&entry, render_revision)),
        }
    }

    fn upsert_regular(&mut self, cell: TranscriptCell) {
        if let Some(existing) = self
            .cells
            .iter_mut()
            .find(|existing| existing.source_entry_id == cell.source_entry_id)
        {
            *existing = cell;
        } else {
            // RPC completion and transcript notifications arrive independently. Only the
            // submission identity can acknowledge a local row; equal text can be another message.
            if let Some(index) = cell.client_id.as_ref().and_then(|id| {
                self.cells.iter().position(|existing| {
                    existing.source_entry_id.is_none() && existing.client_id.as_ref() == Some(id)
                })
            }) {
                self.cells[index] = cell;
            } else {
                self.cells.push(cell);
            }
        }
    }

    fn upsert_tool_call(
        &mut self,
        entry_id: String,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        name: ash_protocol::ToolName,
        arguments: String,
        activity: Option<ash_protocol::ToolActivity>,
        render_revision: u64,
    ) {
        if let Some(cell) = self.cell_for_call_mut(&tool_call_id) {
            let TranscriptCellBody::Exec(exec) = &mut cell.body else {
                unreachable!("a matched ToolCall is owned by an ExecCell")
            };
            exec.update_call(entry_id, &tool_call_id, &name, arguments, activity);
            cell.render_revision = render_revision;
            return;
        }
        if let Some(TranscriptCell {
            body: TranscriptCellBody::Exec(exec),
            turn_id: group_turn,
            ..
        }) = self.cells.last_mut()
            && group_turn.as_ref() == Some(&turn_id)
            && exec.can_accept(activity.as_ref())
        {
            exec.push_call(entry_id, tool_call_id, &name, arguments, activity);
            let last = self
                .cells
                .last_mut()
                .expect("the grouped ExecCell remains the last cell");
            last.render_revision = render_revision;
            return;
        }
        self.cells.push(TranscriptCell {
            cell_id: TranscriptCellId::for_tool_call(&tool_call_id),
            source_entry_id: None,
            client_id: None,
            turn_id: Some(turn_id.clone()),
            lifecycle: CellLifecycle::Live,
            render_revision,
            body: TranscriptCellBody::Exec(ExecCell::start(
                entry_id,
                tool_call_id,
                &name,
                arguments,
                activity,
            )),
        });
    }

    fn apply_tool_output(
        &mut self,
        entry_id: String,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        stream: ash_protocol::ToolOutputStream,
        text: String,
        render_revision: u64,
    ) {
        if self.exec_for_call_mut(&tool_call_id).is_none() {
            self.cells.push(TranscriptCell {
                cell_id: TranscriptCellId::for_tool_call(&tool_call_id),
                source_entry_id: None,
                client_id: None,
                turn_id: Some(turn_id.clone()),
                lifecycle: CellLifecycle::Live,
                render_revision,
                body: TranscriptCellBody::Exec(ExecCell::recovered(tool_call_id.clone())),
            });
        }
        let cell = self
            .cell_for_call_mut(&tool_call_id)
            .expect("the recovered ExecCell owns the ToolCall");
        let TranscriptCellBody::Exec(exec) = &mut cell.body else {
            unreachable!("a matched ToolCall is owned by an ExecCell")
        };
        exec.apply_output(entry_id, &tool_call_id, stream, text);
        cell.render_revision = render_revision;
    }

    fn complete_tool(
        &mut self,
        entry_id: String,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        result: String,
        failed: bool,
        render_revision: u64,
    ) {
        if self.exec_for_call_mut(&tool_call_id).is_none() {
            self.cells.push(TranscriptCell {
                cell_id: TranscriptCellId::for_tool_call(&tool_call_id),
                source_entry_id: None,
                client_id: None,
                turn_id: Some(turn_id.clone()),
                lifecycle: CellLifecycle::Final,
                render_revision,
                body: TranscriptCellBody::Exec(ExecCell::recovered(tool_call_id.clone())),
            });
        }
        let cell = self
            .cell_for_call_mut(&tool_call_id)
            .expect("the recovered ExecCell owns the ToolCall");
        let TranscriptCellBody::Exec(exec) = &mut cell.body else {
            unreachable!("a matched ToolCall is owned by an ExecCell")
        };
        exec.complete(entry_id, &tool_call_id, result, failed);
        cell.render_revision = render_revision;
    }

    fn exec_for_call_mut(&mut self, tool_call_id: &ToolCallId) -> Option<&mut ExecCell> {
        self.cells.iter_mut().find_map(|cell| match &mut cell.body {
            TranscriptCellBody::Exec(exec) if exec.contains_call(tool_call_id) => Some(exec),
            _ => None,
        })
    }

    fn cell_for_call_mut(&mut self, tool_call_id: &ToolCallId) -> Option<&mut TranscriptCell> {
        self.cells.iter_mut().find(|cell| {
            matches!(&cell.body, TranscriptCellBody::Exec(exec) if exec.contains_call(tool_call_id))
        })
    }

    fn remove(&mut self, entry_ids: &[String]) {
        for entry_id in entry_ids {
            let render_revision = self.render_revision();
            for cell in &mut self.cells {
                if let TranscriptCellBody::Exec(exec) = &mut cell.body
                    && exec.contains_source(entry_id)
                {
                    exec.remove_entry(entry_id);
                    cell.render_revision = render_revision;
                }
            }
            self.cells.retain(|cell| {
                cell.source_entry_id.as_deref() != Some(entry_id)
                    || matches!(&cell.body, TranscriptCellBody::Exec(exec) if !exec.is_empty())
            });
        }
        self.cells.retain(
            |cell| !matches!(&cell.body, TranscriptCellBody::Exec(exec) if exec.is_empty()),
        );
    }

    fn clear_transient(&mut self) {
        let render_revision = self.render_revision();
        for cell in &mut self.cells {
            if let TranscriptCellBody::Exec(exec) = &mut cell.body {
                exec.clear_live();
                cell.render_revision = render_revision;
            }
        }
        self.cells.retain(|cell| {
            cell.lifecycle() == CellLifecycle::Final
                && !matches!(&cell.body, TranscriptCellBody::Exec(exec) if exec.is_empty())
        });
    }

    fn local_id(&mut self, kind: &str) -> TranscriptCellId {
        self.next_local_id = self.next_local_id.saturating_add(1);
        TranscriptCellId::local(kind, self.next_local_id)
    }

    fn render_revision(&mut self) -> u64 {
        self.next_render_revision = self.next_render_revision.wrapping_add(1).max(1);
        self.next_render_revision
    }

    fn restore_local_cells(&mut self) {
        for (anchor, cell) in std::mem::take(&mut self.unloaded_local_cells) {
            let Some(mut index) = self.local_insert_index(anchor.as_deref()) else {
                self.unloaded_local_cells.push((anchor, cell));
                continue;
            };
            while self
                .cells
                .get(index)
                .is_some_and(|cell| cell.source_ids().is_empty())
            {
                index += 1;
            }
            self.cells.insert(index, cell);
        }
    }

    fn local_insert_index(&self, preceding_source_id: Option<&str>) -> Option<usize> {
        match preceding_source_id {
            None => Some(0),
            Some(source_id) => self
                .cells
                .iter()
                .position(|cell| cell.source_ids().contains(&source_id))
                .map(|index| index + 1),
        }
    }
}

fn cell_from_entry(entry: &ThreadTranscriptEntry, render_revision: u64) -> TranscriptCell {
    let entry_id = entry.entry_id().to_owned();
    let lifecycle = if entry.is_transient() {
        CellLifecycle::Live
    } else {
        CellLifecycle::Final
    };
    let body = match entry {
        ThreadTranscriptEntry::HookRun { .. } => {
            unreachable!("Hook observations do not create terminal cells")
        }
        ThreadTranscriptEntry::Item { item, .. } => match item {
            ThreadItem::UserMessage { text, .. } => TranscriptCellBody::Content(ContentCell {
                role: MessageRole::User,
                text: text.clone(),
            }),
            ThreadItem::UserContext { name, content, .. } => {
                TranscriptCellBody::Content(ContentCell {
                    role: MessageRole::User,
                    text: format!("Context · {name}\n{content}"),
                })
            }
            ThreadItem::UserImage { .. } | ThreadItem::UserImageAttachment { .. } => {
                TranscriptCellBody::Content(ContentCell {
                    role: MessageRole::User,
                    text: "[Image]".into(),
                })
            }
            ThreadItem::UserAudioAttachment { attachment, .. } => {
                TranscriptCellBody::Content(ContentCell {
                    role: MessageRole::User,
                    text: format!(
                        "[Audio · {} seconds]",
                        attachment.duration_ms.div_ceil(1000)
                    ),
                })
            }
            ThreadItem::AgentMessage { text, .. } => TranscriptCellBody::Content(ContentCell {
                role: MessageRole::Agent,
                text: text.clone(),
            }),
            ThreadItem::Reasoning { text, .. } => {
                TranscriptCellBody::Content(ContentCell::new(MessageRole::Reasoning, text.clone()))
            }
            ThreadItem::Plan { text, .. } => {
                TranscriptCellBody::Content(ContentCell::new(MessageRole::Plan, text.clone()))
            }
            ThreadItem::ToolCall { .. } | ThreadItem::ToolResult { .. } => {
                unreachable!("Tool entries are routed into ExecCell")
            }
        },
        ThreadTranscriptEntry::TurnPlan { plan, .. } => {
            TranscriptCellBody::Content(ContentCell::new(MessageRole::Plan, present_plan(plan)))
        }
        ThreadTranscriptEntry::TurnError { error, .. } => TranscriptCellBody::Content(
            ContentCell::new(MessageRole::Error, present_turn_error(error)),
        ),
        ThreadTranscriptEntry::ToolOutput { .. } => {
            unreachable!("Tool output is routed into ExecCell")
        }
    };
    TranscriptCell {
        cell_id: TranscriptCellId::for_entry(&entry_id),
        source_entry_id: Some(entry_id),
        client_id: match entry {
            ThreadTranscriptEntry::Item { item, .. } => item.client_id().cloned(),
            ThreadTranscriptEntry::HookRun { .. }
            | ThreadTranscriptEntry::TurnPlan { .. }
            | ThreadTranscriptEntry::TurnError { .. }
            | ThreadTranscriptEntry::ToolOutput { .. } => None,
        },
        turn_id: Some(entry.turn_id().clone()),
        lifecycle,
        render_revision,
        body,
    }
}

fn pretty_json(value: &str) -> String {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| value.to_owned())
}

fn present_plan(plan: &PlanUpdate) -> String {
    let mut lines = plan.explanation.iter().cloned().collect::<Vec<_>>();
    lines.extend(plan.steps.iter().map(|step| {
        let marker = match step.status {
            PlanStepStatus::Pending => "[ ]",
            PlanStepStatus::InProgress => "[>]",
            PlanStepStatus::Completed => "[x]",
        };
        format!("{marker} {}", step.step)
    }));
    if lines.is_empty() {
        "Plan updated".into()
    } else {
        lines.join("\n")
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "fixtures.rs"]
mod fixtures;
