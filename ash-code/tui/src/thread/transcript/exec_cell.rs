mod render;

use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::TranscriptCellId;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExecutionKind {
    Command,
    Mutation,
    Neutral,
}

const MAX_GROUP_CALLS: usize = 16;
const MAX_LIVE_BYTES: usize = 64 * 1024;
const MAX_LIVE_LINES: usize = 200;
const MAX_LINE_BYTES: usize = 4 * 1024;
const MAX_FINAL_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ExecGroup {
    SingleExec,
    ExploreGroup,
    CompactCommandGroup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExecClass {
    Read,
    Search,
    List,
    Command,
    Mutation,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExecCall {
    tool_call_id: ToolCallId,
    name: String,
    arguments: String,
    class: ExecClass,
    call_entry_id: Option<String>,
    stdout_entry_ids: BTreeSet<String>,
    stderr_entry_ids: BTreeSet<String>,
    result_entry_id: Option<String>,
    stdout: String,
    stderr: String,
    result: Option<String>,
    failed: bool,
}

impl ExecCall {
    fn new(
        entry_id: Option<String>,
        tool_call_id: ToolCallId,
        name: String,
        arguments: String,
    ) -> Self {
        let class = classify(&name);
        Self {
            tool_call_id,
            name,
            arguments,
            class,
            call_entry_id: entry_id,
            stdout_entry_ids: BTreeSet::new(),
            stderr_entry_ids: BTreeSet::new(),
            result_entry_id: None,
            stdout: String::new(),
            stderr: String::new(),
            result: None,
            failed: false,
        }
    }

    fn is_complete(&self) -> bool {
        self.result.is_some()
    }

    fn is_empty(&self) -> bool {
        self.call_entry_id.is_none()
            && self.stdout_entry_ids.is_empty()
            && self.stderr_entry_ids.is_empty()
            && self.result_entry_id.is_none()
    }

    fn source_ids(&self) -> impl Iterator<Item = &str> {
        self.call_entry_id
            .iter()
            .map(String::as_str)
            .chain(self.stdout_entry_ids.iter().map(String::as_str))
            .chain(self.stderr_entry_ids.iter().map(String::as_str))
            .chain(self.result_entry_id.iter().map(String::as_str))
    }

    fn remove_entry(&mut self, entry_id: &str) {
        if self.call_entry_id.as_deref() == Some(entry_id) {
            self.call_entry_id = None;
        }
        if self.stdout_entry_ids.remove(entry_id) && self.stdout_entry_ids.is_empty() {
            self.stdout.clear();
        }
        if self.stderr_entry_ids.remove(entry_id) && self.stderr_entry_ids.is_empty() {
            self.stderr.clear();
        }
        if self.result_entry_id.as_deref() == Some(entry_id) {
            self.result_entry_id = None;
            self.result = None;
            self.failed = false;
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ExecCell {
    cell_id: TranscriptCellId,
    group: ExecGroup,
    calls: Vec<ExecCall>,
}

impl ExecCell {
    pub(super) fn start(
        entry_id: String,
        tool_call_id: ToolCallId,
        name: &ToolName,
        arguments: String,
    ) -> Self {
        let cell_id = TranscriptCellId::for_tool_call(&tool_call_id);
        let call = ExecCall::new(
            Some(entry_id.clone()),
            tool_call_id,
            name.as_str().to_owned(),
            arguments,
        );
        let group = group_for(call.class);
        Self {
            cell_id,
            group,
            calls: vec![call],
        }
    }

    pub(super) fn recovered(tool_call_id: ToolCallId) -> Self {
        Self {
            cell_id: TranscriptCellId::for_tool_call(&tool_call_id),
            group: ExecGroup::SingleExec,
            calls: vec![ExecCall::new(
                None,
                tool_call_id,
                "tool".into(),
                String::new(),
            )],
        }
    }

    pub(super) fn contains_source(&self, entry_id: &str) -> bool {
        self.calls
            .iter()
            .any(|call| call.source_ids().any(|source| source == entry_id))
    }

    pub(super) fn source_ids(&self) -> Vec<&str> {
        self.calls.iter().flat_map(ExecCall::source_ids).collect()
    }

    pub(super) fn contains_call(&self, tool_call_id: &ToolCallId) -> bool {
        self.calls
            .iter()
            .any(|call| &call.tool_call_id == tool_call_id)
    }

    pub(super) fn can_accept(&self, name: &ToolName) -> bool {
        if self.calls.len() >= MAX_GROUP_CALLS {
            return false;
        }
        let class = classify(name.as_str());
        match self.group {
            ExecGroup::ExploreGroup => {
                matches!(class, ExecClass::Read | ExecClass::Search | ExecClass::List)
            }
            ExecGroup::CompactCommandGroup => {
                class == ExecClass::Command
                    && self
                        .calls
                        .iter()
                        .all(|call| call.is_complete() && !call.failed)
            }
            ExecGroup::SingleExec => false,
        }
    }

    pub(super) fn push_call(
        &mut self,
        entry_id: String,
        tool_call_id: ToolCallId,
        name: &ToolName,
        arguments: String,
    ) {
        self.calls.push(ExecCall::new(
            Some(entry_id),
            tool_call_id,
            name.as_str().to_owned(),
            arguments,
        ));
    }

    pub(super) fn update_call(
        &mut self,
        entry_id: String,
        tool_call_id: &ToolCallId,
        name: &ToolName,
        arguments: String,
    ) {
        if let Some(call) = self.call_mut(tool_call_id) {
            call.call_entry_id = Some(entry_id);
            call.name = name.as_str().to_owned();
            call.arguments = arguments;
            call.class = classify(&call.name);
        }
    }

    pub(super) fn apply_output(
        &mut self,
        entry_id: String,
        tool_call_id: &ToolCallId,
        stream: ToolOutputStream,
        text: String,
    ) {
        let Some(call) = self.call_mut(tool_call_id) else {
            return;
        };
        let text = bounded_text(&text, MAX_LIVE_BYTES, MAX_LIVE_LINES);
        match stream {
            ToolOutputStream::Stdout => {
                call.stdout_entry_ids.insert(entry_id);
                call.stdout = text;
            }
            ToolOutputStream::Stderr => {
                call.stderr_entry_ids.insert(entry_id);
                call.stderr = text;
            }
        }
    }

    pub(super) fn complete(
        &mut self,
        entry_id: String,
        tool_call_id: &ToolCallId,
        result: String,
        failed: bool,
    ) {
        let Some(call) = self.call_mut(tool_call_id) else {
            return;
        };
        call.result_entry_id = Some(entry_id);
        call.result = Some(bounded_text(&result, MAX_FINAL_BYTES, usize::MAX));
        call.failed = failed;
    }

    pub(super) fn remove_entry(&mut self, entry_id: &str) {
        for call in &mut self.calls {
            call.remove_entry(entry_id);
        }
        self.calls.retain(|call| !call.is_empty());
    }

    pub(super) fn clear_live(&mut self) {
        self.calls.retain(ExecCall::is_complete);
    }

    pub(super) fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    pub(super) fn is_live(&self) -> bool {
        self.calls.iter().any(|call| !call.is_complete())
    }

    pub(super) fn can_expand(&self) -> bool {
        self.calls.iter().any(|call| {
            !call.arguments.is_empty()
                || !call.stdout.is_empty()
                || !call.stderr.is_empty()
                || call
                    .result
                    .as_ref()
                    .is_some_and(|result| !result.is_empty())
        })
    }

    pub(super) fn has_details(&self) -> bool {
        self.can_expand()
    }

    pub(super) fn status(&self) -> CommandStatus {
        if self.is_live() {
            CommandStatus::Running
        } else if self.calls.iter().any(|call| call.failed) {
            CommandStatus::Failed
        } else {
            CommandStatus::Succeeded
        }
    }

    pub(super) fn full_details(&self) -> String {
        self.calls
            .iter()
            .map(|call| {
                let mut sections = vec![format!("{} [{}]", call.name, call.tool_call_id)];
                if !call.arguments.is_empty() {
                    sections.push(call.arguments.clone());
                }
                if !call.stdout.is_empty() {
                    sections.push(call.stdout.clone());
                }
                if !call.stderr.is_empty() {
                    sections.push(call.stderr.clone());
                }
                if let Some(result) = &call.result {
                    sections.push(result.clone());
                }
                sections.join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn summary(&self) -> String {
        match (self.group, self.calls.as_slice()) {
            (_, [call]) if self.is_live() => format!("Running {}", call.name),
            (_, [call]) if call.failed => format!("{} failed", call.name),
            (_, [call]) => format!("Ran {}", call.name),
            (ExecGroup::ExploreGroup, calls) => format!("Explored {} operations", calls.len()),
            (ExecGroup::CompactCommandGroup, calls) => format!("Ran {} commands", calls.len()),
            (ExecGroup::SingleExec, calls) => format!("Ran {} tools", calls.len()),
        }
    }

    fn execution_kind(&self) -> ExecutionKind {
        match self.calls.first().map(|call| call.class) {
            Some(ExecClass::Command) => ExecutionKind::Command,
            Some(ExecClass::Mutation) => ExecutionKind::Mutation,
            Some(ExecClass::Read | ExecClass::Search | ExecClass::List | ExecClass::Other)
            | None => ExecutionKind::Neutral,
        }
    }

    fn call_mut(&mut self, tool_call_id: &ToolCallId) -> Option<&mut ExecCall> {
        self.calls
            .iter_mut()
            .find(|call| &call.tool_call_id == tool_call_id)
    }
}

fn group_for(class: ExecClass) -> ExecGroup {
    match class {
        ExecClass::Read | ExecClass::Search | ExecClass::List => ExecGroup::ExploreGroup,
        ExecClass::Command => ExecGroup::CompactCommandGroup,
        ExecClass::Mutation | ExecClass::Other => ExecGroup::SingleExec,
    }
}

fn classify(name: &str) -> ExecClass {
    match name {
        "read" | "read_file" | "read_text_file" => ExecClass::Read,
        "search" | "search_files" | "grep" | "glob" | "rg" | "find" => ExecClass::Search,
        "list" | "list_dir" | "list_directory" => ExecClass::List,
        "command" | "exec" | "exec_command" | "shell" | "shell-command" | "shell_command"
        | "terminal" => ExecClass::Command,
        "apply_patch" | "edit" | "write_file" => ExecClass::Mutation,
        _ => ExecClass::Other,
    }
}

fn bounded_text(text: &str, max_bytes: usize, max_lines: usize) -> String {
    let mut lines = text
        .lines()
        .map(|line| truncate_utf8(line, MAX_LINE_BYTES))
        .collect::<Vec<_>>();
    if lines.len() > max_lines {
        let tail = max_lines / 2;
        let head = max_lines.saturating_sub(tail);
        let omitted = lines.len().saturating_sub(head).saturating_sub(tail);
        let mut bounded = lines.drain(..head).collect::<Vec<_>>();
        bounded.push(format!("… {omitted} lines omitted …"));
        bounded.extend(
            lines
                .into_iter()
                .rev()
                .take(tail)
                .collect::<Vec<_>>()
                .into_iter()
                .rev(),
        );
        lines = bounded;
    }
    let joined = lines.join("\n");
    if joined.len() <= max_bytes {
        return joined;
    }
    let head = max_bytes / 2;
    let tail = max_bytes.saturating_sub(head);
    let prefix = truncate_utf8(&joined, head);
    let suffix_start = joined.len().saturating_sub(tail);
    let suffix_start = next_char_boundary(&joined, suffix_start);
    format!("{prefix}\n… output omitted …\n{}", &joined[suffix_start..])
}

fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}…", &text[..end])
}

fn next_char_boundary(text: &str, start: usize) -> usize {
    let mut index = start.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index = index.saturating_add(1);
    }
    index
}

#[cfg(test)]
#[path = "exec_cell/model_tests.rs"]
mod tests;
