use crate::render::RenderContext;
use crate::render::{InteractionState, interaction_style, selection_marker};
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;
use std::cell::Cell;
use unicode_width::UnicodeWidthChar;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Field {
    Title,
    Body,
}

#[derive(Debug)]
pub(crate) struct Editor {
    title: Input,
    body: Input,
    original: (String, String),
    pub(super) field: Field,
    pub(super) message: Option<String>,
}

impl Editor {
    pub(super) fn new(title: String, body: String) -> Self {
        Self {
            original: (title.clone(), body.clone()),
            title: Input::new(title),
            body: Input::new(body),
            field: Field::Title,
            message: None,
        }
    }
    pub(super) fn values(&self) -> (&str, &str) {
        (&self.title.text, &self.body.text)
    }
    pub(super) fn dirty(&self) -> bool {
        self.values() != (self.original.0.as_str(), self.original.1.as_str())
    }
    pub(super) fn validate(&mut self) -> bool {
        if self.title.text.trim().is_empty() || self.body.text.trim().is_empty() {
            self.message = Some("Title and content are required.".into());
            false
        } else {
            self.message = None;
            true
        }
    }
    pub(super) fn paste(&mut self, value: String) {
        let value = value.replace("\r\n", "\n").replace('\r', "\n");
        let (input, limit) = match self.field {
            Field::Title => (&mut self.title, 256),
            Field::Body => (&mut self.body, 16384),
        };
        if self.field == Field::Title && value.contains('\n') {
            self.message = Some("The title takes one line.".into());
            return;
        }
        let length = if self.field == Field::Body {
            input.text.len() + value.len()
        } else {
            input.text.chars().count() + value.chars().count()
        };
        if length > limit {
            self.message = Some(
                if self.field == Field::Body {
                    "Content is limited to 16384 UTF-8 bytes."
                } else {
                    "The title is limited to 256 characters."
                }
                .into(),
            );
            return;
        }
        input.text.insert_str(input.cursor, &value);
        input.cursor += value.len();
        input.follow.set(true);
        self.message = None;
    }
    pub(super) fn handle_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab | KeyCode::BackTab => {
                self.field = match self.field {
                    Field::Title => Field::Body,
                    Field::Body => Field::Title,
                }
            }
            KeyCode::Enter if self.field == Field::Title => self.field = Field::Body,
            KeyCode::Enter => self.paste("\n".into()),
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.paste(ch.to_string())
            }
            _ => self.input_mut().handle_key(key),
        }
    }
    fn input_mut(&mut self) -> &mut Input {
        match self.field {
            Field::Title => &mut self.title,
            Field::Body => &mut self.body,
        }
    }
    pub(super) fn scroll(&mut self, lines: i16) {
        self.body.scroll(lines);
    }
    pub(super) fn areas(area: Rect) -> (Rect, Rect) {
        let title = Rect::new(
            area.x,
            area.y.saturating_add(1),
            area.width,
            area.height.saturating_sub(1).min(2),
        );
        let body = Rect::new(
            title.x,
            area.y.saturating_add(4),
            title.width,
            area.height.saturating_sub(5),
        );
        (title, body)
    }
    pub(super) fn target_at(area: Rect, position: ratatui::layout::Position) -> Option<Field> {
        let (title, body) = Self::areas(area);
        [(Field::Title, title), (Field::Body, body)]
            .into_iter()
            .find_map(|(field, input)| {
                let target = Rect::new(
                    input.x.saturating_sub(2),
                    input.y.saturating_sub(1),
                    input.width + input.x.min(2),
                    input.height + 1,
                );
                target.contains(position).then_some(field)
            })
    }
    pub(super) fn draw(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<Field>,
        pressed: Option<Field>,
        context: RenderContext<'_>,
    ) {
        let (title, body) = Self::areas(area);
        for (field, label, y) in [
            (Field::Title, "Title", area.y),
            (Field::Body, "Content", area.y.saturating_add(3)),
        ] {
            if y < area.bottom() {
                frame.render_widget(
                    Paragraph::new(format!(
                        "{}{}",
                        selection_marker(self.field == field),
                        context.localize(label)
                    ))
                    .style(interaction_style(
                        context,
                        InteractionState {
                            selected: self.field == field,
                            hovered: hovered == Some(field),
                            pressed: pressed == Some(field),
                            ..Default::default()
                        },
                    )),
                    Rect::new(area.x.saturating_sub(2), y, area.width + area.x.min(2), 1),
                );
            }
        }
        self.title
            .draw(frame, title, self.field == Field::Title, context);
        self.body
            .draw(frame, body, self.field == Field::Body, context);
        if area.height > 0
            && let Some(message) = self.message.as_deref()
        {
            frame.render_widget(
                Paragraph::new(context.localize(message))
                    .style(Style::default().fg(context.muted())),
                Rect::new(title.x, area.bottom() - 1, title.width, 1),
            );
        }
    }
}

