mod render;

use crate::nls::Language;
use crate::nls::Text;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::TranscriptCellId;
use ash_protocol::ToolActivity;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use std::collections::BTreeSet;

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

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExecCall {
    tool_call_id: ToolCallId,
    name: String,
    arguments: String,
    activity: Option<ToolActivity>,
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
    fn failure_label(&self, language: Language) -> String {
        let (template, target) = match self.activity.as_ref() {
            Some(ToolActivity::Read { target }) => ("Failed to read {0}", target.as_str()),
            Some(ToolActivity::Search { target }) => ("Failed to search {0}", target.as_str()),
            Some(ToolActivity::List { target }) => ("Failed to list {0}", target.as_str()),
            Some(ToolActivity::Edit { target }) => ("Failed to update {0}", target.as_str()),
            Some(ToolActivity::FileRead { path, .. }) => {
                ("Failed to read file {0}", file_name(path))
            }
            Some(ToolActivity::FileSearch { pattern, .. }) => {
                ("Failed to search for {0}", pattern.as_str())
            }
            Some(ToolActivity::FileList { pattern, .. }) => {
                ("Failed to list files matching {0}", pattern.as_str())
            }
            Some(ToolActivity::FileEdit { path }) => ("Failed to update file {0}", file_name(path)),
            Some(ToolActivity::Run | ToolActivity::Command { .. }) => ("Command failed", ""),
            None => ("{0} failed", self.name.as_str()),
        };
        if matches!(
            self.activity,
            Some(
                ToolActivity::Read { .. }
                    | ToolActivity::Search { .. }
                    | ToolActivity::List { .. }
                    | ToolActivity::Edit { .. }
            )
        ) {
            localized_activity(language, template, target)
        } else {
            localized(language, template, &[target])
        }
    }

    fn exit_code(&self) -> Option<i64> {
        if !matches!(
            self.activity,
            Some(ToolActivity::Command { .. } | ToolActivity::Run)
        ) {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(self.result.as_deref()?).ok()?;
        let output = value.get("result").unwrap_or(&value);
        output.get("exit_code")?.as_i64()
    }

    fn failed(&self) -> bool {
        self.failed || self.exit_code().is_some_and(|code| code != 0)
    }

    fn summary(&self, language: Language) -> String {
        if self.is_complete() && self.failed() {
            return self.failure_label(language);
        }
        let running = !self.is_complete();
        let (template, target, translate_target) = match (running, self.activity.as_ref()) {
            (true, Some(ToolActivity::Read { target })) => ("Reading {0}", target.as_str(), true),
            (false, Some(ToolActivity::Read { target })) => ("Read {0}", target.as_str(), true),
            (true, Some(ToolActivity::Search { target })) => {
                ("Searching {0}", target.as_str(), true)
            }
            (false, Some(ToolActivity::Search { target })) => {
                ("Searched {0}", target.as_str(), true)
            }
            (true, Some(ToolActivity::List { target })) => ("Listing {0}", target.as_str(), true),
            (false, Some(ToolActivity::List { target })) => ("Listed {0}", target.as_str(), true),
            (true, Some(ToolActivity::Edit { target })) => ("Editing {0}", target.as_str(), true),
            (false, Some(ToolActivity::Edit { target })) => ("Updated {0}", target.as_str(), true),
            (true, Some(ToolActivity::FileRead { path, .. })) => {
                ("Reading file {0}", file_name(path), false)
            }
            (false, Some(ToolActivity::FileRead { path, .. })) => {
                ("Read file {0}", file_name(path), false)
            }
            (true, Some(ToolActivity::FileSearch { pattern, .. })) => {
                ("Searching for {0}", pattern.as_str(), false)
            }
            (false, Some(ToolActivity::FileSearch { pattern, .. })) => {
                ("Searched for {0}", pattern.as_str(), false)
            }
            (true, Some(ToolActivity::FileList { pattern, .. })) => {
                ("Listing files matching {0}", pattern.as_str(), false)
            }
            (false, Some(ToolActivity::FileList { pattern, .. })) => {
                ("Listed files matching {0}", pattern.as_str(), false)
            }
            (true, Some(ToolActivity::FileEdit { path })) => {
                ("Updating file {0}", file_name(path), false)
            }
            (false, Some(ToolActivity::FileEdit { path })) => {
                ("Updated file {0}", file_name(path), false)
            }
            (true, Some(ToolActivity::Run | ToolActivity::Command { .. })) => {
                ("Running command", "", false)
            }
            (false, Some(ToolActivity::Run | ToolActivity::Command { .. })) => {
                ("Command finished", "", false)
            }
            (true, None) => ("Running {0}", self.name.as_str(), false),
            (false, None) => ("Completed {0}", self.name.as_str(), false),
        };
        if translate_target {
            localized_activity(language, template, target)
        } else {
            localized(language, template, &[target])
        }
    }

    fn new(
        entry_id: Option<String>,
        tool_call_id: ToolCallId,
        name: String,
        arguments: String,
        activity: Option<ToolActivity>,
    ) -> Self {
        Self {
            tool_call_id,
            name,
            arguments,
            activity,
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

    fn full_details(&self) -> String {
        let mut sections = vec![format!("{} [{}]", self.name, self.tool_call_id)];
        for text in [
            Some(self.arguments.as_str()),
            Some(self.stdout.as_str()),
            Some(self.stderr.as_str()),
            self.result.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        {
            sections.push(text.to_owned());
        }
        sections.join("\n")
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
        activity: Option<ToolActivity>,
    ) -> Self {
        let cell_id = TranscriptCellId::for_tool_call(&tool_call_id);
        let call = ExecCall::new(
            Some(entry_id.clone()),
            tool_call_id,
            name.as_str().to_owned(),
            arguments,
            activity,
        );
        let group = group_for(call.activity.as_ref());
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
                None,
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

    pub(super) fn can_accept(&self, activity: Option<&ToolActivity>) -> bool {
        if self.calls.len() >= MAX_GROUP_CALLS {
            return false;
        }
        match self.group {
            ExecGroup::ExploreGroup => {
                matches!(
                    activity,
                    Some(
                        ToolActivity::Read { .. }
                            | ToolActivity::Search { .. }
                            | ToolActivity::List { .. }
                            | ToolActivity::FileRead { .. }
                            | ToolActivity::FileSearch { .. }
                            | ToolActivity::FileList { .. }
                    )
                )
            }
            ExecGroup::CompactCommandGroup => {
                matches!(
                    activity,
                    Some(ToolActivity::Run | ToolActivity::Command { .. })
                ) && self
                    .calls
                    .iter()
                    .all(|call| call.is_complete() && !call.failed())
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
        activity: Option<ToolActivity>,
    ) {
        self.calls.push(ExecCall::new(
            Some(entry_id),
            tool_call_id,
            name.as_str().to_owned(),
            arguments,
            activity,
        ));
    }

    pub(super) fn update_call(
        &mut self,
        entry_id: String,
        tool_call_id: &ToolCallId,
        name: &ToolName,
        arguments: String,
        activity: Option<ToolActivity>,
    ) {
        if let Some(call) = self.call_mut(tool_call_id) {
            call.call_entry_id = Some(entry_id);
            call.name = name.as_str().to_owned();
            call.arguments = arguments;
            call.activity = activity;
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
        let result = if call.name == "advisor" {
            advisor_text(result)
        } else {
            result
        };
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
        } else if self.calls.iter().any(ExecCall::failed) {
            CommandStatus::Failed
        } else {
            CommandStatus::Succeeded
        }
    }

    pub(super) fn full_details(&self) -> String {
        self.calls
            .iter()
            .map(ExecCall::full_details)
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn summary(&self, language: Language) -> String {
        let failed = self.calls.iter().filter(|call| call.failed()).count();
        let running = self.is_live();
        match (self.group, self.calls.as_slice()) {
            (_, [call]) => call.summary(language),
            (ExecGroup::ExploreGroup, calls) => {
                let count = calls.len().to_string();
                let failures = failed.to_string();
                let template = match (running, failed > 0) {
                    (true, true) => "Exploring {0} operations · {1} failed",
                    (true, false) => "Exploring {0} operations",
                    (false, true) => "Explored {0} operations · {1} failed",
                    (false, false) => "Explored {0} operations",
                };
                localized(language, template, &[&count, &failures])
            }
            (ExecGroup::CompactCommandGroup, calls) => {
                let count = calls.len().to_string();
                let failures = failed.to_string();
                let template = match (running, failed > 0) {
                    (true, true) => "Running {0} commands · {1} failed",
                    (true, false) => "Running {0} commands",
                    (false, true) => "Finished {0} commands · {1} failed",
                    (false, false) => "Finished {0} commands",
                };
                localized(language, template, &[&count, &failures])
            }
            (ExecGroup::SingleExec, calls) => {
                let count = calls.len().to_string();
                localized(language, "Completed {0} tools", &[&count])
            }
        }
    }

    fn call_mut(&mut self, tool_call_id: &ToolCallId) -> Option<&mut ExecCall> {
        self.calls
            .iter_mut()
            .find(|call| &call.tool_call_id == tool_call_id)
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn group_for(activity: Option<&ToolActivity>) -> ExecGroup {
    match activity {
        Some(
            ToolActivity::Read { .. }
            | ToolActivity::Search { .. }
            | ToolActivity::List { .. }
            | ToolActivity::FileRead { .. }
            | ToolActivity::FileSearch { .. }
            | ToolActivity::FileList { .. },
        ) => ExecGroup::ExploreGroup,
        Some(ToolActivity::Run | ToolActivity::Command { .. }) => ExecGroup::CompactCommandGroup,
        Some(ToolActivity::Edit { .. } | ToolActivity::FileEdit { .. }) | None => {
            ExecGroup::SingleExec
        }
    }
}

fn localized(language: Language, template: &str, arguments: &[&str]) -> String {
    let mut text = Text::template(
        template,
        arguments
            .iter()
            .map(|value| Text::literal(*value))
            .collect(),
    );
    text.localize(language);
    text.to_string()
}

fn localized_activity(language: Language, template: &str, target: &str) -> String {
    let mut text = Text::template(template, vec![Text::from(target.to_owned())]);
    text.localize(language);
    text.to_string()
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

#[derive(serde::Deserialize)]
struct AdvisorAdvice {
    model: ash_protocol::ModelRef,
    question: String,
    advice: String,
    #[serde(rename = "sourceSequence")]
    source_sequence: u64,
    usage: Option<ash_protocol::ModelUsage>,
}

fn advisor_text(result: String) -> String {
    // Policy/recovery errors use plain ToolResult text and remain visible as supplied by Core.
    let Ok(advice) = serde_json::from_str::<AdvisorAdvice>(&result) else {
        return result;
    };
    let usage = advice
        .usage
        .as_ref()
        .map(|usage| {
            format!(
                "\nTokens: {} input · {} output",
                usage
                    .input_tokens
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into()),
                usage
                    .output_tokens
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into())
            )
        })
        .unwrap_or_default();
    format!(
        "Advisor · {}/{}\nQuestion: {}\n\n{}\n\nConversation sequence {}{}",
        advice.model.provider,
        advice.model.model,
        advice.question,
        advice.advice,
        advice.source_sequence,
        usage
    )
}
