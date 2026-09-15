use super::AppServerResourcesView;
use super::ProcessMemoryCurrent;
use super::ProcessResourcesView;
use super::format_memory_bytes;
use super::format_memory_change;
use super::format_process_cpu;
use super::format_process_memory;
use super::model::format_cache_hit_rate;
use super::model::format_reference_cost;
use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::widgets::detail_list;
use crate::widgets::detail_list::DetailList;
use crate::widgets::detail_list::DetailListRow;
use crate::widgets::navigation::Navigation;
use crate::widgets::tab_list;
use crate::widgets::tab_list::TabListItem;
use crate::widgets::tab_list::TabListState;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsageSummary;
use ash_protocol::ModelUsageTotal;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Rect;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StatusSection {
    Thread,
    Processes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StatusTab {
    section: StatusSection,
    label: &'static str,
}

impl TabListItem for StatusTab {
    fn tab_label(&self) -> &str {
        self.label
    }
}

pub(crate) struct StatusViewData<'a> {
    pub(crate) model: &'a str,
    pub(crate) full_context_window: Option<u64>,
    pub(crate) available_context_window: Option<u64>,
    pub(crate) remaining_context_window: RemainingContextWindow,
    pub(crate) usage: &'a ModelUsageSummary,
    pub(crate) reference_cost: &'a ModelReferenceCostSummary,
    pub(crate) session_id: &'a str,
    pub(crate) thread_id: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemainingContextWindow {
    Exact {
        remaining_tokens: u64,
        available_tokens: u64,
    },
    Estimated {
        remaining_tokens: u64,
        available_tokens: u64,
    },
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StatusPanelOutcome {
    Consumed,
    Dismiss,
}

#[derive(Debug)]
pub(crate) struct StatusPanel {
    tabs: TabListState<StatusTab>,
    session: DetailList,
    processes: DetailList,
    process_resources: ProcessResourcesView,
    memory_diagnostics: crate::memory::Status,
    scroll: [u16; 2],
}

impl StatusPanel {
    pub(crate) fn title(&self) -> &str {
        "Status"
    }

    pub(crate) fn apply_process_resources(&mut self, resources: ProcessResourcesView) {
        self.process_resources = resources;
        self.rebuild_processes();
    }

    pub(crate) fn apply_memory_diagnostics(&mut self, status: crate::memory::Status) {
        self.memory_diagnostics = status;
        self.rebuild_processes();
    }

    fn rebuild_processes(&mut self) {
        self.processes = DetailList::new(
            "Processes",
            process_rows(&self.process_resources, self.memory_diagnostics),
        );
    }

    pub(crate) fn tab_rows(&self, width: u16) -> u16 {
        tab_list::desired_height(self.tabs.tabs(), width)
    }

    pub(crate) fn body_rows(&self, width: u16) -> u16 {
        let rows = self
            .session
            .content_height(width)
            .max(self.processes.content_height(width));
        u16::try_from(rows).unwrap_or(u16::MAX)
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent, body: Rect) -> StatusPanelOutcome {
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            return StatusPanelOutcome::Dismiss;
        }
        if let Some(navigation) = Navigation::from_key(key) {
            self.scroll(navigation, body);
        } else {
            self.tabs.handle_key(key);
        }
        StatusPanelOutcome::Consumed
    }

    pub(crate) fn scroll(&mut self, navigation: Navigation, body: Rect) {
        let last = self
            .active_detail()
            .content_height(body.width)
            .saturating_sub(usize::from(body.height));
        let scroll = &mut self.scroll[self.tabs.active_index().expect("status tabs are enabled")];
        *scroll = navigation
            .offset(usize::from(*scroll), last, usize::from(body.height))
            .min(usize::from(u16::MAX)) as u16;
    }

    pub(crate) fn tab_at(&self, area: Rect, position: ratatui::layout::Position) -> Option<usize> {
        crate::widgets::tab_list::index_at(self.tabs.tabs(), area, position)
    }

    pub(crate) fn select_tab(&mut self, index: usize) {
        self.tabs.select(index);
    }

    pub(crate) fn draw_tabs(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered_tab: Option<usize>,
        pressed_tab: Option<usize>,
        context: RenderContext<'_>,
    ) {
        tab_list::draw(
            frame,
            area,
            &self.tabs,
            false,
            hovered_tab,
            pressed_tab,
            context,
        );
    }

    pub(crate) fn draw_body(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        let detail = self.active_detail();
        let visible_rows = area.height;
        let content_height = u16::try_from(detail.content_height(area.width)).unwrap_or(u16::MAX);
        let allocated_max_scroll = content_height.saturating_sub(visible_rows);
        detail_list::draw_body_scrolled(
            frame,
            area,
            detail,
            self.scroll[self.tabs.active_index().expect("status tabs are enabled")]
                .min(allocated_max_scroll),
            context,
        );
    }

    pub(crate) fn key_hints(&self) -> &'static crate::widgets::key_hint::KeyHints {
        &bindings::STATUS_HINTS
    }

    pub(crate) fn process_resources_visible(&self, area: Rect) -> bool {
        if !matches!(
            self.tabs
                .active_tab()
                .expect("status tabs are enabled")
                .section,
            StatusSection::Processes
        ) {
            return false;
        }
        area.width > 0 && area.height > 0
    }

    fn active_detail(&self) -> &DetailList {
        match self
            .tabs
            .active_tab()
            .expect("status tabs are enabled")
            .section
        {
            StatusSection::Thread => &self.session,
            StatusSection::Processes => &self.processes,
        }
    }
}

