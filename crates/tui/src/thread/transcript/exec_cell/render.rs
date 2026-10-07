use super::ExecCall;
use super::ExecCell;
use super::truncate_utf8;
use crate::render::RenderContext;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::history_cell::CellLines;
use crate::thread::transcript::history_cell::CellMode;
use crate::thread::transcript::history_cell::CellView;
use crate::thread::transcript::history_cell::HistoryCell;
use crate::thread::transcript::history_cell::MessageRole;
use crate::thread::transcript::history_cell::prefixed_body;
use crate::thread::transcript::markdown_cache::MarkdownCache;
use crate::thread::transcript::message_response::MessageResponse;
use ash_ansi_escape::ansi_text;
use ash_protocol::ToolActivity;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::borrow::Cow;

const EXPANDED_LINES: usize = 12;

impl HistoryCell for ExecCell {
    fn role(&self) -> MessageRole {
        MessageRole::Command
    }
    fn summary(&self, _: CellMode) -> Cow<'_, str> {
        Cow::Owned(self.summary(crate::nls::Language::English))
    }
    fn detail(&self, mode: CellMode) -> Option<Cow<'_, str>> {
        match mode {
            CellMode::Collapsed => None,
            CellMode::Expanded => Some(Cow::Owned(first_lines(
                &self.full_details(),
                EXPANDED_LINES,
                crate::nls::Language::English,
            ))),
            CellMode::History => Some(Cow::Owned(self.full_details())),
        }
    }
    fn can_expand(&self) -> bool {
        self.can_expand()
    }
    fn has_details(&self) -> bool {
        self.has_details()
    }
    fn full_details(&self) -> Option<String> {
        self.has_details().then(|| self.full_details())
    }
    fn lines(
        &self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        _cache: Option<&MarkdownCache>,
        width: u16,
    ) -> CellLines {
        let color = match self.status() {
            CommandStatus::Submitted | CommandStatus::Running => context.warning(),
            CommandStatus::Failed if self.calls.len() > 1 => context.muted(),
            CommandStatus::Failed => context.danger(),
            CommandStatus::Succeeded => context.muted(),
        };
        let lines = prefixed_body(
            &self.summary(context.language()),
            "●",
            color,
            view,
            context,
            width,
        );
        let mut rendered = CellLines {
            lines,
            hyperlinks: Vec::new(),
            user_input_rows: 0,
            details_action: None,
        };
        if view.mode == CellMode::Collapsed {
            for call in &self.calls {
                let mut body = Vec::new();
                if self.calls.len() > 1 {
                    body.push(Line::from(Span::styled(
                        call.summary(context.language()),
                        Style::default().fg(if call.failed() {
                            context.danger()
                        } else {
                            context.muted()
                        }),
                    )));
                }
                for text in call.compact_details(context.language()) {
                    body.extend(
                        ansi_text(&text)
                            .lines
                            .into_iter()
                            .map(|line| line.style(Style::default().fg(context.muted()))),
                    );
                }
                if !body.is_empty() {
                    rendered.append_response(MessageResponse::styled(body).layout(width, context));
                }
            }
            if view.has_details {
                rendered.append_response(
                    MessageResponse::styled(Vec::new())
                        .with_full_details_action()
                        .layout(width, context),
                );
            }
        }
        if view.mode == CellMode::Expanded {
            for call in &self.calls {
                let detail = first_lines(&call.full_details(), EXPANDED_LINES, context.language());
                rendered.append_response(MessageResponse::ansi(&detail).layout(width, context));
            }
        } else if let Some(detail) = self.detail(view.mode) {
            rendered.append_response(MessageResponse::ansi(&detail).layout(width, context));
        }
        rendered.finish(view, context, width)
    }
}

