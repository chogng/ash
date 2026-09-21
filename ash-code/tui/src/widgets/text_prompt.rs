use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::widgets::search_box;
use crate::widgets::search_box::SearchBoxInputOutcome;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::search_box::SearchBoxState;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Constraint;
use ratatui::layout::Direction;
use ratatui::layout::Layout;
use ratatui::layout::Rect;
use ratatui::widgets::Paragraph;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TextPromptSpec {
    pub(crate) title: String,
    pub(crate) explanation: String,
    pub(crate) placeholder: String,
    pub(crate) masked: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TextPromptOutcome {
    Consumed,
    Dismiss,
    Submit(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TextPrompt {
    spec: TextPromptSpec,
    input: SearchBoxState,
}

impl TextPrompt {
    pub(crate) fn new(spec: TextPromptSpec) -> Self {
        let mut input = SearchBoxModel::new(&spec.placeholder).initially_active();
        if spec.masked {
            input = input.masked();
        }
        Self {
            spec,
            input: SearchBoxState::new(input),
        }
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> TextPromptOutcome {
        if key.kind != KeyEventKind::Press {
            return TextPromptOutcome::Consumed;
        }
        if bindings::CANCEL.matches(key) {
            return TextPromptOutcome::Dismiss;
        }
        if bindings::SAVE.matches(key) {
            let value = self.input.query().trim();
            return if value.is_empty() {
                TextPromptOutcome::Consumed
            } else {
                TextPromptOutcome::Submit(value.into())
            };
        }
        match self.input.handle_key(key) {
            SearchBoxInputOutcome::QueryChanged => TextPromptOutcome::Consumed,
            SearchBoxInputOutcome::Ignored => TextPromptOutcome::Consumed,
        }
    }

    pub(crate) fn handle_paste(&mut self, value: String) {
        self.input.handle_paste(value);
    }

    pub(crate) fn title(&self) -> &str {
        &self.spec.title
    }

    pub(crate) fn explanation(&self) -> &str {
        &self.spec.explanation
    }

    pub(crate) fn input(&self) -> &SearchBoxState {
        &self.input
    }

    pub(crate) fn desired_height(&self) -> u16 {
        4
    }
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    prompt: &TextPrompt,
    context: RenderContext<'_>,
) {
    let content = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Length(3)])
        .split(area);
    frame.render_widget(
        Paragraph::new(context.localize(prompt.explanation())),
        content[0],
    );
    search_box::draw(frame, content[1], prompt.input(), false, false, context);
}

#[cfg(test)]
#[path = "text_prompt_tests.rs"]
mod tests;
