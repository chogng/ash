use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Field {
    Title,
    Body,
    Query,
    Reference,
}

#[derive(Debug)]
pub(crate) struct Editor {
    pub(super) field: Field,
    text: String,
    cursor: usize,
    pub(super) message: Option<String>,
}

impl Editor {
    pub(super) fn new(field: Field, text: String) -> Self {
        let cursor = text.len();
        Self {
            field,
            text,
            cursor,
            message: None,
        }
    }
    pub(crate) fn title(&self) -> &'static str {
        match self.field {
            Field::Title => "Memory title",
            Field::Body => "Memory content",
            Field::Query => "Search memories",
            Field::Reference => "Open memory reference",
        }
    }
    pub(super) fn text(&self) -> &str {
        &self.text
    }
    pub(super) fn paste(&mut self, value: String) {
        let value = value.replace("\r\n", "\n").replace('\r', "\n");
        if self.field != Field::Body && value.contains('\n') {
            self.message = Some("This field takes one line.".into());
            return;
        }
        let limit = match self.field {
            Field::Title => 256,
            Field::Query => 512,
            Field::Reference => 4096,
            Field::Body => 16384,
        };
        let length = if self.field == Field::Body {
            self.text.len() + value.len()
        } else {
            self.text.chars().count() + value.chars().count()
        };
        if length > limit {
            self.message = Some(format!(
                "This field is limited to {limit} {}.",
                if self.field == Field::Body {
                    "UTF-8 bytes"
                } else {
                    "characters"
                }
            ));
            return;
        }
        self.message = None;
        self.text.insert_str(self.cursor, &value);
        self.cursor += value.len();
    }
    pub(super) fn handle_key(&mut self, key: KeyEvent) {
        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('a') {
            self.text.clear();
            self.cursor = 0;
            return;
        }
        match key.code {
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.paste(ch.to_string())
            }
            KeyCode::Enter if self.field == Field::Body => self.paste("\n".into()),
            KeyCode::Left => {
                if let Some((offset, _)) = self.text[..self.cursor].char_indices().next_back() {
                    self.cursor = offset;
                }
            }
            KeyCode::Right => {
                if let Some(ch) = self.text[self.cursor..].chars().next() {
                    self.cursor += ch.len_utf8();
                }
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
                self.cursor = self.text[..self.cursor]
                    .rfind('\n')
                    .map_or(0, |index| index + 1)
            }
            KeyCode::End => {
                self.cursor += self.text[self.cursor..]
                    .find('\n')
                    .unwrap_or(self.text.len() - self.cursor)
            }
            KeyCode::Up | KeyCode::Down => {
                let start = self.text[..self.cursor]
                    .rfind('\n')
                    .map_or(0, |index| index + 1);
                let column = self.text[start..self.cursor].chars().count();
                let next = if key.code == KeyCode::Up {
                    if start == 0 {
                        None
                    } else {
                        Some(
                            self.text[..start - 1]
                                .rfind('\n')
                                .map_or(0, |index| index + 1),
                        )
                    }
                } else {
                    self.text[self.cursor..]
                        .find('\n')
                        .map(|index| self.cursor + index + 1)
                };
                if let Some(next) = next {
                    let line = self.text[next..].split('\n').next().unwrap_or("");
                    self.cursor = next
                        + line
                            .char_indices()
                            .nth(column)
                            .map_or(line.len(), |(offset, _)| offset);
                }
            }
            _ => {}
        }
    }
    pub(crate) fn draw(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        context: crate::render::RenderContext<'_>,
    ) {
        let body = Rect {
            y: area.y.saturating_add(1),
            height: area.height.saturating_sub(1),
            ..area
        };
        frame.render_widget(
            Paragraph::new(
                context.localize(
                    self.message
                        .as_deref()
                        .unwrap_or("Ctrl+S save · Ctrl+A clear · Esc cancel"),
                ),
            )
            .style(Style::default().fg(context.muted())),
            area,
        );
        if body.width == 0 || body.height == 0 {
            return;
        }
        let width = usize::from(body.width);
        let before = &self.text[..self.cursor];
        let row = before
            .split('\n')
            .map(|line| line.width() / width + 1)
            .sum::<usize>()
            .saturating_sub(1);
        let column = before.rsplit('\n').next().unwrap_or("").width() % width;
        let scroll = row.saturating_sub(usize::from(body.height - 1));
        frame.render_widget(
            Paragraph::new(self.text.as_str())
                .style(Style::default().fg(context.foreground()))
                .wrap(Wrap { trim: false })
                .scroll((scroll as u16, 0)),
            body,
        );
        frame.set_cursor_position((
            body.x + column as u16,
            body.y + row.saturating_sub(scroll) as u16,
        ));
    }
}