pub(crate) fn status_panel(data: StatusViewData<'_>) -> StatusPanel {
    let base_rows = vec![
        detail("Model", data.model),
        detail(
            "Full context window",
            format_optional_tokens(data.full_context_window),
        ),
        detail(
            "Available context window",
            format_optional_tokens(data.available_context_window),
        ),
        detail(
            "Remaining context window",
            format_remaining_context(data.remaining_context_window),
        ),
        detail("Model calls", data.usage.model_invocations.to_string()),
        detail("Input tokens", format_usage_total(&data.usage.input_tokens)),
        detail(
            "Cached input",
            format_usage_total(&data.usage.cached_input_tokens),
        ),
        detail(
            "Cached input share",
            format_cache_hit_rate(data.usage).unwrap_or_else(|| "unknown".into()),
        ),
        detail(
            "Cache writes",
            format_usage_total(&data.usage.cache_write_input_tokens),
        ),
        detail(
            "Output tokens",
            format_usage_total(&data.usage.output_tokens),
        ),
        detail(
            "Reasoning output",
            format_usage_total(&data.usage.reasoning_tokens),
        ),
        detail(
            "Reference cost",
            format_reference_cost(data.usage.model_invocations, data.reference_cost)
                .unwrap_or_else(|| "unknown".into()),
        ),
        detail(
            "Session ID",
            data.session_id
                .strip_prefix("thread:")
                .unwrap_or(data.session_id),
        ),
        detail("Thread ID", data.thread_id),
    ];
    let process_resources = ProcessResourcesView::default();
    let memory_diagnostics = crate::memory::Status::Disabled;
    StatusPanel {
        tabs: TabListState::new(status_tabs()),
        session: DetailList::new("Thread", base_rows),
        processes: DetailList::new(
            "Processes",
            process_rows(&process_resources, memory_diagnostics),
        ),
        process_resources,
        memory_diagnostics,
        scroll: [0, 0],
    }
}

fn status_tabs() -> Vec<StatusTab> {
    vec![
        StatusTab {
            section: StatusSection::Thread,
            label: "Thread",
        },
        StatusTab {
            section: StatusSection::Processes,
            label: "Processes",
        },
    ]
}

