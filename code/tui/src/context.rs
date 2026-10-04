use crate::keymap::KeyEvent;
use crate::keymap::bindings;
use crate::nls::Text;
use crate::render::RenderContext;
use crate::status::compact_tokens;
use crate::status::format_token_count;
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
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
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
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

pub(crate) struct ViewData<'a> {
    pub(crate) model: &'a str,
    pub(crate) full_context_window: Option<u64>,
    pub(crate) available_context_window: Option<u64>,
    pub(crate) context_usage: Usage,
}

/// The latest request measurement is independent of both cumulative billing and catalog capacity.
/// Keeping the measured total preserves over-budget usage instead of reconstructing it from a
/// remaining value that has already been clamped to zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Usage {
    NotStarted,
    Pending,
    Measured {
        used_tokens: u64,
        source: ModelContextUsageSource,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Consumed,
    Dismiss,
}

#[derive(Debug)]
pub(crate) struct Panel {
    pages: ListSelectionState,
    model: String,
    available_context_window: Option<u64>,
    context_usage: Usage,
    language: crate::nls::Language,
}

impl Panel {
    pub(crate) fn title(&self) -> &str {
        self.pages.title()
    }
    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
        self.pages.localize(language);
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
        if let Some(navigation) = Navigation::from_key(key) {
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
        self.pages.scroll(list, lines);
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
        if let Some(line) = lines.first_mut() {
            line.style = Style::default().add_modifier(Modifier::BOLD);
        }
        if let Some(line) = lines.get_mut(1) {
            line.style = Style::default().fg(context.muted());
        }
        if let Some(line) = lines.last_mut() {
            line.style = Style::default().fg(context.muted());
        }
        if let Usage::Measured { used_tokens, .. } = self.context_usage
            && let Some(capacity) = self
                .available_context_window
                .filter(|capacity| *capacity > 0)
            && u128::from(used_tokens) * 10 >= u128::from(capacity) * 9
            && let Some(line) = lines.get_mut(2)
        {
            line.style = Style::default().fg(context.warning());
        }
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(context.foreground())),
            summary,
        );
        list_selection::draw_body_with_pointer(frame, list, &self.pages, hovered, pressed, context);
    }
    pub(crate) fn key_hints(&self) -> &'static KeyHints {
        &bindings::CONTEXT_HINTS
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
        let text = |source: &str, arguments: Vec<Text>| {
            let mut text = Text::template(source, arguments);
            text.localize(self.language);
            Line::raw(text.to_string())
        };
        let localized = |source: &str| Line::raw(crate::nls::localize_owned(self.language, source));
        let capacity = self.available_context_window.map_or_else(
            || crate::nls::localize_owned(self.language, "Not reported"),
            compact_tokens,
        );
        match self.context_usage {
            Usage::NotStarted | Usage::Pending => vec![
                localized(if self.context_usage == Usage::NotStarted {
                    "Waiting for the first request"
                } else {
                    "Waiting for context usage"
                }),
                Line::raw(self.model.clone()),
                text(
                    "Input budget: {0}",
                    vec![match self.available_context_window {
                        Some(_) => Text::template("{0} tokens", vec![Text::literal(capacity)]),
                        None => Text::from("Not reported"),
                    }],
                ),
                localized("Usage appears after a model request."),
            ],
            Usage::Measured {
                used_tokens,
                source,
            } => {
                let estimated = source == ModelContextUsageSource::Estimated;
                let prefix = if estimated { "~" } else { "" };
                let used = Text::literal(format!("{prefix}{}", compact_tokens(used_tokens)));
                let headline = if self.available_context_window.is_some() {
                    text("{0} / {1} tokens used", vec![used, Text::literal(capacity)])
                } else {
                    text("{0} tokens used", vec![used])
                };
                let mut lines = vec![headline, Line::raw(self.model.clone())];
                if let Some(capacity) = self
                    .available_context_window
                    .filter(|capacity| *capacity > 0)
                {
                    let tenths = u128::from(used_tokens) * 1_000 / u128::from(capacity);
                    let percentage = format!("{prefix}{}.{:01}%", tenths / 10, tenths % 10);
                    let suffix = format!(" {percentage}");
                    let track_width = usize::from(width).saturating_sub(suffix.len());
                    let filled = ((u128::from(used_tokens) * track_width as u128
                        / u128::from(capacity))
                    .min(track_width as u128)) as usize;
                    lines.push(Line::raw(format!(
                        "{}{}{suffix}",
                        "█".repeat(filled),
                        "░".repeat(track_width - filled)
                    )));
                    lines.push(text(
                        "Remaining input budget: {0} tokens",
                        vec![Text::literal(format!(
                            "{prefix}{}",
                            compact_tokens(capacity.saturating_sub(used_tokens))
                        ))],
                    ));
                }
                lines.push(localized(if estimated {
                    "Latest request · estimated"
                } else {
                    "Latest request · provider reported"
                }));
                lines
            }
        }
    }
}

