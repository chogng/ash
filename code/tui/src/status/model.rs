use crate::render::truncate_with_ellipsis;
use crate::thread::TurnApprovalModes;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::git::GitDiffStatisticsDto;
use ash_app_server_protocol::protocol::git::GitHeadDto;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_memory_diagnostics::ProcessResourceMetrics;
use ash_protocol::ApprovalMode;
use ash_protocol::ModelMoneyAmount;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsageSummary;
use ash_protocol::StreamInstanceId;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::StatusLineItem;
use super::StatusLineSettings;
use super::StatusLineStyle;
use super::format_compact_process_cpu;
use super::format_compact_process_memory;
use super::format_process_cpu;
use super::format_process_memory;
use super::resources::ProcessUsageView;

const SEPARATOR: &str = " · ";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct StatusLineRuntime {
    pub(crate) plan: Option<(usize, usize)>,
    pub(crate) subagents: usize,
    pub(crate) process_resources: ProcessUsageView,
}

#[derive(Clone, Copy)]
enum StatusLineLocation {
    Footer,
    Header,
}

impl StatusLineRuntime {
    pub(crate) fn text(self) -> String {
        let mut segments = Vec::new();
        if let Some((completed, total)) = self.plan {
            segments.push(format!("plan {completed}/{total}"));
        }
        if self.subagents > 0 {
            segments.push(format!("subagents {}", self.subagents));
        }
        segments.join(SEPARATOR)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ApprovalModeDisplay {
    pub(super) icon: &'static str,
    pub(super) label: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DisplayValue {
    full: Vec<StatusLineSegment>,
    compact: Vec<StatusLineSegment>,
    process_resources: Option<ProcessResourceMetrics>,
}

impl DisplayValue {
    fn plain(full: impl Into<String>, compact: impl Into<String>) -> Self {
        Self {
            full: vec![StatusLineSegment::chrome(full)],
            compact: vec![StatusLineSegment::chrome(compact)],
            process_resources: None,
        }
    }

    fn process_resource(
        full: impl Into<String>,
        compact: impl Into<String>,
        metrics: ProcessResourceMetrics,
    ) -> Self {
        Self {
            full: vec![StatusLineSegment::chrome(full)],
            compact: vec![StatusLineSegment::chrome(compact)],
            process_resources: Some(metrics),
        }
    }
}

struct FittedValues {
    segments: Vec<StatusLineSegment>,
    visible_values: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StatusLineSegmentKind {
    Chrome,
    Inserted,
    Removed,
    Progress,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct StatusLineSegment {
    text: String,
    kind: StatusLineSegmentKind,
}

impl StatusLineSegment {
    pub(super) fn chrome(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kind: StatusLineSegmentKind::Chrome,
        }
    }

    pub(super) fn inserted(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kind: StatusLineSegmentKind::Inserted,
        }
    }

    pub(super) fn removed(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kind: StatusLineSegmentKind::Removed,
        }
    }

    #[cfg(test)]
    pub(super) fn text(&self) -> &str {
        &self.text
    }

    #[cfg(test)]
    pub(super) const fn kind(&self) -> StatusLineSegmentKind {
        self.kind
    }

    pub(super) fn into_parts(self) -> (String, StatusLineSegmentKind) {
        (self.text, self.kind)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitStatusCursor {
    repository_id: String,
    stream_instance_id: StreamInstanceId,
    revision: u64,
}

/// Pure display model for the configured context rendered inside StatusLine.
///
/// Data acquisition remains with the application and the typed interfaces that own each value.
/// This model only keeps display variants and selects the richest configured representation that
/// fits.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct StatusLineModel {
    settings: StatusLineSettings,
    glyph_set: crate::config::GlyphSet,
    context_model: Option<ModelRefDto>,
    context_capacity: Option<u64>,
    context_usage: Option<(ash_protocol::ModelRef, ash_protocol::ModelContextUsage)>,
    model: Option<DisplayValue>,
    cache_hit_rate: Option<DisplayValue>,
    reference_cost: Option<DisplayValue>,
    git_branch: Option<DisplayValue>,
    git_status_cursor: Option<GitStatusCursor>,
    git_change_count: usize,
    git_diff_statistics: Option<GitDiffStatisticsDto>,
    git_text_diff_requested_for: Option<GitStatusCursor>,
}

impl StatusLineModel {
    pub(crate) fn model_label(&self) -> &str {
        match &self.model {
            Some(value) => &value.full[0].text,
            None => "Automatic model",
        }
    }

    pub(crate) fn branch_label(&self) -> Option<&str> {
        self.git_branch
            .as_ref()
            .and_then(|value| value.full.first())
            .map(|segment| segment.text.as_str())
    }

    pub(crate) const fn branch_marker(&self) -> &'static str {
        self.glyph_set.branch_marker()
    }

    pub(crate) fn set_glyph_set(&mut self, glyph_set: crate::config::GlyphSet) {
        self.glyph_set = glyph_set;
    }
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn apply_settings(&mut self, settings: StatusLineSettings) {
        if self.settings.show_git_changes_as_diff() != settings.show_git_changes_as_diff()
            || self.settings.enabled(StatusLineItem::GitChanges)
                != settings.enabled(StatusLineItem::GitChanges)
        {
            self.git_text_diff_requested_for = None;
        }
        self.settings = settings;
    }

    pub(crate) fn apply_model_label(&mut self, label: impl Into<String>) {
        let label = label.into();
        self.model = Some(DisplayValue::plain(label.clone(), label));
    }

    pub(crate) fn apply_context_capacity(
        &mut self,
        model: Option<&ModelRefDto>,
        capacity: Option<u64>,
    ) {
        self.context_model = model.cloned();
        self.context_capacity = capacity.filter(|capacity| *capacity > 0);
    }

    pub(crate) fn apply_context_usage(
        &mut self,
        usage: Option<(ash_protocol::ModelRef, ash_protocol::ModelContextUsage)>,
    ) {
        self.context_usage = usage;
    }

    pub(crate) fn apply_thread_accounting(
        &mut self,
        usage: &ModelUsageSummary,
        reference_cost: &ModelReferenceCostSummary,
    ) {
        self.cache_hit_rate = cache_hit_rate_display(usage);
        self.reference_cost = reference_cost_display(usage.model_invocations, reference_cost);
    }

    pub(crate) fn clear_thread_accounting(&mut self) {
        self.context_usage = None;
        self.cache_hit_rate = None;
        self.reference_cost = None;
    }

    /// Accepts every base Git status update independently of the configured StatusLine items.
    /// The settings only gate rendering and the optional text-diff request below.
    pub(crate) fn apply_git_status(&mut self, status: &GitStatusResult) {
        let cursor = git_status_cursor(status);
        if self
            .git_status_cursor
            .as_ref()
            .is_some_and(|current| git_status_is_older(&cursor, current))
        {
            return;
        }
        if self.git_status_cursor.as_ref() != Some(&cursor) {
            self.git_diff_statistics = None;
            self.git_text_diff_requested_for = None;
        }
        self.git_status_cursor = Some(cursor);
        let identity = match &status.head {
            GitHeadDto::Branch { name, .. } | GitHeadDto::Unborn { name } => name.clone(),
            GitHeadDto::Detached { object_id } => {
                format!("detached@{}", object_id.chars().take(8).collect::<String>())
            }
        };
        self.git_branch = Some(DisplayValue::plain(identity.clone(), identity));
        self.git_change_count = status.changes.len();
    }

    pub(crate) fn apply_git_text_diff(
        &mut self,
        status: GitStatusResult,
        statistics: GitDiffStatisticsDto,
    ) {
        let cursor = git_status_cursor(&status);
        let Some(requested) = self.git_text_diff_requested_for.take() else {
            return;
        };
        if requested.repository_id != cursor.repository_id
            || requested.stream_instance_id != cursor.stream_instance_id
            || requested.revision > cursor.revision
            || self.git_status_cursor.as_ref().is_some_and(|current| {
                current.repository_id != cursor.repository_id
                    || current.stream_instance_id != cursor.stream_instance_id
                    || current.revision > cursor.revision
            })
        {
            return;
        }
        self.apply_git_status(&status);
        if self.git_status_cursor.as_ref() == Some(&cursor) {
            self.git_diff_statistics = Some(statistics);
        }
    }

    pub(crate) fn request_status_line_git_text_diff(&mut self) -> bool {
        if !self.settings.show_git_changes_as_diff()
            || !self.settings.enabled(StatusLineItem::GitChanges)
            || self.git_change_count == 0
            || self.git_diff_statistics.is_some()
            || self.git_text_diff_requested_for.is_some()
        {
            return false;
        }
        self.git_text_diff_requested_for = self.git_status_cursor.clone();
        true
    }

    #[cfg(test)]
    pub(crate) fn top_text_for_width(&self, width: usize, runtime: StatusLineRuntime) -> String {
        self.top_segments_for_width(width, runtime)
            .iter()
            .map(StatusLineSegment::text)
            .collect()
    }

    pub(super) fn top_segments_for_width(
        &self,
        width: usize,
        runtime: StatusLineRuntime,
    ) -> Vec<StatusLineSegment> {
        self.top_layout_for_width(width, runtime, StatusLineLocation::Footer)
            .segments
    }

    pub(crate) fn visible_process_resources(
        &self,
        width: usize,
        runtime: StatusLineRuntime,
    ) -> Option<ProcessResourceMetrics> {
        self.top_layout_for_width(width, runtime, StatusLineLocation::Footer)
            .process_resources
    }

    pub(super) fn header_segments_for_width(
        &self,
        width: usize,
        runtime: StatusLineRuntime,
    ) -> Vec<StatusLineSegment> {
        self.top_layout_for_width(width, runtime, StatusLineLocation::Header)
            .segments
    }

    pub(crate) fn header_process_resources(
        &self,
        width: usize,
        runtime: StatusLineRuntime,
    ) -> Option<ProcessResourceMetrics> {
        self.top_layout_for_width(width, runtime, StatusLineLocation::Header)
            .process_resources
    }

    fn top_layout_for_width(
        &self,
        width: usize,
        runtime: StatusLineRuntime,
        location: StatusLineLocation,
    ) -> StatusLineLayout {
        let process_resources = runtime.process_resources;
        let mut values = Vec::new();
        if self.settings.style() == StatusLineStyle::Rich {
            if let Some((completed, total)) = runtime.plan {
                values.push(progress_value(
                    "📋",
                    "plan",
                    &format!("{completed}/{total}"),
                    (total > 0)
                        .then(|| (completed as u128 * 100 / total as u128).min(100) as usize),
                ));
            }
            if runtime.subagents > 0 {
                values.push(DisplayValue::plain(
                    format!("👥 subagents {}", runtime.subagents),
                    format!("subagents {}", runtime.subagents),
                ));
            }
        } else {
            let text = runtime.text();
            if !text.is_empty() {
                values.push(DisplayValue::plain(text.clone(), text));
            }
        }
        values.extend(self.configured_values(process_resources, location));
        let fitted = fit_values(&values, width);
        let process_resources = values[..fitted.visible_values]
            .iter()
            .filter_map(|value| value.process_resources)
            .reduce(ProcessResourceMetrics::union);
        StatusLineLayout {
            segments: fitted.segments,
            process_resources,
        }
    }

    pub(crate) fn policy_text_for_width(
        &self,
        width: usize,
        approval: impl Into<TurnApprovalModes>,
    ) -> String {
        if !self.settings.enabled(StatusLineItem::Permissions) {
            return String::new();
        }
        truncate_with_ellipsis(&approval_mode_text(approval.into()), width)
    }

    fn configured_values(
        &self,
        resources: ProcessUsageView,
        location: StatusLineLocation,
    ) -> Vec<DisplayValue> {
        let mut values = Vec::new();
        for item in self.settings.items() {
            if matches!(location, StatusLineLocation::Header)
                && matches!(
                    item,
                    StatusLineItem::Model | StatusLineItem::GitBranch | StatusLineItem::Context
                )
            {
                continue;
            }
            let start = values.len();
            match item {
                StatusLineItem::Context => values.push(self.context_display()),
                StatusLineItem::Permissions => {}
                StatusLineItem::Model => values.extend(self.model.iter().cloned()),
                StatusLineItem::CacheHitRate => values.extend(self.cache_hit_rate.iter().cloned()),
                StatusLineItem::ReferenceCost => values.extend(self.reference_cost.iter().cloned()),
                StatusLineItem::Memory => values.push(DisplayValue::process_resource(
                    format!("memory {}", format_process_memory(resources.memory)),
                    format_compact_process_memory(resources.memory),
                    ProcessResourceMetrics::Memory,
                )),
                StatusLineItem::Cpu => values.push(DisplayValue::process_resource(
                    format!("cpu {}", format_process_cpu(resources.cpu)),
                    format_compact_process_cpu(resources.cpu),
                    ProcessResourceMetrics::Cpu,
                )),
                StatusLineItem::GitBranch => values.extend(self.git_branch.iter().cloned()),
                StatusLineItem::GitChanges => values.extend(self.git_changes_display().into_iter()),
            }
            if self.settings.style() == StatusLineStyle::Rich && item != StatusLineItem::Context {
                let icon = match item {
                    StatusLineItem::Model => "🤖",
                    StatusLineItem::CacheHitRate => "⚡",
                    StatusLineItem::ReferenceCost => "💰",
                    StatusLineItem::Memory => "💾",
                    StatusLineItem::Cpu => "🖥️",
                    StatusLineItem::GitBranch => self.branch_marker(),
                    StatusLineItem::GitChanges => "📝",
                    StatusLineItem::Permissions | StatusLineItem::Context => "",
                };
                for value in &mut values[start..] {
                    value
                        .full
                        .insert(0, StatusLineSegment::chrome(format!("{icon} ")));
                }
            }
        }
        values
    }

    fn context_display(&self) -> DisplayValue {
        let (text, percentage, _, _) = self.context_measurement();
        if self.settings.style() == StatusLineStyle::Rich {
            progress_value("🧠", "context", &text, percentage)
        } else {
            DisplayValue::plain(format!("context {text}"), format!("context {text}"))
        }
    }

    pub(super) fn context_header_segments(&self, progress: bool) -> Vec<StatusLineSegment> {
        let (text, percentage, used, capacity) = self.context_measurement();
        let mut segments = vec![StatusLineSegment::chrome("[")];
        if progress {
            segments.extend(progress_segments(&text, percentage));
        } else {
            let ratio = match (used, capacity) {
                (Some(used), Some(capacity)) => {
                    let prefix = if text.starts_with('~') { "~" } else { "" };
                    format!(
                        "{prefix}{} / {}",
                        compact_tokens(used),
                        compact_tokens(capacity)
                    )
                }
                _ => "— / —".into(),
            };
            segments.push(StatusLineSegment::chrome(ratio));
        }
        segments.push(StatusLineSegment::chrome("]"));
        segments
    }

    fn context_measurement(&self) -> (String, Option<usize>, Option<u64>, Option<u64>) {
        let usage = self.context_usage.as_ref().filter(|(model, _)| {
            self.context_model.as_ref().is_some_and(|selected| {
                selected.provider == model.provider.as_str()
                    && selected.model == model.model.as_str()
            })
        });
        match (usage, self.context_capacity) {
            (Some((_, usage)), Some(capacity)) => {
                let percentage =
                    (u128::from(usage.used_tokens) * 100 / u128::from(capacity)).min(100) as usize;
                let prefix = if usage.source == ash_protocol::ModelContextUsageSource::Estimated {
                    "~"
                } else {
                    ""
                };
                (
                    format!("{prefix}{percentage}%"),
                    Some(percentage),
                    Some(usage.used_tokens),
                    Some(capacity),
                )
            }
            _ => ("unknown".into(), None, None, self.context_capacity),
        }
    }

    fn git_changes_display(&self) -> Option<DisplayValue> {
        if self.git_change_count == 0 {
            return None;
        }
        if self.settings.show_git_changes_as_diff() {
            self.git_diff_statistics.map(|statistics| {
                let segments = vec![
                    StatusLineSegment::inserted(format!("+{}", statistics.additions)),
                    StatusLineSegment::chrome(" "),
                    StatusLineSegment::removed(format!("-{}", statistics.deletions)),
                ];
                DisplayValue {
                    full: segments.clone(),
                    compact: segments,
                    process_resources: None,
                }
            })
        } else {
            Some(DisplayValue::plain(
                if self.git_change_count == 1 {
                    "1 change".into()
                } else {
                    format!("{} changes", self.git_change_count)
                },
                "*",
            ))
        }
    }
}

fn progress_value(icon: &str, label: &str, text: &str, percentage: Option<usize>) -> DisplayValue {
    let compact = vec![StatusLineSegment::chrome(format!("{label} {text}"))];
    let mut full = vec![StatusLineSegment::chrome(format!("{icon} {label} "))];
    full.extend(progress_segments(text, percentage));
    DisplayValue {
        full,
        compact,
        process_resources: None,
    }
}

fn progress_segments(text: &str, percentage: Option<usize>) -> Vec<StatusLineSegment> {
    let mut segments = Vec::new();
    if let Some(percentage) = percentage {
        let filled = percentage.min(100) / 10;
        segments.push(StatusLineSegment {
            text: "█".repeat(filled),
            kind: StatusLineSegmentKind::Progress,
        });
        segments.push(StatusLineSegment::chrome(format!(
            "{} ",
            "░".repeat(10 - filled)
        )));
    }
    segments.push(StatusLineSegment::chrome(text));
    segments
}

fn compact_tokens(tokens: u64) -> String {
    let (value, suffix) = if tokens >= 1_000_000 {
        (tokens as f64 / 1_000_000.0, "m")
    } else if tokens >= 1_000 {
        (tokens as f64 / 1_000.0, "k")
    } else {
        return tokens.to_string();
    };
    let value = format!("{value:.1}");
    format!("{}{suffix}", value.strip_suffix(".0").unwrap_or(&value))
}

fn git_status_cursor(status: &GitStatusResult) -> GitStatusCursor {
    GitStatusCursor {
        repository_id: status.repository_id.clone(),
        stream_instance_id: status.stream_instance_id.clone(),
        revision: status.revision,
    }
}

fn git_status_is_older(next: &GitStatusCursor, current: &GitStatusCursor) -> bool {
    next.repository_id == current.repository_id
        && next.stream_instance_id == current.stream_instance_id
        && next.revision < current.revision
}

fn cache_hit_rate_display(usage: &ModelUsageSummary) -> Option<DisplayValue> {
    format_cache_hit_rate(usage).map(|percentage| {
        DisplayValue::plain(
            format!("cache hit {percentage}"),
            if percentage == "unknown" {
                "cache ?".into()
            } else {
                format!("cache {percentage}")
            },
        )
    })
}

fn reference_cost_display(
    model_invocations: u64,
    summary: &ModelReferenceCostSummary,
) -> Option<DisplayValue> {
    format_reference_cost(model_invocations, summary).map(|amount| {
        DisplayValue::plain(
            format!("cost {amount}"),
            if amount == "unknown" {
                "cost ?".into()
            } else {
                amount
            },
        )
    })
}

pub(super) fn format_cache_hit_rate(usage: &ModelUsageSummary) -> Option<String> {
    if usage.model_invocations == 0 {
        return None;
    }
    let input = &usage.input_tokens;
    let cached = &usage.cached_input_tokens;
    if !input.complete
        || !cached.complete
        || input.reported == 0
        || cached.reported > input.reported
    {
        return Some("unknown".into());
    }
    let percentage_tenths = u128::from(cached.reported) * 1_000 / u128::from(input.reported);
    Some(format!(
        "{}.{:01}%",
        percentage_tenths / 10,
        percentage_tenths % 10
    ))
}

pub(super) fn format_reference_cost(
    model_invocations: u64,
    summary: &ModelReferenceCostSummary,
) -> Option<String> {
    if model_invocations == 0 {
        return None;
    }
    let [amount] = summary.known_amounts.as_slice() else {
        return Some("unknown".into());
    };
    let Some(amount) = format_money(amount) else {
        return Some("unknown".into());
    };
    let prefix = if summary.complete { "" } else { "≥" };
    Some(format!("{prefix}{amount}"))
}

fn format_money(amount: &ModelMoneyAmount) -> Option<String> {
    let pico_units = amount.pico_units.parse::<u128>().ok()?;
    let whole = pico_units / 1_000_000_000_000;
    let remainder = pico_units % 1_000_000_000_000;
    let number = if remainder == 0 {
        whole.to_string()
    } else {
        let fraction = format!("{remainder:012}");
        format!("{whole}.{}", fraction.trim_end_matches('0'))
    };
    Some(if amount.currency == "USD" {
        format!("${number}")
    } else {
        format!("{} {number}", amount.currency)
    })
}

struct StatusLineLayout {
    segments: Vec<StatusLineSegment>,
    process_resources: Option<ProcessResourceMetrics>,
}

fn fit_values(values: &[DisplayValue], width: usize) -> FittedValues {
    if width == 0 {
        return FittedValues {
            segments: Vec::new(),
            visible_values: 0,
        };
    }

    if values.is_empty() {
        return FittedValues {
            segments: Vec::new(),
            visible_values: 0,
        };
    }

    let full = join_values(values, false);
    if segments_width(&full) <= width {
        return FittedValues {
            segments: full,
            visible_values: values.len(),
        };
    }

    let mut shortened = full.clone();
    for index in 0..shortened.len() {
        if shortened[index].kind == StatusLineSegmentKind::Progress {
            let filled = shortened[index].text.chars().count() * 4 / 10;
            shortened[index].text = "█".repeat(filled);
            shortened[index + 1].text = format!("{} ", "░".repeat(4 - filled));
        }
    }
    if segments_width(&shortened) <= width {
        return FittedValues {
            segments: shortened,
            visible_values: values.len(),
        };
    }

    let compact = join_values(values, true);
    if segments_width(&compact) <= width {
        return FittedValues {
            segments: compact,
            visible_values: values.len(),
        };
    }

    for visible in (1..values.len()).rev() {
        let candidate = join_values(&values[..visible], true);
        if segments_width(&candidate) <= width {
            return FittedValues {
                segments: candidate,
                visible_values: visible,
            };
        }
    }

    FittedValues {
        segments: truncate_segments_with_ellipsis(&values[0].compact, width),
        visible_values: usize::from(width > 1),
    }
}

fn join_values(values: &[DisplayValue], compact: bool) -> Vec<StatusLineSegment> {
    let mut segments = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            segments.push(StatusLineSegment::chrome(SEPARATOR));
        }
        segments.extend(
            if compact { &value.compact } else { &value.full }
                .iter()
                .cloned(),
        );
    }
    segments
}

