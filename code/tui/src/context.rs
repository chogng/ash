use crate::keymap::KeyEvent;
use crate::keymap::bindings;
use crate::nls::Text;
use crate::render::RenderContext;
use crate::status::compact_tokens;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionInputOutcome;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionPointerTarget;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::navigation::Navigation;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::model::ContextReadDetail;
use ash_app_server_protocol::protocol::model::ContextReadParams;
use ash_app_server_protocol::protocol::model::ContextReadScope;
use ash_app_server_protocol::protocol::model::ContextToolDefinition;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelContextCategory;
use ash_protocol::ModelContextInspection;
use ash_protocol::ModelContextUsageSource;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Consumed,
    Dismiss,
}

#[derive(Debug)]
pub(crate) struct Panel {
    pages: ListSelectionState,
    model: Text,
    inspection: ash_protocol::ModelContextInspection,
    language: crate::nls::Language,
}

impl Panel {
    pub(crate) fn title(&self) -> &str {
        self.pages.title()
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.pages.localize(language);
        self.model.localize(language);
    }
    pub(crate) fn body_rows(&self, width: u16) -> u16 {
        ((crate::render::wrapped_height(&self.context_lines(width), width) + 1)
            .min(usize::from(u16::MAX)) as u16)
            .saturating_add(self.pages.body_rows(width))
    }
    pub(crate) fn handle_key(&mut self, key: KeyEvent, body: Rect) -> Outcome {
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            return Outcome::Dismiss;
        }
        if let Some(navigation) = Navigation::from_key(key)
            && !matches!(navigation, Navigation::Previous | Navigation::Next)
        {
            self.scroll(navigation, body);
            return Outcome::Consumed;
        }
        match self.pages.handle_key(key) {
            ListSelectionInputOutcome::Activate(_) => self.pages.toggle_selected_details(),
            ListSelectionInputOutcome::Dismiss => return Outcome::Dismiss,
            ListSelectionInputOutcome::Adjust(_, _)
            | ListSelectionInputOutcome::Consumed
            | ListSelectionInputOutcome::FocusPrevious => {}
        }
        Outcome::Consumed
    }
    pub(crate) fn scroll(&mut self, navigation: Navigation, body: Rect) {
        let list = self.context_areas(body)[1];
        let lines = match navigation {
            Navigation::Previous => -1,
            Navigation::Next => 1,
            Navigation::PagePrevious => -(list.height as i16),
            Navigation::PageNext => list.height as i16,
            Navigation::First => i16::MIN,
            Navigation::Last => i16::MAX,
        };
        self.pages.scroll_with_selection(list, lines);
    }
    pub(crate) fn pointer_target_at(
        &self,
        body: Rect,
        position: Position,
    ) -> Option<ListSelectionPointerTarget> {
        list_selection::pointer_target_at(
            &self.pages,
            Rect::default(),
            self.context_areas(body)[1],
            position,
        )
        .filter(|target| {
            matches!(target, ListSelectionPointerTarget::Item(id)
                if self.pages.visible_items().iter().any(|item|
                    item.id() == Some(id) && item.has_expandable_details()))
        })
    }
    pub(crate) fn handle_click(
        &mut self,
        target: &ListSelectionPointerTarget,
        body: Rect,
    ) -> Outcome {
        if self.pages.focus_pointer(target) && matches!(target, ListSelectionPointerTarget::Item(_))
        {
            return self.handle_key(
                KeyEvent::new(
                    crossterm::event::KeyCode::Enter,
                    crossterm::event::KeyModifiers::NONE,
                ),
                body,
            );
        }
        Outcome::Consumed
    }
    pub(crate) fn draw_body(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<&ListSelectionPointerTarget>,
        pressed: Option<&ListSelectionPointerTarget>,
        context: RenderContext<'_>,
    ) {
        let [summary, list] = self.context_areas(area);
        let mut lines = self.context_lines(summary.width);
        let gauge_y = summary.y
            + crate::render::wrapped_height(&lines[..2], summary.width)
                .min(usize::from(summary.height)) as u16;
        if self.inspection.allocation.is_some() {
            // The summary may wrap, but a space-filled gauge must stay on one fixed row.
            lines[2] = Line::default();
        }
        if let Some(line) = lines.get_mut(1) {
            line.style = Style::default().add_modifier(Modifier::BOLD);
            if self
                .inspection
                .allocation
                .as_ref()
                .is_some_and(|allocation| {
                    self.inspection.estimated_tokens > allocation.auto_compact_at
                })
            {
                line.style = line.style.fg(context.warning());
            }
        }
        if let Some(line) = lines.first_mut() {
            line.style = Style::default().add_modifier(Modifier::BOLD);
        }
        if let Some(line) = lines.last_mut() {
            line.style = Style::default().fg(context.muted());
        }
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(context.foreground())),
            summary,
        );
        if self.inspection.allocation.is_some() && gauge_y < summary.bottom() {
            frame.render_widget(
                Paragraph::new(self.gauge_line(summary.width, context)),
                Rect::new(summary.x, gauge_y, summary.width, 1),
            );
        }
        list_selection::draw_body_with_pointer(frame, list, &self.pages, hovered, pressed, context);
    }
    pub(crate) fn key_hints(&self) -> &'static KeyHints {
        if self
            .pages
            .selected_item()
            .is_some_and(ListSelectionItem::has_expandable_details)
        {
            &bindings::CONTEXT_HINTS
        } else {
            &bindings::CONTEXT_SUMMARY_HINTS
        }
    }
    fn context_areas(&self, area: Rect) -> [Rect; 2] {
        let width = area.width;
        let lines = self.context_lines(width);
        let height = crate::render::wrapped_height(&lines, width)
            .min(usize::from(area.height.saturating_sub(2))) as u16;
        let list_y = area
            .y
            .saturating_add(height)
            .saturating_add(u16::from(area.height > height));
        [
            Rect::new(area.x, area.y, width, height),
            Rect::new(
                area.x,
                list_y,
                area.width,
                area.bottom().saturating_sub(list_y),
            ),
        ]
    }

    fn context_lines(&self, width: u16) -> Vec<Line<'static>> {
        let used = compact_tokens(self.inspection.estimated_tokens);
        let headline = match &self.inspection.allocation {
            Some(allocation) => Text::template(
                "{0} / {1} tokens ({2})",
                vec![
                    Text::literal(used),
                    Text::literal(compact_tokens(allocation.context_window)),
                    Text::literal(percentage(
                        self.inspection.estimated_tokens,
                        allocation.context_window,
                    )),
                ],
            ),
            None => Text::template("{0} tokens used", vec![Text::literal(used)]),
        };
        let mut headline = headline;
        headline.localize(self.language);
        let mut lines = vec![
            Line::raw(self.model.to_string()),
            Line::raw(headline.to_string()),
        ];
        if self.inspection.allocation.is_some() {
            lines.push(Line::raw("─".repeat(usize::from(width))));
        }
        lines.push(Line::raw(crate::nls::localize_owned(
            self.language,
            "Estimated usage by category",
        )));
        lines
    }

    fn gauge_line(&self, width: u16, context: RenderContext<'_>) -> Line<'static> {
        let allocation = self.inspection.allocation.as_ref().unwrap();
        let capacity = allocation.context_window;
        let colors = context.identity_colors();
        // The list and gauge share category order. Clip used context at the compaction
        // threshold so output, safety and compaction reservations stay visible on overflow.
        let mut available = allocation.auto_compact_at;
        let mut segments = self
            .inspection
            .categories
            .iter()
            .map(|category| {
                let tokens = category.tokens.min(available);
                available -= tokens;
                (tokens, colors[category_index(category.category)])
            })
            .collect::<Vec<_>>();
        // Cell backgrounds make every segment a continuous solid band, independent of
        // font glyph shapes. Reservations share a neutral color; only overuse is a warning.
        segments.extend([
            (available, context.segmented_inactive()),
            (allocation.reserved_output, context.muted()),
            (allocation.safety_margin, context.muted()),
            (allocation.auto_compact_buffer, context.muted()),
        ]);
        let widths = gauge_widths(
            &segments
                .iter()
                .map(|(tokens, _)| *tokens)
                .collect::<Vec<_>>(),
            capacity,
            width,
        );
        let spans = segments
            .into_iter()
            .zip(widths)
            .filter(|(_, cells)| *cells > 0)
            .map(|((_, color), cells)| {
                Span::styled(" ".repeat(usize::from(cells)), Style::default().bg(color))
            })
            .collect::<Vec<_>>();
        Line::from(spans)
    }
}

