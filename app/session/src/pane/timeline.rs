//! Thread timeline layout and presentation.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use ash_protocol::PlanStepStatus;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolOutputStream;
use ash_thread_transcript::ThreadTranscriptEntry;
use serde_json::Value;
use zui::ui::{
    Component, ComponentElement, Edges, Element, FontFamily, FontWeight, PaintRect, Point, Rect,
    Size, TextBlock, TextStyle, UiScene,
};

use crate::TranscriptState;

const TIMELINE_HORIZONTAL_PADDING: f32 = 20.0;
const TIMELINE_VERTICAL_PADDING: f32 = 18.0;
const TIMELINE_LINE_HEIGHT: f32 = 20.0;
const TIMELINE_SECTION_GAP: f32 = 10.0;

/// Colors needed by the Thread timeline renderer.
#[derive(Clone, Copy)]
pub struct ThreadTimelineStyle {
    pub surface_raised: zui::ui::Color,
    pub text: zui::ui::Color,
    pub text_muted: zui::ui::Color,
    pub error: zui::ui::Color,
}

impl ThreadTimelineStyle {
    /// Creates a timeline style from the host's resolved colors.
    pub const fn new(
        surface_raised: zui::ui::Color,
        text: zui::ui::Color,
        text_muted: zui::ui::Color,
        error: zui::ui::Color,
    ) -> Self {
        Self {
            surface_raised,
            text,
            text_muted,
            error,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TimelineLineKind {
    UserLabel,
    UserMessage,
    AgentLabel,
    AgentMessage,
    AgentError,
    ToolLabel,
    ToolCommand,
    ToolOutput,
    ToolError,
}

struct TimelineLine {
    text: String,
    kind: TimelineLineKind,
    starts_section: bool,
}

pub struct ThreadTimeline {
    bounds: Rect,
    lines: Vec<TimelineLine>,
    style: ThreadTimelineStyle,
}

impl ThreadTimeline {
    pub fn new(
        bounds: Rect,
        transcript: &TranscriptState,
        scroll_offset: usize,
        style: ThreadTimelineStyle,
    ) -> Self {
        Self {
            bounds,
            lines: scrolled_lines(transcript, bounds, scroll_offset),
            style,
        }
    }

    #[cfg(test)]
    fn visible_text(&self) -> Vec<&str> {
        self.lines.iter().map(|line| line.text.as_str()).collect()
    }
}

impl Component for ThreadTimeline {
    fn element(&self) -> ComponentElement {
        Element::leaf("ThreadTimeline")
            .padding(Edges::new(
                TIMELINE_VERTICAL_PADDING,
                TIMELINE_HORIZONTAL_PADDING,
                TIMELINE_VERTICAL_PADDING,
                TIMELINE_HORIZONTAL_PADDING,
            ))
            .in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.with_clip(self.bounds, |scene| {
            let content_bounds = Rect::from_xywh(
                self.bounds.origin.x + TIMELINE_HORIZONTAL_PADDING,
                self.bounds.origin.y + TIMELINE_VERTICAL_PADDING,
                (self.bounds.size.width - TIMELINE_HORIZONTAL_PADDING * 2.0).max(1.0),
                (self.bounds.size.height - TIMELINE_VERTICAL_PADDING * 2.0).max(1.0),
            );
            let visible_lines = visible_line_range(&self.lines, content_bounds.size.height);
            let mut y = content_bounds.origin.y;
            for line in &self.lines[visible_lines] {
                if line.starts_section && y > content_bounds.origin.y {
                    y += TIMELINE_SECTION_GAP;
                }
                let line_bounds = Rect::from_xywh(
                    content_bounds.origin.x,
                    y,
                    content_bounds.size.width,
                    TIMELINE_LINE_HEIGHT,
                );
                if matches!(
                    line.kind,
                    TimelineLineKind::ToolLabel
                        | TimelineLineKind::ToolCommand
                        | TimelineLineKind::ToolOutput
                        | TimelineLineKind::ToolError
                ) {
                    scene.draw_rect(PaintRect::new(line_bounds, self.style.surface_raised));
                }
                scene.draw_text(TextBlock::new(
                    line.text.clone(),
                    Point::new(line_bounds.origin.x + line_inset(line.kind), y),
                    Size::new(
                        (line_bounds.size.width - line_inset(line.kind)).max(1.0),
                        TIMELINE_LINE_HEIGHT,
                    ),
                    line_style(line.kind, self.style),
                ));
                y += TIMELINE_LINE_HEIGHT;
            }
        });
    }
}

fn build_lines(transcript: &TranscriptState) -> Vec<TimelineLine> {
    let entries = transcript.entries();
    let tool_call_ids = entries
        .iter()
        .filter_map(|entry| match entry {
            ThreadTranscriptEntry::Item {
                item: ThreadItem::ToolCall { tool_call_id, .. },
                ..
            } => Some(tool_call_id.clone()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let tool_results = entries
        .iter()
        .filter_map(|entry| match entry {
            ThreadTranscriptEntry::Item {
                item:
                    ThreadItem::ToolResult {
                        tool_call_id,
                        text,
                        is_error,
                        ..
                    },
                ..
            } => Some((tool_call_id.clone(), (text.as_str(), *is_error))),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    let mut transient_tool_outputs = BTreeMap::<ToolCallId, TransientToolOutput>::new();
    for entry in entries {
        let ThreadTranscriptEntry::ToolOutput {
            tool_call_id,
            stream,
            text,
            ..
        } = entry
        else {
            continue;
        };
        let output = transient_tool_outputs
            .entry(tool_call_id.clone())
            .or_default();
        match stream {
            ToolOutputStream::Stdout => output.stdout = text.clone(),
            ToolOutputStream::Stderr => output.stderr = text.clone(),
        }
    }
    let mut lines = Vec::new();
    for entry in entries {
        match entry {
            ThreadTranscriptEntry::Item { item, .. } => match item {
                ThreadItem::UserMessage { text, .. } => {
                    push_section(&mut lines, "You", TimelineLineKind::UserLabel);
                    push_text(&mut lines, text, TimelineLineKind::UserMessage);
                }
                ThreadItem::UserContext { name, .. } => {
                    push_section(&mut lines, "You · Context", TimelineLineKind::UserLabel);
                    push_text(&mut lines, name, TimelineLineKind::UserMessage);
                }
                ThreadItem::UserImage { url, .. } => {
                    push_section(&mut lines, "You · Image", TimelineLineKind::UserLabel);
                    push_text(&mut lines, url, TimelineLineKind::UserMessage);
                }
                ThreadItem::UserImageAttachment { attachment, .. } => {
                    push_section(&mut lines, "You · Image", TimelineLineKind::UserLabel);
                    push_text(
                        &mut lines,
                        &format!(
                            "{} · {}×{}",
                            attachment.media_type.mime_type(),
                            attachment.width,
                            attachment.height
                        ),
                        TimelineLineKind::UserMessage,
                    );
                }
                ThreadItem::UserAudioAttachment { attachment, .. } => {
                    push_section(&mut lines, "You · Audio", TimelineLineKind::UserLabel);
                    push_text(
                        &mut lines,
                        &format!(
                            "{} · {} seconds",
                            attachment.media_type.mime_type(),
                            attachment.duration_ms.div_ceil(1000)
                        ),
                        TimelineLineKind::UserMessage,
                    );
                }
                ThreadItem::AgentMessage { text, .. } => {
                    push_section(&mut lines, "Agent", TimelineLineKind::AgentLabel);
                    push_text(&mut lines, text, TimelineLineKind::AgentMessage);
                }
                ThreadItem::Reasoning { text, .. } => {
                    push_section(
                        &mut lines,
                        "Agent · Reasoning",
                        TimelineLineKind::AgentLabel,
                    );
                    push_text(&mut lines, text, TimelineLineKind::AgentMessage);
                }
                ThreadItem::Plan { text, .. } => {
                    push_section(&mut lines, "Agent · Plan", TimelineLineKind::AgentLabel);
                    push_text(&mut lines, text, TimelineLineKind::AgentMessage);
                }
                ThreadItem::ToolCall {
                    tool_call_id,
                    name,
                    arguments_json,
                    ..
                } => {
                    push_section(
                        &mut lines,
                        &format!("Tool · {name}"),
                        TimelineLineKind::ToolLabel,
                    );
                    push_text(
                        &mut lines,
                        &tool_command(name.as_str(), arguments_json),
                        TimelineLineKind::ToolCommand,
                    );
                    if let Some((output, is_error)) = tool_results.get(tool_call_id) {
                        let is_error = *is_error || shell_output_failed(name.as_str(), output);
                        push_text(
                            &mut lines,
                            &tool_output(name.as_str(), output),
                            if is_error {
                                TimelineLineKind::ToolError
                            } else {
                                TimelineLineKind::ToolOutput
                            },
                        );
                    } else if let Some(output) = transient_tool_outputs.get(tool_call_id) {
                        push_text(&mut lines, &output.stdout, TimelineLineKind::ToolOutput);
                        push_text(&mut lines, &output.stderr, TimelineLineKind::ToolError);
                    }
                }
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error,
                    ..
                } if !tool_call_ids.contains(tool_call_id) => {
                    push_section(&mut lines, "Tool · Result", TimelineLineKind::ToolLabel);
                    push_text(
                        &mut lines,
                        text,
                        if *is_error {
                            TimelineLineKind::ToolError
                        } else {
                            TimelineLineKind::ToolOutput
                        },
                    );
                }
                ThreadItem::ToolResult { .. } => {}
            },
            ThreadTranscriptEntry::TurnPlan { plan, .. } => {
                push_section(&mut lines, "Agent · Plan", TimelineLineKind::AgentLabel);
                if let Some(explanation) = plan.explanation.as_deref() {
                    push_text(&mut lines, explanation, TimelineLineKind::AgentMessage);
                }
                for step in &plan.steps {
                    let marker = match step.status {
                        PlanStepStatus::Pending => "○",
                        PlanStepStatus::InProgress => "◐",
                        PlanStepStatus::Completed => "●",
                    };
                    push_text(
                        &mut lines,
                        &format!("{marker} {}", step.step),
                        TimelineLineKind::AgentMessage,
                    );
                }
            }
            ThreadTranscriptEntry::TurnError { error, .. } => {
                push_section(&mut lines, "Agent · Error", TimelineLineKind::AgentError);
                push_text(&mut lines, &error.message, TimelineLineKind::AgentError);
            }
            ThreadTranscriptEntry::ToolOutput {
                tool_call_id,
                text,
                stream,
                ..
            } if !tool_call_ids.contains(tool_call_id) => {
                push_section(&mut lines, "Tool · Output", TimelineLineKind::ToolLabel);
                push_text(
                    &mut lines,
                    text,
                    match stream {
                        ToolOutputStream::Stdout => TimelineLineKind::ToolOutput,
                        ToolOutputStream::Stderr => TimelineLineKind::ToolError,
                    },
                );
            }
            ThreadTranscriptEntry::ToolOutput { .. } => {}
        }
    }
    lines
}

#[derive(Default)]
struct TransientToolOutput {
    stdout: String,
    stderr: String,
}

pub fn line_count(transcript: &TranscriptState) -> usize {
    build_lines(transcript).len()
}

pub fn line_capacity(bounds: Rect) -> usize {
    let available =
        (bounds.size.height - TIMELINE_VERTICAL_PADDING * 2.0).max(TIMELINE_LINE_HEIGHT);
    (available / TIMELINE_LINE_HEIGHT).floor().max(1.0) as usize
}

fn scrolled_lines(
    transcript: &TranscriptState,
    bounds: Rect,
    scroll_offset: usize,
) -> Vec<TimelineLine> {
    let lines = build_lines(transcript);
    let capacity = line_capacity(bounds);
    let offset = scroll_offset.min(lines.len().saturating_sub(capacity));
    let end = lines.len().saturating_sub(offset);
    let start = end.saturating_sub(capacity);
    lines.into_iter().skip(start).take(end - start).collect()
}

fn push_section(lines: &mut Vec<TimelineLine>, text: &str, kind: TimelineLineKind) {
    lines.push(TimelineLine {
        text: text.to_owned(),
        kind,
        starts_section: true,
    });
}

fn push_text(lines: &mut Vec<TimelineLine>, text: &str, kind: TimelineLineKind) {
    if text.is_empty() {
        return;
    }
    lines.extend(text.lines().map(|line| TimelineLine {
        text: line.to_owned(),
        kind,
        starts_section: false,
    }));
}

fn tool_command(tool_name: &str, arguments_json: &str) -> String {
    if tool_name != "shell-command" {
        return arguments_json.to_owned();
    }
    let Ok(Value::Object(arguments)) = serde_json::from_str(arguments_json) else {
        return arguments_json.to_owned();
    };
    if let Some(command) = arguments.get("command").and_then(Value::as_str) {
        return format!("$ {command}");
    }
    let Some(program) = arguments.get("program").and_then(Value::as_str) else {
        return arguments_json.to_owned();
    };
    let command_arguments = arguments
        .get("arguments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if command_arguments.len() == 2 && command_arguments[0] == "-lc" {
        format!("$ {}", command_arguments[1])
    } else {
        std::iter::once(program)
            .chain(command_arguments)
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn shell_output_failed(tool_name: &str, output: &str) -> bool {
    tool_name == "shell-command"
        && serde_json::from_str::<Value>(output)
            .ok()
            .and_then(|output| output.get("exit_code").and_then(Value::as_i64))
            .is_some_and(|exit_code| exit_code != 0)
}

fn tool_output(tool_name: &str, output: &str) -> String {
    if tool_name != "shell-command" {
        return output.to_owned();
    }
    let Ok(Value::Object(fields)) = serde_json::from_str(output) else {
        return output.to_owned();
    };
    let stdout = fields.get("stdout").and_then(Value::as_str).unwrap_or("");
    let stderr = fields.get("stderr").and_then(Value::as_str).unwrap_or("");
    let exit_code = fields.get("exit_code").and_then(Value::as_i64);
    let mut sections = Vec::new();
    if !stdout.is_empty() {
        sections.push(stdout.trim_end_matches('\n').to_owned());
    }
    if !stderr.is_empty() {
        sections.push(stderr.trim_end_matches('\n').to_owned());
    }
    if exit_code.is_some_and(|code| code != 0) {
        sections.push(format!("[exit {}]", exit_code.unwrap_or_default()));
    }
    if sections.is_empty() {
        exit_code
            .map(|code| format!("[exit {code}]"))
            .unwrap_or_else(|| output.to_owned())
    } else {
        sections.join("\n")
    }
}

fn visible_line_range(lines: &[TimelineLine], available_height: f32) -> std::ops::Range<usize> {
    let capacity = (available_height / TIMELINE_LINE_HEIGHT).floor().max(1.0) as usize;
    lines.len().saturating_sub(capacity)..lines.len()
}

fn line_inset(kind: TimelineLineKind) -> f32 {
    if matches!(
        kind,
        TimelineLineKind::ToolLabel
            | TimelineLineKind::ToolCommand
            | TimelineLineKind::ToolOutput
            | TimelineLineKind::ToolError
    ) {
        10.0
    } else {
        0.0
    }
}

fn line_style(kind: TimelineLineKind, style: ThreadTimelineStyle) -> TextStyle {
    let (size, color, family, weight) = match kind {
        TimelineLineKind::UserLabel
        | TimelineLineKind::AgentLabel
        | TimelineLineKind::ToolLabel => (
            12.0,
            style.text_muted,
            FontFamily::SansSerif,
            FontWeight::Bold,
        ),
        TimelineLineKind::UserMessage | TimelineLineKind::AgentMessage => {
            (14.0, style.text, FontFamily::SansSerif, FontWeight::Normal)
        }
        TimelineLineKind::AgentError => {
            (14.0, style.error, FontFamily::SansSerif, FontWeight::Normal)
        }
        TimelineLineKind::ToolCommand | TimelineLineKind::ToolOutput => {
            (13.0, style.text, FontFamily::Monospace, FontWeight::Normal)
        }
        TimelineLineKind::ToolError => {
            (13.0, style.error, FontFamily::Monospace, FontWeight::Normal)
        }
    };
    TextStyle::new(size, color)
        .with_family(family)
        .with_weight(weight)
        .with_line_height(TIMELINE_LINE_HEIGHT)
}

#[cfg(test)]
#[path = "timeline_tests.rs"]
mod tests;