impl ExecCall {
    fn compact_details(&self, language: crate::nls::Language) -> Vec<String> {
        let mut lines = match self.activity.as_ref() {
            Some(ToolActivity::FileRead {
                path,
                offset,
                limit,
            }) => vec![super::localized(
                language,
                "{0} · from line {1}, up to {2} lines",
                &[path, &offset.to_string(), &limit.to_string()],
            )],
            Some(ToolActivity::FileSearch { path, .. } | ToolActivity::FileList { path, .. }) => {
                vec![path.clone()]
            }
            Some(ToolActivity::FileEdit { path }) => vec![path.clone()],
            Some(ToolActivity::Command {
                program, arguments, ..
            }) => vec![
                std::iter::once(program)
                    .chain(arguments)
                    .map(|arg| command_argument(arg))
                    .collect::<Vec<_>>()
                    .join(" "),
            ],
            Some(
                ToolActivity::Read { .. }
                | ToolActivity::Search { .. }
                | ToolActivity::List { .. }
                | ToolActivity::Edit { .. }
                | ToolActivity::Run,
            )
            | None => {
                // Undeclared schemas remain available in full details. Their literal
                // string values identify the call without exposing JSON field names.
                argument_values(&self.arguments)
            }
        };
        let show_result = !matches!(
            self.activity,
            Some(ToolActivity::FileRead { .. } | ToolActivity::FileEdit { .. })
        ) || self.failed();
        if show_result {
            let result = self.key_result();
            let result = match (self.exit_code(), result) {
                (Some(code), Some(text)) => Some(super::localized(
                    language,
                    "Exit code {0} · {1}",
                    &[&code.to_string(), &text],
                )),
                (Some(code), None) => Some(super::localized(
                    language,
                    "Exit code {0}",
                    &[&code.to_string()],
                )),
                (None, text) => text,
            };
            if let Some(result) = result {
                lines.push(result);
            }
        }
        lines
            .into_iter()
            .map(|line| truncate_utf8(&line, 240))
            .collect()
    }

    fn key_result(&self) -> Option<String> {
        if matches!(
            self.activity,
            Some(ToolActivity::Command { .. } | ToolActivity::Run)
        ) && let Some(value) = self
            .result
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        {
            let output = value.get("result").unwrap_or(&value);
            if let Some(text) = output
                .get("stderr")
                .and_then(serde_json::Value::as_str)
                .and_then(first_nonempty_line)
                .or_else(|| {
                    output
                        .get("stdout")
                        .and_then(serde_json::Value::as_str)
                        .and_then(|text| text.lines().rev().find(|line| !line.trim().is_empty()))
                })
            {
                return Some(text.to_owned());
            }
            if output.get("exit_code").is_some() {
                return None;
            }
        }
        [
            &self.stderr,
            self.result.as_deref().unwrap_or(""),
            &self.stdout,
        ]
        .into_iter()
        .find_map(|text| {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                match value {
                    serde_json::Value::String(text) => {
                        first_nonempty_line(&text).map(str::to_owned)
                    }
                    // Structured output belongs in details unless its owner has
                    // declared a result contract above. Do not invent a success claim.
                    _ => None,
                }
            } else {
                first_nonempty_line(text).map(str::to_owned)
            }
        })
    }
}

fn first_nonempty_line(text: &str) -> Option<&str> {
    text.lines().find(|line| !line.trim().is_empty())
}

fn argument_values(text: &str) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(fields)) => fields
            .values()
            .filter_map(serde_json::Value::as_str)
            .take(3)
            .filter_map(first_nonempty_line)
            .map(str::to_owned)
            .collect(),
        Ok(_) => Vec::new(),
        Err(_) => first_nonempty_line(text)
            .map(str::to_owned)
            .into_iter()
            .collect(),
    }
}

fn command_argument(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_./-:=+".contains(ch))
    {
        arg.to_owned()
    } else {
        // This is a readable argv representation, never a command sent for execution.
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn first_lines(text: &str, limit: usize, language: crate::nls::Language) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    if lines.len() <= limit {
        return text.to_owned();
    }
    let omitted = lines.len().saturating_sub(limit);
    let marker = super::localized(language, "… {0} more lines", &[&omitted.to_string()]);
    format!("{}\n{marker}", lines[..limit].join("\n"))
}
