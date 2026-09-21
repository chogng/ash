use crate::keymap::bindings;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::selection_marker;
use crate::thread::ThreadRequestKind;
use crate::thread::ThreadRequestResponse;
use crate::widgets::navigation::Navigation;
use ash_protocol::AgentResponse;
use ash_protocol::RequestId;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::TurnId;
use ash_protocol::UserInputAnswer;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;

const MAX_CHOICE_ROWS: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QueryChoice {
    pub(crate) label: String,
    pub(crate) description: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QueryCustomAnswer {
    Allowed,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QueryQuestion {
    pub(crate) id: String,
    pub(crate) header: String,
    pub(crate) prompt: String,
    pub(crate) choices: Vec<QueryChoice>,
    pub(crate) custom_answer: QueryCustomAnswer,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QueryAnswer {
    pub(crate) question_id: String,
    pub(crate) value: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum QueryOutcome {
    Completed(Vec<QueryAnswer>),
    Consumed,
    Unhandled,
}

#[derive(Debug)]
pub(crate) struct Query {
    turn_id: TurnId,
    request_id: RequestId,
    questions: Vec<QueryQuestion>,
    current: usize,
    selected: usize,
    answers: Vec<QueryAnswer>,
    submitting: bool,
    error: Option<String>,
    custom_answer: Option<String>,
}

impl Query {
    pub(crate) fn open(
        turn_id: TurnId,
        request_id: RequestId,
        request: RequestUserInput,
    ) -> Result<Self, String> {
        let questions = request
            .questions
            .into_iter()
            .map(|question| QueryQuestion {
                id: question.id,
                header: question.header,
                prompt: question.question,
                choices: question
                    .options
                    .into_iter()
                    .map(|option| QueryChoice {
                        label: option.label,
                        description: option.description,
                    })
                    .collect(),
                custom_answer: if question.allow_free_form {
                    QueryCustomAnswer::Allowed
                } else {
                    QueryCustomAnswer::Unavailable
                },
            })
            .collect();
        Self::from_questions(turn_id, request_id, questions)
    }

    #[cfg(test)]
    pub(crate) fn new(questions: Vec<QueryQuestion>) -> Result<Self, String> {
        Self::from_questions(
            TurnId::new("test-turn").expect("the test Turn ID is valid"),
            RequestId::new("test-request").expect("the test request ID is valid"),
            questions,
        )
    }

    fn from_questions(
        turn_id: TurnId,
        request_id: RequestId,
        questions: Vec<QueryQuestion>,
    ) -> Result<Self, String> {
        if questions.is_empty() {
            return Err("a query requires at least one question".into());
        }
        if questions.iter().any(|question| {
            question.choices.is_empty() && question.custom_answer == QueryCustomAnswer::Unavailable
        }) {
            return Err("every query question requires a choice or a custom answer".into());
        }
        Ok(Self {
            turn_id,
            request_id,
            questions,
            current: 0,
            selected: 0,
            answers: Vec::new(),
            submitting: false,
            error: None,
            custom_answer: None,
        })
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> QueryOutcome {
        if !self.submitting
            && self.custom_answer.is_none()
            && let Some(navigation) = Navigation::from_key(key)
        {
            self.selected = navigation.offset(
                self.selected,
                self.option_count().saturating_sub(1),
                self.option_count(),
            );
            return QueryOutcome::Consumed;
        }
        if key.kind != KeyEventKind::Press || self.submitting {
            return QueryOutcome::Consumed;
        }
        if let Some(custom_answer) = self.custom_answer.as_mut() {
            return match key.code {
                KeyCode::Char(character) if key.modifiers.is_empty() => {
                    custom_answer.push(character);
                    QueryOutcome::Consumed
                }
                KeyCode::Backspace if key.modifiers.is_empty() => {
                    custom_answer.pop();
                    QueryOutcome::Consumed
                }
                _ if bindings::ANSWER.matches(key) && !custom_answer.trim().is_empty() => {
                    let value = self
                        .custom_answer
                        .take()
                        .expect("the custom answer editor is active");
                    let outcome = self.advance(value.clone());
                    if self.submitting {
                        self.custom_answer = Some(value);
                    }
                    outcome
                }
                _ if bindings::CANCEL_ANSWER.matches(key) => {
                    self.custom_answer = None;
                    QueryOutcome::Consumed
                }
                _ => QueryOutcome::Consumed,
            };
        }
        match key.code {
            _ if bindings::ANSWER.matches(key) => self.activate_selected(),
            KeyCode::Esc => QueryOutcome::Consumed,
            _ => QueryOutcome::Unhandled,
        }
    }

    pub(crate) fn activate(&mut self, index: usize) -> QueryOutcome {
        if index >= self.option_count() || self.submitting || self.custom_answer.is_some() {
            return QueryOutcome::Consumed;
        }
        self.selected = index;
        self.activate_selected()
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        let Some(custom_answer) = self.custom_answer.as_mut() else {
            return;
        };
        for character in pasted.chars() {
            match character {
                '\r' => {}
                '\n' => custom_answer.push(' '),
                character => custom_answer.push(character),
            }
        }
    }

    pub(crate) fn matches_request(&self, turn_id: &TurnId, request_id: &RequestId) -> bool {
        &self.turn_id == turn_id && &self.request_id == request_id
    }

    pub(crate) fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    pub(crate) fn response(&self, answers: Vec<QueryAnswer>) -> ThreadRequestResponse {
        let answers = answers
            .into_iter()
            .map(|answer| {
                (
                    answer.question_id,
                    UserInputAnswer {
                        value: answer.value,
                    },
                )
            })
            .collect();
        ThreadRequestResponse {
            kind: ThreadRequestKind::Query,
            turn_id: self.turn_id.clone(),
            request_id: self.request_id.clone(),
            response: AgentResponse::UserInput {
                response: RequestUserInputResponse { answers },
            },
        }
    }

    pub(crate) fn submission_failed(&mut self, error: String) {
        if self.submitting {
            self.answers.pop();
        }
        self.submitting = false;
        self.error = Some(error);
    }

    pub(crate) fn view(&self) -> QueryView<'_> {
        QueryView {
            question: &self.questions[self.current],
            current: self.current,
            total: self.questions.len(),
            selected: self.selected,
            submitting: self.submitting,
            error: self.error.as_deref(),
            custom_answer: self.custom_answer.as_deref(),
        }
    }

    fn activate_selected(&mut self) -> QueryOutcome {
        self.activate_at(self.selected)
    }

    fn activate_at(&mut self, index: usize) -> QueryOutcome {
        let question = &self.questions[self.current];
        if index < question.choices.len() {
            let value = question.choices[index].label.clone();
            return self.advance(value);
        }
        self.custom_answer = Some(String::new());
        QueryOutcome::Consumed
    }

    fn advance(&mut self, value: String) -> QueryOutcome {
        let question_id = self.questions[self.current].id.clone();
        self.answers.push(QueryAnswer { question_id, value });
        self.error = None;
        if self.current + 1 == self.questions.len() {
            self.submitting = true;
            QueryOutcome::Completed(self.answers.clone())
        } else {
            self.current += 1;
            self.selected = 0;
            QueryOutcome::Consumed
        }
    }

    fn option_count(&self) -> usize {
        let question = &self.questions[self.current];
        question.choices.len() + usize::from(question.custom_answer == QueryCustomAnswer::Allowed)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct QueryView<'a> {
    pub(crate) question: &'a QueryQuestion,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) selected: usize,
    pub(crate) submitting: bool,
    pub(crate) error: Option<&'a str>,
    pub(crate) custom_answer: Option<&'a str>,
}

pub(crate) fn desired_height(view: QueryView<'_>) -> u16 {
    let choice_count = view.question.choices.len()
        + usize::from(view.question.custom_answer == QueryCustomAnswer::Allowed);
    let content_rows = 2usize
        .saturating_add(choice_count.min(MAX_CHOICE_ROWS))
        .saturating_add(usize::from(view.custom_answer.is_some()))
        .saturating_add(usize::from(view.submitting || view.error.is_some()));
    u16::try_from(content_rows.saturating_add(2)).unwrap_or(u16::MAX)
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    view: QueryView<'_>,
    hovered: Option<usize>,
    pressed: Option<usize>,
    context: RenderContext<'_>,
) {
    let choice_count = view.question.choices.len()
        + usize::from(
            view.question.custom_answer == QueryCustomAnswer::Allowed
                && view.question.choices.len() < MAX_CHOICE_ROWS,
        );
    let states = (0..choice_count)
        .map(|index| choice_state(index, view.selected, hovered, pressed))
        .collect::<Vec<_>>();
    let mut lines = vec![Line::styled(
        &view.question.prompt,
        Style::default().add_modifier(Modifier::BOLD),
    )];
    lines.extend(
        view.question
            .choices
            .iter()
            .enumerate()
            .take(MAX_CHOICE_ROWS)
            .map(|(index, choice)| {
                choice_line(&choice.label, &choice.description, states[index], context)
            }),
    );
    if view.question.custom_answer == QueryCustomAnswer::Allowed
        && view.question.choices.len() < MAX_CHOICE_ROWS
    {
        lines.push(choice_line(
            &context.localize("Type your own answer"),
            &context.localize("Answer in the input below"),
            states[view.question.choices.len()],
            context,
        ));
    }
    if let Some(custom_answer) = view.custom_answer {
        lines.push(Line::from(vec![
            Span::styled("> ", Style::default().fg(context.focus())),
            Span::raw(custom_answer),
        ]));
    }
    if view.submitting {
        lines.push(Line::styled(
            context.localize("Submitting…"),
            Style::default().fg(context.muted()),
        ));
    } else if let Some(error) = view.error {
        lines.push(Line::styled(error, Style::default().fg(context.danger())));
    }
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .title(format!(
                    "{}  ({}/{})",
                    view.question.header,
                    view.current + 1,
                    view.total
                ))
                .borders(Borders::ALL)
                .style(Style::default().bg(context.background())),
        ),
        area,
    );
    for (index, state) in states.into_iter().enumerate() {
        let row = choice_row(area, index);
        if row < area.bottom().saturating_sub(1) {
            frame.buffer_mut().set_style(
                Rect::new(
                    area.x.saturating_add(1),
                    row,
                    area.width.saturating_sub(2),
                    1,
                ),
                interaction_style(context, state),
            );
        }
    }
}

pub(crate) fn choice_at(
    area: Rect,
    view: QueryView<'_>,
    position: ratatui::layout::Position,
) -> Option<usize> {
    if view.submitting || view.custom_answer.is_some() {
        return None;
    }
    let count = view.question.choices.len().min(MAX_CHOICE_ROWS)
        + usize::from(
            view.question.custom_answer == QueryCustomAnswer::Allowed
                && view.question.choices.len() < MAX_CHOICE_ROWS,
        );
    (0..count).find(|index| {
        Rect::new(
            area.x.saturating_add(1),
            choice_row(area, *index),
            area.width.saturating_sub(2),
            1,
        )
        .contains(position)
    })
}

fn choice_row(area: Rect, index: usize) -> u16 {
    area.y.saturating_add(2).saturating_add(index as u16)
}

fn choice_line(
    label: &str,
    description: &str,
    state: InteractionState,
    context: RenderContext<'_>,
) -> Line<'static> {
    let marker = selection_marker(state.selected);
    let style = interaction_style(context, state);
    Line::from(vec![
        Span::styled(marker, style),
        Span::styled(label.to_owned(), style),
        Span::styled(
            format!("  {description}"),
            if !state.selected && !state.hovered && !state.pressed {
                Style::default().fg(context.muted())
            } else {
                style
            },
        ),
    ])
}

fn choice_state(
    index: usize,
    selected: usize,
    hovered: Option<usize>,
    pressed: Option<usize>,
) -> InteractionState {
    InteractionState {
        target: InteractionTarget::Rest,
        selected: index == selected,
        hovered: hovered == Some(index),
        pressed: pressed == Some(index),
    }
}

#[cfg(test)]
#[path = "query_tests.rs"]
mod tests;
