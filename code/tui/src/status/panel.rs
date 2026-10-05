use crate::keymap::KeyEvent;
use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionPointerTarget;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::navigation::Navigation;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

use super::AppServerResourcesView;
use super::ProcessResourcesView;
use super::format_process_usage;
use super::model::format_cache_hit_rate;
use super::model::format_reference_cost;
use crate::widgets::detail_list;
use crate::widgets::detail_list::DetailList;
use crate::widgets::detail_list::DetailListRow;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsageSummary;
use ash_protocol::ModelUsageTotal;

const SESSION_TAB: usize = 0;
const DIAGNOSTICS_TAB: usize = 1;
pub(crate) struct StatusViewData<'a> {
    pub(crate) model: &'a str,
    pub(crate) usage: &'a ModelUsageSummary,
    pub(crate) reference_cost: &'a ModelReferenceCostSummary,
    pub(crate) session_id: &'a str,
    pub(crate) thread_id: &'a str,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StatusPanelOutcome {
    Consumed,
    Dismiss,
}
#[derive(Debug)]
pub(crate) struct StatusPanel {
    pages: ListSelectionState,
    identity: DetailList,
    usage: DetailList,
    diagnostics: DetailList,
    process_resources: ProcessResourcesView,
    memory_diagnostics: crate::memory::Status,
    scroll: [u16; 2],
    language: crate::nls::Language,
}
impl StatusPanel {
    pub(crate) fn title(&self) -> &str {
        self.pages.title()
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.pages.localize(language);
        self.identity.localize(language);
        self.usage.localize(language);
        self.rebuild_diagnostics();
    }
    pub(crate) fn apply_process_resources(&mut self, resources: ProcessResourcesView) {
        self.process_resources = resources;
        self.rebuild_diagnostics();
    }
    pub(crate) fn apply_memory_diagnostics(&mut self, status: crate::memory::Status) {
        self.memory_diagnostics = status;
        self.rebuild_diagnostics();
    }
    fn rebuild_diagnostics(&mut self) {
        self.diagnostics = DetailList::new(
            "Diagnostics",
            process_rows(&self.process_resources, self.memory_diagnostics),
        );
        self.diagnostics.localize(self.language);
    }
    pub(crate) fn tab_rows(&self, width: u16) -> u16 {
        self.pages.tab_rows(width)
    }
    fn session_height(&self, width: u16) -> usize {
        self.identity.content_height(width)
            + 1
            + crate::render::wrapped_height(
                &[Line::raw(crate::nls::localize_owned(
                    self.language,
                    "Thread totals",
                ))],
                width,
            )
            + self.usage.content_height(width)
    }
    pub(crate) fn body_rows(&self, width: u16) -> u16 {
        self.session_height(width)
            .max(self.diagnostics.content_height(width))
            .min(usize::from(u16::MAX)) as u16
    }
    pub(crate) fn handle_key(&mut self, key: KeyEvent, body: Rect) -> StatusPanelOutcome {
        if let Some(navigation) = Navigation::from_key(key) {
            self.scroll(navigation, body);
            return StatusPanelOutcome::Consumed;
        }
        match self.pages.handle_key(key) {
            crate::widgets::list_selection::ListSelectionInputOutcome::Dismiss => {
                StatusPanelOutcome::Dismiss
            }
            crate::widgets::list_selection::ListSelectionInputOutcome::Activate(_)
            | crate::widgets::list_selection::ListSelectionInputOutcome::Adjust(_, _)
            | crate::widgets::list_selection::ListSelectionInputOutcome::Consumed
            | crate::widgets::list_selection::ListSelectionInputOutcome::FocusPrevious => {
                StatusPanelOutcome::Consumed
            }
        }
    }
    pub(crate) fn scroll(&mut self, navigation: Navigation, body: Rect) {
        let index = self.pages.active_tab_index();
        let height = if index == SESSION_TAB {
            self.session_height(body.width)
        } else {
            self.diagnostics.content_height(body.width)
        };
        let last = height.saturating_sub(usize::from(body.height));
        self.scroll[index] = navigation
            .offset(
                usize::from(self.scroll[index]),
                last,
                usize::from(body.height),
            )
            .min(usize::from(u16::MAX)) as u16;
    }
    pub(crate) fn pointer_target_at(
        &self,
        tabs: Rect,
        _body: Rect,
        position: Position,
    ) -> Option<ListSelectionPointerTarget> {
        list_selection::pointer_target_at(&self.pages, tabs, Rect::default(), position)
    }
    pub(crate) fn handle_click(
        &mut self,
        target: &ListSelectionPointerTarget,
        _body: Rect,
    ) -> StatusPanelOutcome {
        self.pages.focus_pointer(target);
        StatusPanelOutcome::Consumed
    }
    pub(crate) fn draw_tabs(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<usize>,
        pressed: Option<usize>,
        context: RenderContext<'_>,
    ) {
        list_selection::draw_tabs(frame, area, &self.pages, hovered, pressed, context);
    }
    pub(crate) fn draw_body(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        _hovered: Option<&ListSelectionPointerTarget>,
        _pressed: Option<&ListSelectionPointerTarget>,
        context: RenderContext<'_>,
    ) {
        if self.pages.active_tab_index() == DIAGNOSTICS_TAB {
            let last = self
                .diagnostics
                .content_height(area.width)
                .saturating_sub(usize::from(area.height));
            detail_list::draw_body_scrolled(
                frame,
                area,
                &self.diagnostics,
                self.scroll[DIAGNOSTICS_TAB].min(last.min(usize::from(u16::MAX)) as u16),
                context,
            );
            return;
        }
        let mut lines = detail_list::body_lines(&self.identity, context);
        lines.push(Line::default());
        lines.push(Line::styled(
            context.localize("Thread totals").into_owned(),
            Style::default().add_modifier(Modifier::BOLD),
        ));
        lines.extend(detail_list::body_lines(&self.usage, context));
        let last = self
            .session_height(area.width)
            .saturating_sub(usize::from(area.height));
        frame.render_widget(
            Paragraph::new(lines).wrap(Wrap { trim: false }).scroll((
                self.scroll[SESSION_TAB].min(last.min(usize::from(u16::MAX)) as u16),
                0,
            )),
            area,
        );
    }
    pub(crate) fn key_hints(&self) -> &'static KeyHints {
        &bindings::STATUS_HINTS
    }
    pub(crate) fn process_resources_visible(&self, area: Rect) -> bool {
        self.pages.active_tab_index() == DIAGNOSTICS_TAB && !area.is_empty()
    }
}
pub(crate) fn status_panel(data: StatusViewData<'_>) -> StatusPanel {
    let model = ListSelectionModel::new(
        "Session status",
        vec![
            ListSelectionGroup::new("Session", Vec::new()),
            ListSelectionGroup::new("Diagnostics", Vec::new()),
        ],
    );
    let usage = DetailList::new(
        "Thread totals",
        vec![
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
        ],
    );
    let identity = DetailList::new(
        "Session",
        vec![
            detail("Model", data.model),
            detail(
                "Session ID",
                data.session_id
                    .strip_prefix("thread:")
                    .unwrap_or(data.session_id),
            ),
            detail("Thread ID", data.thread_id),
        ],
    );
    let mut panel = StatusPanel {
        pages: ListSelectionState::new(model),
        identity,
        usage,
        diagnostics: DetailList::new("Diagnostics", Vec::new()),
        process_resources: ProcessResourcesView::default(),
        memory_diagnostics: crate::memory::Status::Disabled,
        scroll: [0; 2],
        language: crate::nls::Language::English,
    };
    panel.rebuild_diagnostics();
    panel
}
fn process_rows(
    resources: &ProcessResourcesView,
    memory_diagnostics: crate::memory::Status,
) -> Vec<DetailListRow> {
    let mut rows = vec![
        detail("Total", format_process_usage(resources.local)),
        detail("TUI", format_process_usage(resources.tui)),
    ];
    match &resources.app_server {
        AppServerResourcesView::IncludedInTui => {
            rows.push(detail("App Server", "included in the TUI process"));
        }
        AppServerResourcesView::Local(app_server) => {
            rows.push(detail("App Server", format_process_usage(app_server.total)));
            for process in &app_server.descendants {
                let indent = "  ".repeat(process.depth.saturating_sub(1));
                let label = format!("{indent}• {} (PID {})", process.name, process.process_id);
                rows.push(detail(label, format_process_usage(process.usage)));
            }
        }
        AppServerResourcesView::Remote => {
            rows.push(detail("App Server", "remote — excluded from local totals"));
        }
    }
    rows.push(detail(
        "Memory diagnostics",
        match memory_diagnostics {
            crate::memory::Status::Disabled => "Disabled",
            crate::memory::Status::Starting => "Starting",
            crate::memory::Status::Recording => "Recording",
            crate::memory::Status::Stopping => "Stopping",
            crate::memory::Status::Failed => "Failed",
        },
    ));
    rows
}

fn detail(label: impl Into<String>, value: impl Into<String>) -> DetailListRow {
    DetailListRow::new(label, value)
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

fn format_tokens(tokens: u64) -> String {
    format!("{} tokens", format_token_count(tokens))
}

pub(crate) fn format_token_count(tokens: u64) -> String {
    let digits = tokens.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3 + 7);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            formatted.push(',');
        }
        formatted.push(character);
    }
    formatted
}

#[cfg(test)]
#[path = "panel_tests.rs"]
mod tests;

impl crate::app::command_panel::PanelContent for StatusPanel {
    fn body(&self) -> crate::app::command_panel::CommandPanelBody<'_> {
        use crate::app::command_panel::CommandPanelBody;
        CommandPanelBody::Status(self)
    }
    fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        self.key_hints()
    }
    fn localize(&mut self, language: crate::nls::Language) {
        self.localize(language);
    }
}
