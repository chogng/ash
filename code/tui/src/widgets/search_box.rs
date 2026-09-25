use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use std::fmt;

pub(crate) const SEARCH_BOX_HEIGHT: u16 = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SearchBoxModel {
    placeholder: String,
    initial_query: String,
    initially_active: bool,
    masked: bool,
}

impl SearchBoxModel {
    pub(crate) fn new(placeholder: impl Into<String>) -> Self {
        Self {
            placeholder: placeholder.into(),
            initial_query: String::new(),
            initially_active: false,
            masked: false,
        }
    }

    pub(crate) fn initially_active(mut self) -> Self {
        self.initially_active = true;
        self
    }

    pub(crate) fn with_initial_query(mut self, query: impl Into<String>) -> Self {
        self.initial_query = query.into();
        self
    }

    pub(crate) fn masked(mut self) -> Self {
        self.masked = true;
        self
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.placeholder = crate::nls::localize_owned(language, &self.placeholder);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SearchBoxInputOutcome {
    Ignored,
    QueryChanged,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SearchBoxState {
    model: SearchBoxModel,
    query: String,
    cursor: usize,
    input_active: bool,
}

impl SearchBoxState {
    pub(crate) fn new(model: SearchBoxModel) -> Self {
        let cursor = model.initial_query.len();
        let query = model.initial_query.clone();
        Self {
            input_active: model.initially_active,
            model,
            query,
            cursor,
        }
    }

    pub(crate) fn replace_model(&mut self, model: SearchBoxModel) {
        self.model = model;
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.model.localize(language);
    }

    pub(crate) fn placeholder(&self) -> &str {
        &self.model.placeholder
    }

    pub(crate) fn query(&self) -> &str {
        &self.query
    }

    pub(crate) fn set_query(&mut self, query: String) {
        use zeroize::Zeroize;
        self.query.zeroize();
        self.cursor = query.len();
        self.query = query;
    }

    pub(crate) fn input_active(&self) -> bool {
        self.input_active
    }

    pub(crate) fn set_input_active(&mut self, input_active: bool) {
        self.input_active = input_active;
    }

    pub(crate) fn masked(&self) -> bool {
        self.model.masked
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> SearchBoxInputOutcome {
        if !self.input_active
            || key.kind == KeyEventKind::Release
            || key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return SearchBoxInputOutcome::Ignored;
        }

        match key.code {
            KeyCode::Backspace => {
                if let Some((previous, _)) = self.query[..self.cursor].char_indices().next_back() {
                    self.query.drain(previous..self.cursor);
                    self.cursor = previous;
                }
                SearchBoxInputOutcome::QueryChanged
            }
            KeyCode::Left => {
                self.cursor = self.query[..self.cursor]
                    .char_indices()
                    .next_back()
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                SearchBoxInputOutcome::Ignored
            }
            KeyCode::Right => {
                if let Some(character) = self.query[self.cursor..].chars().next() {
                    self.cursor += character.len_utf8();
                }
                SearchBoxInputOutcome::Ignored
            }
            KeyCode::Char(character) if !character.is_ascii_control() => {
                self.query.insert(self.cursor, character);
                self.cursor += character.len_utf8();
                SearchBoxInputOutcome::QueryChanged
            }
            _ => SearchBoxInputOutcome::Ignored,
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) -> SearchBoxInputOutcome {
        if !self.input_active {
            return SearchBoxInputOutcome::Ignored;
        }
        let normalized = pasted.split_whitespace().collect::<Vec<_>>().join(" ");
        self.query.insert_str(self.cursor, &normalized);
        self.cursor += normalized.len();
        SearchBoxInputOutcome::QueryChanged
    }
}

impl fmt::Debug for SearchBoxState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SearchBoxState")
            .field("model", &self.model)
            .field(
                "query",
                &if self.masked() {
                    "[REDACTED]"
                } else {
                    self.query.as_str()
                },
            )
            .field("input_active", &self.input_active)
            .finish()
    }
}

impl Drop for SearchBoxState {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.query.zeroize();
    }
}

use crate::render::RenderContext;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::BorderType;
use ratatui::widgets::Borders;
use ratatui::widgets::Padding;
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthStr;

const SEARCH_BOX_LEFT_PADDING: u16 = 1;

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    search: &SearchBoxState,
    hovered: bool,
    pressed: bool,
    context: RenderContext<'_>,
) {
    let rendered_query = search
        .masked()
        .then(|| "•".repeat(search.query().chars().count()));
    let text_style = Style::default().fg(if hovered || pressed {
        context.foreground()
    } else {
        context.muted()
    });
    let text = if search.query().is_empty() {
        Span::styled(context.localize(search.placeholder()), text_style)
    } else {
        Span::styled(
            rendered_query.as_deref().unwrap_or(search.query()),
            text_style,
        )
    };
    let border_style = if pressed {
        Style::default().fg(context.pressed_foreground())
    } else if search.input_active() {
        Style::default().fg(context.focus())
    } else if hovered {
        Style::default().fg(context.foreground())
    } else {
        Style::default().fg(context.muted())
    };
    frame.render_widget(
        Paragraph::new(Line::from(text)).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(border_style)
                .padding(Padding::left(SEARCH_BOX_LEFT_PADDING)),
        ),
        area,
    );
    if search.input_active() && area.width > 2 && area.height > 2 {
        let prefix = &search.query()[..search.cursor];
        let cursor_width = if search.masked() {
            prefix.chars().count()
        } else {
            prefix.width()
        }
        .min(usize::from(
            area.width
                .saturating_sub(2)
                .saturating_sub(SEARCH_BOX_LEFT_PADDING)
                .saturating_sub(1),
        )) as u16;
        frame.set_cursor_position((
            area.x + 1 + SEARCH_BOX_LEFT_PADDING + cursor_width,
            area.y + 1,
        ));
    }
}

#[cfg(test)]
#[path = "search_box_state_tests.rs"]
mod state_tests;

#[cfg(test)]
#[path = "search_box_view_tests.rs"]
mod view_tests;