#[derive(Debug)]
struct Input {
    text: String,
    cursor: usize,
    scroll: Cell<u16>,
    follow: Cell<bool>,
}

impl Input {
    fn new(text: String) -> Self {
        Self {
            cursor: text.len(),
            text,
            scroll: Cell::new(0),
            follow: Cell::new(true),
        }
    }
    fn handle_key(&mut self, key: KeyEvent) {
        self.follow.set(true);
        match key.code {
            KeyCode::Left => {
                self.cursor = self.text[..self.cursor]
                    .char_indices()
                    .next_back()
                    .map_or(0, |(i, _)| i)
            }
            KeyCode::Right => {
                self.cursor += self.text[self.cursor..]
                    .chars()
                    .next()
                    .map_or(0, char::len_utf8)
            }
            KeyCode::Backspace => {
                if let Some((offset, _)) = self.text[..self.cursor].char_indices().next_back() {
                    self.text.drain(offset..self.cursor);
                    self.cursor = offset;
                }
            }
            KeyCode::Delete => {
                if let Some(ch) = self.text[self.cursor..].chars().next() {
                    self.text.drain(self.cursor..self.cursor + ch.len_utf8());
                }
            }
            KeyCode::Home => {
                self.cursor = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1)
            }
            KeyCode::End => {
                self.cursor += self.text[self.cursor..]
                    .find('\n')
                    .unwrap_or(self.text.len() - self.cursor)
            }
            KeyCode::Up | KeyCode::Down => {
                let start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
                let column = self.text[start..self.cursor].chars().count();
                let next = if key.code == KeyCode::Up {
                    (start > 0).then(|| self.text[..start - 1].rfind('\n').map_or(0, |i| i + 1))
                } else {
                    self.text[self.cursor..]
                        .find('\n')
                        .map(|i| self.cursor + i + 1)
                };
                if let Some(next) = next {
                    let line = self.text[next..].split('\n').next().unwrap_or("");
                    self.cursor = next
                        + line
                            .char_indices()
                            .nth(column)
                            .map_or(line.len(), |(i, _)| i);
                }
            }
            _ => {}
        }
    }
    fn scroll(&self, lines: i16) {
        self.follow.set(false);
        self.scroll
            .set(self.scroll.get().saturating_add_signed(lines));
    }
    fn draw(&self, frame: &mut Frame<'_>, area: Rect, focused: bool, context: RenderContext<'_>) {
        if area.is_empty() {
            return;
        }
        let (lines, row, column) = wrapped(&self.text, self.cursor, area.width);
        let mut scroll = self
            .scroll
            .get()
            .min((lines.len() as u16).saturating_sub(area.height));
        if focused && self.follow.get() {
            if row < scroll {
                scroll = row;
            }
            if row >= scroll + area.height {
                scroll = row + 1 - area.height;
            }
        }
        self.scroll.set(scroll);
        let text = lines
            .into_iter()
            .map(ratatui::text::Line::from)
            .collect::<Vec<_>>();
        frame.render_widget(
            Paragraph::new(text)
                .style(Style::default().fg(context.foreground()))
                .scroll((scroll, 0)),
            area,
        );
        if focused && row >= scroll && row < scroll + area.height {
            frame.set_cursor_position((area.x + column, area.y + row - scroll));
        }
    }
}

fn wrapped(text: &str, cursor: usize, width: u16) -> (Vec<String>, u16, u16) {
    let mut lines = vec![String::new()];
    let mut column = 0;
    let mut position = (0, 0);
    for (index, ch) in text.char_indices() {
        let cells = ch.width().unwrap_or(0) as u16;
        if ch != '\n' && column + cells > width {
            lines.push(String::new());
            column = 0;
        }
        if index == cursor {
            position = (lines.len() as u16 - 1, column.min(width.saturating_sub(1)));
        }
        if ch == '\n' {
            lines.push(String::new());
            column = 0;
        } else {
            lines.last_mut().unwrap().push(ch);
            column += cells;
        }
    }
    if cursor == text.len() {
        if column >= width {
            lines.push(String::new());
            column = 0;
        }
        position = (lines.len() as u16 - 1, column);
    }
    (lines, position.0, position.1)
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
