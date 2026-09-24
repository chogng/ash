use super::editor::TextArea;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChatInputMode {
    #[default]
    Standard,
    Vim,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum VimMode {
    #[default]
    Insert,
    Normal,
    Visual,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VimOperator {
    Delete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum VimOutcome {
    Consumed,
    Unhandled,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct VimState {
    mode: VimMode,
    pending_operator: Option<VimOperator>,
    visual_anchor: Option<usize>,
    count_prefix: Option<u32>,
    yank: String,
}

impl VimState {
    pub(super) fn handle_key(&mut self, textarea: &mut TextArea, key: KeyEvent) -> VimOutcome {
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return VimOutcome::Unhandled;
        }
        match self.mode {
            VimMode::Insert => {
                if key.code == KeyCode::Esc {
                    self.enter_normal();
                    VimOutcome::Consumed
                } else {
                    VimOutcome::Unhandled
                }
            }
            VimMode::Normal => self.handle_normal(textarea, key.code),
            VimMode::Visual => self.handle_visual(textarea, key.code),
        }
    }

    pub(super) fn accepts_submission_key(&self) -> bool {
        self.mode == VimMode::Insert
    }

    pub(super) fn prompt(&self) -> &'static str {
        match self.mode {
            VimMode::Insert => "> ",
            VimMode::Normal => "N ",
            VimMode::Visual => "V ",
        }
    }

    pub(super) fn reset_draft(&mut self) {
        self.mode = VimMode::Insert;
        self.pending_operator = None;
        self.visual_anchor = None;
        self.count_prefix = None;
    }

    fn handle_normal(&mut self, textarea: &mut TextArea, code: KeyCode) -> VimOutcome {
        if let KeyCode::Char(character @ '0'..='9') = code
            && (character != '0' || self.count_prefix.is_some())
        {
            let digit = character
                .to_digit(10)
                .expect("the matched character is a digit");
            self.count_prefix = Some(
                self.count_prefix
                    .unwrap_or_default()
                    .saturating_mul(10)
                    .saturating_add(digit),
            );
            return VimOutcome::Consumed;
        }
        let count = self.count_prefix.take().unwrap_or(1);
        if self.pending_operator.take() == Some(VimOperator::Delete) {
            if code == KeyCode::Char('d') {
                for _ in 0..count {
                    self.delete_line(textarea);
                }
            }
            return VimOutcome::Consumed;
        }
        match code {
            KeyCode::Char('h') | KeyCode::Left => repeat(count, || textarea.move_left()),
            KeyCode::Char('l') | KeyCode::Right => repeat(count, || textarea.move_right()),
            KeyCode::Char('k') | KeyCode::Up => repeat(count, || textarea.move_up()),
            KeyCode::Char('j') | KeyCode::Down | KeyCode::Enter => {
                repeat(count, || textarea.move_down())
            }
            KeyCode::Char('0') | KeyCode::Home => {
                textarea.set_cursor(textarea.current_line_start())
            }
            KeyCode::Char('$') | KeyCode::End => textarea.set_cursor(textarea.current_line_end()),
            KeyCode::Char('i') => self.mode = VimMode::Insert,
            KeyCode::Char('a') => {
                textarea.move_right();
                self.mode = VimMode::Insert;
            }
            KeyCode::Char('I') => {
                textarea.set_cursor(textarea.current_line_start());
                self.mode = VimMode::Insert;
            }
            KeyCode::Char('A') => {
                textarea.set_cursor(textarea.current_line_end());
                self.mode = VimMode::Insert;
            }
            KeyCode::Char('x') | KeyCode::Delete => repeat(count, || textarea.delete()),
            KeyCode::Char('d') => self.pending_operator = Some(VimOperator::Delete),
            KeyCode::Char('v') => {
                self.visual_anchor = Some(textarea.cursor());
                self.mode = VimMode::Visual;
            }
            KeyCode::Char('p') => {
                if !self.yank.is_empty() {
                    textarea.insert_text(&self.yank);
                }
            }
            KeyCode::Esc => self.enter_normal(),
            _ => {}
        }
        VimOutcome::Consumed
    }

    fn handle_visual(&mut self, textarea: &mut TextArea, code: KeyCode) -> VimOutcome {
        match code {
            KeyCode::Char('h') | KeyCode::Left => textarea.move_left(),
            KeyCode::Char('l') | KeyCode::Right => textarea.move_right(),
            KeyCode::Char('k') | KeyCode::Up => textarea.move_up(),
            KeyCode::Char('j') | KeyCode::Down => textarea.move_down(),
            KeyCode::Char('d') | KeyCode::Char('x') | KeyCode::Delete => {
                let range = self.visual_range(textarea);
                self.yank = textarea.remove_editable_range(range);
                self.enter_normal();
            }
            KeyCode::Char('y') => {
                let range = self.visual_range(textarea);
                self.yank = textarea.text()[range].to_owned();
                self.enter_normal();
            }
            KeyCode::Esc | KeyCode::Char('v') => self.enter_normal(),
            _ => {}
        }
        VimOutcome::Consumed
    }

    fn visual_range(&self, textarea: &TextArea) -> std::ops::Range<usize> {
        let anchor = self.visual_anchor.unwrap_or(textarea.cursor());
        anchor.min(textarea.cursor())..anchor.max(textarea.cursor())
    }

    fn delete_line(&mut self, textarea: &mut TextArea) {
        let start = textarea.current_line_start();
        let mut end = textarea.current_line_end();
        if end < textarea.text().len() {
            end += 1;
        } else if start > 0 {
            return self.delete_previous_line_break(textarea, start, end);
        }
        self.yank = textarea.remove_editable_range(start..end);
    }

    fn delete_previous_line_break(&mut self, textarea: &mut TextArea, start: usize, end: usize) {
        let previous = start.saturating_sub(1);
        self.yank = textarea.remove_editable_range(previous..end);
    }

    fn enter_normal(&mut self) {
        self.mode = VimMode::Normal;
        self.pending_operator = None;
        self.visual_anchor = None;
        self.count_prefix = None;
    }
}

fn repeat(count: u32, mut operation: impl FnMut()) {
    for _ in 0..count {
        operation();
    }
}

#[cfg(test)]
#[path = "vim_tests.rs"]
mod tests;