fn process_rows(
    resources: &ProcessResourcesView,
    memory_diagnostics: crate::memory::Status,
) -> Vec<DetailListRow> {
    let observed_peak = resources.observed_peak_bytes.map_or_else(
        || match resources.local.memory {
            ProcessMemoryCurrent::Unavailable => "unavailable".into(),
            ProcessMemoryCurrent::Collecting | ProcessMemoryCurrent::Available(_) => {
                "collecting".into()
            }
        },
        format_memory_bytes,
    );
    let change = |change| match resources.local.memory {
        ProcessMemoryCurrent::Unavailable => "unavailable".into(),
        ProcessMemoryCurrent::Collecting | ProcessMemoryCurrent::Available(_) => {
            format_memory_change(change)
        }
    };
    let mut rows = vec![
        detail("Memory diagnostics", memory_diagnostics.label()),
        detail(
            "Local total resident memory",
            format_process_memory(resources.local.memory),
        ),
        detail("Local observed peak", observed_peak),
        detail("Local total CPU", format_process_cpu(resources.local.cpu)),
        detail(
            "1 minute memory change",
            change(resources.one_minute_change_bytes),
        ),
        detail(
            "5 minute memory change",
            change(resources.five_minute_change_bytes),
        ),
        detail(
            "TUI resident memory",
            format_process_memory(resources.tui.memory),
        ),
        detail("TUI CPU", format_process_cpu(resources.tui.cpu)),
    ];
    match &resources.app_server {
        AppServerResourcesView::IncludedInTui => {
            rows.push(detail("App Server", "included in the TUI process"))
        }
        AppServerResourcesView::Local(app_server) => {
            rows.push(detail(
                "App Server total memory",
                format_process_memory(app_server.total.memory),
            ));
            rows.push(detail(
                "App Server total CPU",
                format_process_cpu(app_server.total.cpu),
            ));
            rows.push(detail(
                "App Server process memory",
                format_process_memory(app_server.process.memory),
            ));
            rows.push(detail(
                "App Server process CPU",
                format_process_cpu(app_server.process.cpu),
            ));
            if app_server.descendants.is_empty() {
                rows.push(detail("App Server child processes", "none"));
            } else {
                for process in &app_server.descendants {
                    let indent = "  ".repeat(process.depth.saturating_sub(1));
                    let label = format!("{indent}• {} (PID {})", process.name, process.process_id);
                    let value = format!(
                        "{} · {}",
                        format_process_memory(process.usage.memory),
                        format_process_cpu(process.usage.cpu)
                    );
                    rows.push(detail(label, value));
                }
            }
        }
        AppServerResourcesView::Remote => {
            rows.push(detail("App Server", "remote — excluded from local totals"))
        }
    }
    rows
}

fn detail(label: impl Into<String>, value: impl Into<String>) -> DetailListRow {
    DetailListRow::new(label, value)
}

fn format_optional_tokens(tokens: Option<u64>) -> String {
    tokens.map_or_else(|| "unknown".into(), format_tokens)
}

fn format_usage_total(total: &ModelUsageTotal) -> String {
    if total.complete {
        format_tokens(total.reported)
    } else if total.reported > 0 {
        format!(">={}", format_tokens(total.reported))
    } else {
        "unknown".into()
    }
}

fn format_remaining_context(remaining: RemainingContextWindow) -> String {
    match remaining {
        RemainingContextWindow::Exact {
            remaining_tokens,
            available_tokens,
        } => format_remaining_tokens(remaining_tokens, available_tokens),
        RemainingContextWindow::Estimated {
            remaining_tokens,
            available_tokens,
        } => format!(
            "~{}",
            format_remaining_tokens(remaining_tokens, available_tokens)
        ),
        RemainingContextWindow::Unknown => "unknown".into(),
    }
}

fn format_remaining_tokens(remaining_tokens: u64, available_tokens: u64) -> String {
    let percentage_tenths = if available_tokens == 0 {
        0
    } else {
        (u128::from(remaining_tokens) * 1_000 / u128::from(available_tokens)).min(1_000) as u64
    };
    format!(
        "{} ({}.{:01}%)",
        format_tokens(remaining_tokens),
        percentage_tenths / 10,
        percentage_tenths % 10
    )
}

fn format_tokens(tokens: u64) -> String {
    let digits = tokens.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3 + 7);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            formatted.push(',');
        }
        formatted.push(character);
    }
    formatted.push_str(" tokens");
    formatted
}

#[cfg(test)]
#[path = "panel_tests.rs"]
mod tests;
