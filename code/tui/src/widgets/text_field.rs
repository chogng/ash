use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::search_box;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::search_box::SearchBoxState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use std::fmt;
use std::sync::LazyLock;
use zeroize::Zeroizing;

static SELECT_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| KeyHints::new().with_binding(bindings::EDIT_FIELD));
static EDIT_HINTS: LazyLock<KeyHints> = LazyLock::new(|| {
    KeyHints::new()
        .with_binding(bindings::SAVE)
        .with_binding(bindings::CANCEL)
});

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Selected,
    Editing,
    Saving,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TextFieldOutcome {
    Consumed,
    Unhandled,
    Submit,
}

/// Owns text-field editing and cancellation; callers accept submitted text
/// and own validation and persistence of the form. Focus never advances here.
#[derive(Clone)]
pub(crate) struct TextField {
    input: SearchBoxState,
    confirmed: Zeroizing<String>,
    mode: Mode,
    hints: [KeyHints; 3],
}

impl TextField {
    pub(crate) fn new(value: &str, model: SearchBoxModel) -> Self {
        let mut input = SearchBoxState::new(model);
        input.set_query(value.into());
        input.set_input_active(false);
        Self {
            input,
            confirmed: Zeroizing::new(value.into()),
            mode: Mode::Selected,
            hints: [
                SELECT_HINTS.clone(),
                EDIT_HINTS.clone(),
                KeyHints::new().with_note("Saving…"),
            ],
        }
    }

    pub(crate) fn query(&self) -> &str {
        self.input.query()
    }

    pub(crate) fn is_editing(&self) -> bool {
        self.mode == Mode::Editing
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        match self.mode {
            Mode::Selected => &self.hints[0],
            Mode::Editing => &self.hints[1],
            Mode::Saving => &self.hints[2],
        }
    }

    pub(crate) fn blur(&mut self) {
        if self.mode == Mode::Editing {
            self.set_mode(Mode::Selected);
        }
    }

    pub(crate) fn accept(&mut self, value: String) {
        self.confirmed = Zeroizing::new(value.clone());
        self.input.set_query(value);
        self.set_mode(Mode::Selected);
    }

    fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
        self.input.set_input_active(mode == Mode::Editing);
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> TextFieldOutcome {
        if key.kind != KeyEventKind::Press || self.mode == Mode::Saving {
            return TextFieldOutcome::Consumed;
        }
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return TextFieldOutcome::Unhandled;
        }
        match (self.mode, key.code) {
            (Mode::Selected, KeyCode::Enter) => self.set_mode(Mode::Editing),
            (Mode::Editing, KeyCode::Enter) => {
                self.set_mode(Mode::Saving);
                return TextFieldOutcome::Submit;
            }
            (Mode::Editing, KeyCode::Esc) => {
                self.input.set_query(self.confirmed.to_string());
                self.set_mode(Mode::Selected);
            }
            (_, KeyCode::Tab | KeyCode::BackTab) | (Mode::Selected, _) => {
                return TextFieldOutcome::Unhandled;
            }
            (Mode::Editing, _) => {
                self.input.handle_key(key);
            }
            (Mode::Saving, _) => unreachable!("saving input is consumed above"),
        }
        TextFieldOutcome::Consumed
    }

    pub(crate) fn handle_paste(&mut self, value: String) {
        self.input.handle_paste(value);
    }
}

impl fmt::Debug for TextField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextField")
            .field("input", &self.input)
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    field: &TextField,
    focused: bool,
    context: RenderContext<'_>,
) {
    let mut input = field.input.clone();
    input.set_input_active(focused && field.is_editing());
    search_box::draw(frame, area, &input, focused, false, context);
}

#[cfg(test)]
#[path = "text_field_tests.rs"]
mod tests;