fn segments_width(segments: &[StatusLineSegment]) -> usize {
    segments.iter().map(|segment| segment.text.width()).sum()
}

fn truncate_segments_with_ellipsis(
    segments: &[StatusLineSegment],
    width: usize,
) -> Vec<StatusLineSegment> {
    if width == 0 {
        return Vec::new();
    }
    if segments_width(segments) <= width {
        return segments.to_vec();
    }
    if width == 1 {
        return vec![StatusLineSegment::chrome("…")];
    }

    let content_width = width - 1;
    let mut rendered = Vec::new();
    let mut rendered_width = 0;
    for segment in segments {
        let mut text = String::new();
        let mut truncated = false;
        for character in segment.text.graphemes(true) {
            let character_width = character.width();
            if rendered_width + character_width > content_width {
                truncated = true;
                break;
            }
            text.push_str(character);
            rendered_width += character_width;
        }
        if !text.is_empty() {
            rendered.push(StatusLineSegment {
                text,
                kind: segment.kind,
            });
        }
        if truncated || rendered_width == content_width {
            break;
        }
    }
    rendered.push(StatusLineSegment::chrome("…"));
    rendered
}

pub(super) fn approval_mode_text(approval: TurnApprovalModes) -> String {
    let next = approval_mode_display(approval.next);
    match approval.current {
        Some(current) if current != approval.next => {
            let current = approval_mode_display(current);
            format!(
                "{} current: {} · {} next: {}",
                current.icon, current.label, next.icon, next.label
            )
        }
        _ => format!("{} {}", next.icon, next.label),
    }
}

pub(super) fn approval_mode_display(approval_mode: ApprovalMode) -> ApprovalModeDisplay {
    match approval_mode {
        ApprovalMode::AskPermissions => ApprovalModeDisplay {
            icon: "⏸",
            label: "ask permissions on",
        },
        ApprovalMode::AutoReview => ApprovalModeDisplay {
            icon: "⏩",
            label: "auto review on",
        },
        ApprovalMode::BypassPermissions => ApprovalModeDisplay {
            icon: "▶",
            label: "bypass permissions on",
        },
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