pub(crate) fn panel(data: ViewData<'_>) -> Panel {
    let capacity = Text::template(
        "Full context window: {0}\nOutput and safety reserve: {1}\nAvailable input budget: {2}",
        vec![
            capacity_tokens(data.full_context_window),
            capacity_tokens(
                data.full_context_window
                    .zip(data.available_context_window)
                    .map(|(full, available)| full - available),
            ),
            capacity_tokens(data.available_context_window),
        ],
    );
    let model = ListSelectionModel::new(
        "Context",
        vec![ListSelectionGroup::new(
            "Context",
            vec![
                ListSelectionItem::new("Capacity details")
                    .with_id(ListSelectionItemId::new("capacity"))
                    .with_details(capacity),
            ],
        )],
    )
    .with_expandable_descriptions()
    .without_scroll_counts()
    .without_tab_bar();

    Panel {
        pages: ListSelectionState::new(model),
        model: data.model.into(),
        available_context_window: data.available_context_window,
        context_usage: data.context_usage,
        language: crate::nls::Language::English,
    }
}
fn capacity_tokens(tokens: Option<u64>) -> Text {
    match tokens {
        Some(tokens) => Text::template(
            "{0} tokens",
            vec![Text::literal(format_token_count(tokens))],
        ),
        None => Text::from("Not reported"),
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
) -> Result<Panel, ClientError>
where
    T: JsonRpcTransport,
{
    let Some(scope) = scope else {
        return initial_panel(client);
    };
    let thread = client
        .read_session_thread(SessionThreadReadParams {
            session_id: scope.session_id.clone(),
            thread_id: scope.thread_id.clone(),
            history: None,
        })?
        .thread;
    if thread.turns.is_empty() {
        return initial_panel(client);
    }
    let model = thread.turns.last().and_then(|turn| turn.model.as_ref());
    let models = client.list_models()?;
    let model_entry =
        model.and_then(|model| models.models.iter().find(|entry| &entry.model == model));
    let available = model_entry
        .and_then(|entry| entry.available_context_window)
        .map(u64::from);
    let usage = context_usage(&thread);
    let model = model
        .map(|model| format!("{}/{}", model.provider, model.model))
        .unwrap_or_else(|| "not configured".into());

    Ok(panel(ViewData {
        model: &model,
        full_context_window: model_entry
            .and_then(|entry| entry.context_window)
            .map(u64::from),
        available_context_window: available,
        context_usage: usage,
    }))
}

fn initial_panel<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
) -> Result<Panel, ClientError> {
    let config = client.read_config()?;
    let catalog = client.list_models()?;
    let entry = config.model.as_ref().and_then(|selected| {
        catalog.models.iter().find(|entry| {
            entry.model.provider.as_str() == selected.provider
                && entry.model.model.as_str() == selected.model
        })
    });
    let summary = crate::models::ModelSummary::from_catalog(
        config.model.clone(),
        config.model_reasoning_effort,
        Some(&catalog),
    );
    let label = summary.model_label();
    Ok(panel(ViewData {
        model: &label,
        full_context_window: entry.and_then(|entry| entry.context_window).map(u64::from),
        available_context_window: entry
            .and_then(|entry| entry.available_context_window)
            .map(u64::from),
        context_usage: Usage::NotStarted,
    }))
}

fn context_usage(thread: &ash_protocol::Thread) -> Usage {
    let Some(latest_turn) = thread.turns.last() else {
        return Usage::NotStarted;
    };
    match &latest_turn.context_usage {
        Some(usage) => Usage::Measured {
            used_tokens: usage.used_tokens,
            source: usage.source,
        },
        None => Usage::Pending,
    }
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
