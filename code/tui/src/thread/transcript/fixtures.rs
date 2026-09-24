//! Owned real cells for renderer tests; production views borrow the transcript model.
use super::CellLifecycle;
use super::CellMode;
use super::CellView;
use super::ContentCell;
use super::LocalCommandCell;
use super::MessageRole;
use super::TranscriptCell;
use super::TranscriptCellBody;
use super::TranscriptCellId;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::exec_cell::ExecCell;
use std::borrow::Cow;

impl CellView<'static> {
    fn owned(body: TranscriptCellBody) -> Self {
        let cell = TranscriptCell {
            cell_id: TranscriptCellId::from_render_key("fixture"),
            source_entry_id: None,
            turn_id: None,
            lifecycle: CellLifecycle::Final,
            render_revision: 0,
            body,
        };
        Self {
            can_expand: cell.can_expand(),
            has_details: cell.has_details(),
            cell: Cow::Owned(cell),
            cell_id: None,
            visible_source_end: None,
            render_revision: 0,
            expanded: false,
            selected: false,
            mode: CellMode::Collapsed,
        }
    }

    pub(crate) fn plain(role: MessageRole, text: String) -> Self {
        Self::owned(TranscriptCellBody::Content(ContentCell::new(role, text)))
    }

    pub(crate) fn local_command(
        command: String,
        status: CommandStatus,
        result: Option<String>,
    ) -> Self {
        Self::owned(TranscriptCellBody::LocalCommand(LocalCommandCell {
            command,
            status,
            result,
        }))
    }

    pub(crate) fn exec(name: &str, status: CommandStatus) -> Self {
        let id = ash_protocol::ToolCallId::new("call").unwrap();
        let mut cell = ExecCell::start(
            "entry".into(),
            id.clone(),
            &ash_protocol::ToolName::new(name).unwrap(),
            String::new(),
        );
        if matches!(status, CommandStatus::Succeeded | CommandStatus::Failed) {
            cell.complete(
                "result".into(),
                &id,
                String::new(),
                status == CommandStatus::Failed,
            );
        }
        Self::owned(TranscriptCellBody::Exec(cell))
    }

    pub(crate) fn with_cell_id(mut self, id: impl Into<String>) -> Self {
        self.cell_id = Some(id.into());
        self
    }
    pub(crate) fn with_render_revision(mut self, revision: u64) -> Self {
        self.render_revision = revision;
        self
    }
    pub(crate) fn with_presentation(mut self, expanded: bool, selected: bool) -> Self {
        self.expanded = expanded;
        self.selected = selected;
        self.mode = if expanded {
            CellMode::Expanded
        } else {
            CellMode::Collapsed
        };
        self
    }
    pub(crate) fn with_detail(mut self, detail: impl Into<String>) -> Self {
        match &mut self.cell.to_mut().body {
            TranscriptCellBody::Content(cell) => cell.text = detail.into(),
            TranscriptCellBody::LocalCommand(cell) => cell.result = Some(detail.into()),
            TranscriptCellBody::Exec(_) => {
                panic!("execution fixtures use ToolOutput/ToolResult events")
            }
        }
        self.can_expand = self.cell.can_expand();
        self.has_details = self.cell.has_details();
        self
    }
}

impl CellView<'_> {
    pub(crate) fn command_status(&self) -> Option<CommandStatus> {
        match &self.cell.body {
            TranscriptCellBody::LocalCommand(cell) => Some(cell.status),
            TranscriptCellBody::Exec(cell) => Some(cell.status()),
            _ => None,
        }
    }
}