/// Quantize proportional widths while keeping nonempty segments visible whenever they fit.
/// One cell is the terminal's minimum; the legend remains the quantitative source of truth.
fn gauge_widths(tokens: &[u64], capacity: u64, width: u16) -> Vec<u16> {
    if capacity == 0 {
        return vec![0; tokens.len()];
    }
    let mut remaining_tokens = capacity;
    let mut remaining_width = width;
    let mut cells = vec![0; tokens.len()];
    let mut fixed = tokens.iter().map(|tokens| *tokens == 0).collect::<Vec<_>>();
    if tokens.iter().filter(|tokens| **tokens > 0).count() <= usize::from(width) {
        // Allocate sub-cell segments first, then proportionally divide the remaining
        // space. This keeps large reservations close to their actual window fraction.
        loop {
            let mut changed = false;
            for index in 0..tokens.len() {
                if !fixed[index]
                    && u128::from(tokens[index]) * u128::from(remaining_width)
                        < u128::from(remaining_tokens)
                {
                    cells[index] = 1;
                    fixed[index] = true;
                    remaining_tokens -= tokens[index];
                    remaining_width -= 1;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }
    for index in 0..tokens.len() {
        if !fixed[index] {
            cells[index] = (u128::from(tokens[index]) * u128::from(remaining_width)
                / u128::from(remaining_tokens)) as u16;
        }
    }
    let mut total = cells.iter().map(|cells| u32::from(*cells)).sum::<u32>();
    while total < u32::from(width) {
        let index = (0..tokens.len())
            .filter(|index| !fixed[*index])
            .max_by_key(|index| {
                i128::from(tokens[*index]) * i128::from(remaining_width)
                    - i128::from(cells[*index]) * i128::from(remaining_tokens)
            })
            .expect("nonzero capacity has allocatable gauge cells");
        cells[index] += 1;
        total += 1;
    }
    cells
}

fn percentage(tokens: u64, capacity: u64) -> String {
    if capacity == 0 {
        return "—".into();
    }
    let tenths = (u128::from(tokens) * 1_000 + u128::from(capacity) / 2) / u128::from(capacity);
    format!("{}.{:01}%", tenths / 10, tenths % 10)
}

fn category_index(category: ModelContextCategory) -> usize {
    match category {
        ModelContextCategory::SystemPrompt => 0,
        ModelContextCategory::SystemTools => 1,
        ModelContextCategory::MemoryFiles => 2,
        ModelContextCategory::Skills => 3,
        ModelContextCategory::Conversation => 4,
    }
}

fn category_label(category: ModelContextCategory) -> &'static str {
    match category {
        ModelContextCategory::SystemPrompt => "System prompt",
        ModelContextCategory::SystemTools => "Tool definitions",
        ModelContextCategory::MemoryFiles => "Memory / instruction files",
        ModelContextCategory::Skills => "Skills",
        ModelContextCategory::Conversation => "Conversation and tool results",
    }
}

pub(crate) fn panel(inspection: ModelContextInspection, catalog: &ModelListResult) -> Panel {
    build_panel(inspection, ContextReadDetail::Usage, Vec::new(), catalog)
}

pub(crate) fn diagnostics_panel(
    inspection: ModelContextInspection,
    tool_definitions: Vec<ContextToolDefinition>,
    catalog: &ModelListResult,
) -> Panel {
    build_panel(
        inspection,
        ContextReadDetail::Diagnostics,
        tool_definitions,
        catalog,
    )
}

fn build_panel(
    inspection: ModelContextInspection,
    detail: ContextReadDetail,
    tool_definitions: Vec<ContextToolDefinition>,
    catalog: &ModelListResult,
) -> Panel {
    let capacity = inspection
        .allocation
        .as_ref()
        .map(|allocation| allocation.context_window);
    let value = |tokens: u64| match capacity {
        Some(capacity) => format!(
            "{} ({})",
            compact_tokens(tokens),
            percentage(tokens, capacity)
        ),
        None => compact_tokens(tokens),
    };
    let mut items = inspection
        .categories
        .iter()
        .map(|category| {
            let mut item = ListSelectionItem::new(category_label(category.category))
                .with_id(ListSelectionItemId::new(format!(
                    "category-{}",
                    category_index(category.category)
                )))
                .with_identity_swatch(category_index(category.category))
                .with_columns(
                    category_label(category.category),
                    "",
                    value(category.tokens),
                );
            // Source identities belong to diagnostics; the ordinary view reports category totals.
            if detail == ContextReadDetail::Diagnostics
                && category.category != ModelContextCategory::SystemTools
                && !category.sources.is_empty()
            {
                item = item.with_details(Text::literal(
                    category
                        .sources
                        .iter()
                        .map(|source| {
                            format!("{} · {} tokens", source.name, compact_tokens(source.tokens))
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                ));
            }
            item
        })
        .collect::<Vec<_>>();
    if detail == ContextReadDetail::Diagnostics {
        items.push(ListSelectionItem::new("Tool definition details").as_section_divider());
        for tool in tool_definitions {
            let mut definition = serde_json::json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "strict": tool.strict,
            });
            // Cargo feature unification can enable preserve_order; keep diagnostic output stable.
            definition.sort_all_objects();
            items.push(
                ListSelectionItem::new(Text::literal(tool.name.clone()))
                    .with_id(ListSelectionItemId::new(format!("tool-{}", tool.name)))
                    .with_columns(tool.name, "", value(tool.tokens))
                    .with_details(Text::literal(
                        serde_json::to_string_pretty(&definition)
                            .expect("a tool definition is valid JSON"),
                    )),
            );
        }
        items.push(ListSelectionItem::new("Context allocation").as_section_divider());
    }
    if let Some(allocation) = &inspection.allocation {
        for (label, tokens) in [
            (
                "Free space",
                allocation
                    .auto_compact_at
                    .saturating_sub(inspection.estimated_tokens),
            ),
            ("Output reserve", allocation.reserved_output),
            ("Safety margin", allocation.safety_margin),
            ("Autocompact buffer", allocation.auto_compact_buffer),
        ] {
            items.push(
                ListSelectionItem::new(Text::template(
                    "{0} {1}",
                    vec![Text::literal("■"), Text::from(label)],
                ))
                .with_columns(label, "", value(tokens)),
            );
        }
        items.push(ListSelectionItem::new("Auto-compact window").with_columns(
            "Auto-compact window",
            "",
            value(allocation.auto_compact_window),
        ));
        items.push(
            ListSelectionItem::new("Auto-compact threshold").with_columns(
                "Auto-compact threshold",
                "",
                value(allocation.auto_compact_at),
            ),
        );
        if inspection.estimated_tokens > allocation.auto_compact_at {
            items.push(
                ListSelectionItem::new("Above auto-compact threshold").with_columns(
                    "Above auto-compact threshold",
                    "",
                    value(inspection.estimated_tokens - allocation.auto_compact_at),
                ),
            );
        }
    } else {
        items.push(ListSelectionItem::new("Context window").with_columns(
            "Context window",
            "",
            "Not reported",
        ));
    }
    if let Some(usage) = &inspection.latest_request {
        let label = match usage.source {
            ModelContextUsageSource::ProviderReported => "Latest request · provider reported",
            ModelContextUsageSource::Estimated => "Latest request · estimated",
        };
        items.push(ListSelectionItem::new(label).with_columns(
            label,
            "",
            format!("{} tokens", compact_tokens(usage.used_tokens)),
        ));
    }
    let title = match detail {
        ContextReadDetail::Usage => "Context",
        ContextReadDetail::Diagnostics => "Developer: Context diagnostics",
    };
    let pages = ListSelectionModel::new(title, vec![ListSelectionGroup::new(title, items)])
        .with_expandable_descriptions()
        .without_scroll_counts()
        .without_tab_bar();
    Panel {
        pages: ListSelectionState::new(pages),
        model: match &inspection.model {
            Some(model) => catalog
                .models
                .iter()
                .find(|entry| &entry.model == model)
                .map(|entry| Text::literal(entry.display_name.clone()))
                .unwrap_or_else(|| Text::from("Not reported")),
            None => Text::from("Automatic model"),
        },
        inspection,
        language: crate::nls::Language::English,
    }
}

pub(crate) enum Event {
    Opened(Panel),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPanel,
}
impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        "ash-tui-read-context"
    }
}
pub(crate) struct RequestScope<'a> {
    pub(crate) session_id: &'a SessionId,
    pub(crate) thread_id: &'a ThreadId,
}

pub(crate) fn load_panel<T>(
    client: &mut AppServerClient<T>,
    scope: Option<RequestScope<'_>>,
    detail: ContextReadDetail,
) -> Result<Panel, ClientError>
where
    T: JsonRpcTransport,
{
    let scope = match scope {
        Some(scope) => ContextReadScope::Thread {
            session_id: scope.session_id.clone(),
            thread_id: scope.thread_id.clone(),
        },
        None => ContextReadScope::Environment,
    };
    let result = client.read_context(ContextReadParams { scope, detail })?;
    let catalog = if result.context.model.is_some() {
        client.list_models()?
    } else {
        ModelListResult { models: Vec::new() }
    };
    Ok(match detail {
        ContextReadDetail::Usage => panel(result.context, &catalog),
        ContextReadDetail::Diagnostics => {
            diagnostics_panel(result.context, result.tool_definitions, &catalog)
        }
    })
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;

impl crate::app::command_panel::PanelContent for Panel {
    fn body(&self) -> crate::app::command_panel::CommandPanelBody<'_> {
        use crate::app::command_panel::CommandPanelBody;
        CommandPanelBody::Context(self)
    }
    fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        self.key_hints()
    }
    fn localize(&mut self, language: crate::nls::Language) {
        self.localize(language);
    }
}
