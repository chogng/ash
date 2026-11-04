use crate::keymap::KeyEvent;
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
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

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
    pub(crate) required: bool,
    pub(crate) choices: Vec<QueryChoice>,
    pub(crate) custom_answer: QueryCustomAnswer,
}

impl QueryQuestion {
    fn option_count(&self) -> usize {
        usize::from(!self.required)
            + self.choices.len()
            + usize::from(self.custom_answer == QueryCustomAnswer::Allowed)
    }
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
enum QueryResponseKind {
    Questions,
    Permissions(ash_protocol::PermissionRequest),
    ResultReview,
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
    response_kind: QueryResponseKind,
    review_scroll: std::cell::Cell<usize>,
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
                required: question.required,
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

    pub(crate) fn open_permissions(
        turn_id: TurnId,
        request_id: RequestId,
        request: ash_protocol::PermissionRequest,
    ) -> Result<Self, String> {
        let choices = || {
            vec![
                QueryChoice {
                    label: "Decline".into(),
                    description: String::new(),
                },
                QueryChoice {
                    label: "Allow".into(),
                    description: String::new(),
                },
            ]
        };
        let mut questions = Vec::new();
        for (directory_index, directory) in request.directories.iter().enumerate() {
            for (permission_index, permission) in directory.permissions.iter().enumerate() {
                let name = permission.to_string();
                let name = format!("{}{}", name[..1].to_ascii_uppercase(), &name[1..]);
                questions.push(QueryQuestion {
                    id: format!("directory:{directory_index}:{permission_index}"),
                    header: directory.path.clone(),
                    prompt: name,
                    required: true,
                    choices: choices(),
                    custom_answer: QueryCustomAnswer::Unavailable,
                });
            }
        }
        for (index, host) in request.network_hosts.iter().enumerate() {
            questions.push(QueryQuestion {
                id: format!("network:{index}"),
                header: host.clone(),
                prompt: "Access network".into(),
                required: true,
                choices: choices(),
                custom_answer: QueryCustomAnswer::Unavailable,
            });
        }
        let mut durations = vec![QueryChoice {
            label: "This turn".into(),
            description: String::new(),
        }];
        if request.duration == ash_protocol::PermissionGrantDuration::Session {
            durations.push(QueryChoice {
                label: "This session".into(),
                description: String::new(),
            });
        }
        questions.push(QueryQuestion {
            id: "duration".into(),
            header: "Permissions".into(),
            prompt: "Permission duration".into(),
            required: true,
            choices: durations,
            custom_answer: QueryCustomAnswer::Unavailable,
        });
        let mut query = Self::from_questions(turn_id, request_id, questions)?;
        query.response_kind = QueryResponseKind::Permissions(request);
        Ok(query)
    }

    pub(crate) fn open_result_review(
        turn_id: TurnId,
        request_id: RequestId,
        request: ash_protocol::ToolResultReviewRequest,
    ) -> Result<Self, String> {
        let preview = request
            .review
            .content
            .iter()
            .map(|part| match part {
                ash_protocol::ContentPart::Text(text) => text.clone(),
                ash_protocol::ContentPart::Artifact { artifact } => artifact.model_text(),
                media => serde_json::to_string(media).expect("captured media is serializable"),
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut query = Self::from_questions(
            turn_id,
            request_id,
            vec![QueryQuestion {
                id: "result-review".into(),
                header: "Review tool results".into(),
                prompt: format!(
                    "{}\n{}\n\n{}",
                    request.tool_name, request.review.reason, preview
                ),
                required: true,
                choices: vec![
                    QueryChoice {
                        label: "Skip results".into(),
                        description:
                            "Keep the execution record without sharing the result with the model."
                                .into(),
                    },
                    QueryChoice {
                        label: "Share results".into(),
                        description: "Share this exact result with the model.".into(),
                    },
                ],
                custom_answer: QueryCustomAnswer::Unavailable,
            }],
        )?;
        query.response_kind = QueryResponseKind::ResultReview;
        Ok(query)
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
            question.required
                && question.choices.is_empty()
                && question.custom_answer == QueryCustomAnswer::Unavailable
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
            response_kind: QueryResponseKind::Questions,
            review_scroll: std::cell::Cell::new(0),
        })
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> QueryOutcome {
        if matches!(&self.response_kind, QueryResponseKind::ResultReview)
            && !self.submitting
            && key.kind != KeyEventKind::Release
            && key.modifiers.is_empty()
        {
            match key.code {
                KeyCode::PageDown => self
                    .review_scroll
                    .set(self.review_scroll.get().saturating_add(5)),
                KeyCode::PageUp => self
                    .review_scroll
                    .set(self.review_scroll.get().saturating_sub(5)),
                _ => return self.handle_choice_key(key),
            }
            return QueryOutcome::Consumed;
        }
        self.handle_choice_key(key)
    }

    fn handle_choice_key(&mut self, key: KeyEvent) -> QueryOutcome {
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
                KeyCode::Char(character)
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
                {
                    custom_answer.push(key.text_character(character));
                    QueryOutcome::Consumed
                }
                KeyCode::Backspace if key.modifiers.is_empty() => {
                    custom_answer.pop();
                    QueryOutcome::Consumed
                }
                _ if bindings::ANSWER.matches(key)
                    && (!self.questions[self.current].required
                        || !custom_answer.trim().is_empty()) =>
                {
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
        if matches!(self.response_kind, QueryResponseKind::ResultReview) {
            let decision = if answers.iter().any(|answer| {
                answer.question_id == "result-review" && answer.value == "Share results"
            }) {
                ash_protocol::ToolResultReviewDecision::Share
            } else {
                ash_protocol::ToolResultReviewDecision::Skip
            };
            return ThreadRequestResponse {
                kind: ThreadRequestKind::Query,
                turn_id: self.turn_id.clone(),
                request_id: self.request_id.clone(),
                response: AgentResponse::ToolResultReview {
                    response: ash_protocol::ToolResultReviewResponse { decision },
                },
            };
        }
        if let QueryResponseKind::Permissions(request) = &self.response_kind {
            let allowed = |key: &str| {
                answers
                    .iter()
                    .any(|answer| answer.question_id == key && answer.value == "Allow")
            };
            let duration = if answers
                .iter()
                .any(|answer| answer.question_id == "duration" && answer.value == "This session")
            {
                ash_protocol::PermissionGrantDuration::Session
            } else {
                ash_protocol::PermissionGrantDuration::Turn
            };
            let directories = request
                .directories
                .iter()
                .enumerate()
                .filter_map(|(index, directory)| {
                    let permissions = directory
                        .permissions
                        .iter()
                        .enumerate()
                        .filter(|(permission_index, _)| {
                            allowed(&format!("directory:{index}:{permission_index}"))
                        })
                        .map(|(_, permission)| *permission)
                        .collect::<Vec<_>>();
                    (!permissions.is_empty()).then(|| ash_protocol::RequestedDirectoryGrant {
                        path: directory.path.clone(),
                        permissions,
                    })
                })
                .collect();
            let network_hosts = request
                .network_hosts
                .iter()
                .enumerate()
                .filter(|(index, _)| allowed(&format!("network:{index}")))
                .map(|(_, host)| host.clone())
                .collect();
            return ThreadRequestResponse {
                kind: ThreadRequestKind::Query,
                turn_id: self.turn_id.clone(),
                request_id: self.request_id.clone(),
                response: AgentResponse::Permissions {
                    response: ash_protocol::PermissionResponse {
                        duration,
                        directories,
                        network_hosts,
                    },
                },
            };
        }
        let answers = answers
            .into_iter()
            .filter(|answer| {
                !answer.value.is_empty()
                    || self
                        .questions
                        .iter()
                        .any(|question| question.id == answer.question_id && question.required)
            })
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
            permission_request: match &self.response_kind {
                QueryResponseKind::Permissions(request) => Some(request),
                QueryResponseKind::Questions | QueryResponseKind::ResultReview => None,
            },
            review_scroll: matches!(&self.response_kind, QueryResponseKind::ResultReview)
                .then_some(&self.review_scroll),
        }
    }

    fn activate_selected(&mut self) -> QueryOutcome {
        self.activate_at(self.selected)
    }

    fn activate_at(&mut self, index: usize) -> QueryOutcome {
        let question = &self.questions[self.current];
        if !question.required && index == 0 {
            return self.advance(String::new());
        }
        let index = index - usize::from(!question.required);
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
        self.questions[self.current].option_count()
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
    pub(crate) permission_request: Option<&'a ash_protocol::PermissionRequest>,
    review_scroll: Option<&'a std::cell::Cell<usize>>,
}

pub(crate) fn desired_height(view: QueryView<'_>) -> u16 {
    if view.review_scroll.is_some() {
        return 16;
    }
    let choice_count = view.question.option_count();
    let content_rows = 2usize
        .saturating_add(usize::from(view.permission_request.is_some()) * 2)
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
    if view.review_scroll.is_some() {
        draw_result_review(frame, area, view, hovered, pressed, context);
        return;
    }
    let choice_count = view.question.option_count().min(MAX_CHOICE_ROWS);
    let skip_count = usize::from(!view.question.required);
    let states = (0..choice_count)
        .map(|index| choice_state(index, view.selected, hovered, pressed))
        .collect::<Vec<_>>();
    let mut lines = Vec::new();
    if let Some(request) = view.permission_request {
        lines.push(Line::raw(format!(
            "{}: {}",
            context.localize("Environment"),
            request.environment_id
        )));
        lines.push(Line::raw(
            request.reason.lines().next().unwrap_or_default().to_owned(),
        ));
    }
    lines.push(Line::styled(
        if view.permission_request.is_some() {
            context.localize(&view.question.prompt).into_owned()
        } else {
            view.question.prompt.clone()
        },
        Style::default().add_modifier(Modifier::BOLD),
    ));
    if !view.question.required {
        lines.push(choice_line(
            &context.localize("Skip (optional)"),
            &context.localize("Leave this question unanswered"),
            states[0],
            context,
        ));
    }
    lines.extend(
        view.question
            .choices
            .iter()
            .enumerate()
            .take(MAX_CHOICE_ROWS - skip_count)
            .map(|(index, choice)| {
                let label = if view.permission_request.is_some() {
                    context.localize(&choice.label).into_owned()
                } else {
                    choice.label.clone()
                };
                choice_line(
                    &label,
                    &choice.description,
                    states[index + skip_count],
                    context,
                )
            }),
    );
    if view.question.custom_answer == QueryCustomAnswer::Allowed
        && view.question.choices.len() + skip_count < MAX_CHOICE_ROWS
    {
        lines.push(choice_line(
            &context.localize("Type your own answer"),
            &context.localize("Answer in the input below"),
            states[view.question.choices.len() + skip_count],
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
                    if view.permission_request.is_some() && view.question.id == "duration" {
                        context.localize(&view.question.header).into_owned()
                    } else {
                        view.question.header.clone()
                    },
                    view.current + 1,
                    view.total
                ))
                .borders(Borders::ALL)
                .style(Style::default().bg(context.background())),
        ),
        area,
    );
    for (index, state) in states.into_iter().enumerate() {
        let row = choice_row(
            area,
            index + usize::from(view.permission_request.is_some()) * 2,
        );
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
    let count = view.question.option_count().min(MAX_CHOICE_ROWS);
    (0..count).find(|index| {
        Rect::new(
            area.x.saturating_add(1),
            if view.review_scroll.is_some() {
                result_review_choice_row(area, view, *index)
            } else {
                choice_row(
                    area,
                    *index + usize::from(view.permission_request.is_some()) * 2,
                )
            },
            area.width.saturating_sub(2),
            1,
        )
        .contains(position)
    })
}

fn result_review_choice_row(area: Rect, view: QueryView<'_>, index: usize) -> u16 {
    area.bottom()
        .saturating_sub(
            1 + u16::from(view.submitting || view.error.is_some())
                + view.question.choices.len() as u16,
        )
        .saturating_add(index as u16)
}

fn draw_result_review(
    frame: &mut Frame<'_>,
    area: Rect,
    view: QueryView<'_>,
    hovered: Option<usize>,
    pressed: Option<usize>,
    context: RenderContext<'_>,
) {
    let block = Block::default()
        .title(context.localize(&view.question.header))
        .borders(Borders::ALL)
        .style(Style::default().bg(context.background()));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let first_choice = result_review_choice_row(area, view, 0).max(inner.y);
    let hint = context.localize(
        "The tool has executed. Skipping does not undo changes. Page Up/Down scrolls output.",
    );
    let hint = Paragraph::new(hint).wrap(Wrap { trim: false });
    let hint_height =
        (hint.line_count(inner.width.max(1)) as u16).min(first_choice.saturating_sub(inner.y));
    frame.render_widget(hint, Rect::new(inner.x, inner.y, inner.width, hint_height));
    let preview = Rect::new(
        inner.x,
        inner.y.saturating_add(hint_height),
        inner.width,
        first_choice.saturating_sub(inner.y.saturating_add(hint_height)),
    );
    let paragraph = Paragraph::new(view.question.prompt.clone()).wrap(Wrap { trim: false });
    let max_scroll = paragraph
        .line_count(preview.width.max(1))
        .saturating_sub(usize::from(preview.height));
    let offset = view
        .review_scroll
        .expect("result review owns a scroll offset");
    let scroll = offset.get().min(max_scroll).min(u16::MAX as usize) as u16;
    offset.set(usize::from(scroll));
    frame.render_widget(paragraph.scroll((scroll, 0)), preview);
    for (index, choice) in view.question.choices.iter().enumerate() {
        let row = result_review_choice_row(area, view, index);
        if row < inner.y || row >= inner.bottom() {
            continue;
        }
        let state = choice_state(index, view.selected, hovered, pressed);
        frame.render_widget(
            Paragraph::new(choice_line(
                &context.localize(&choice.label),
                &context.localize(&choice.description),
                state,
                context,
            )),
            Rect::new(inner.x, row, inner.width, 1),
        );
    }
    if view.submitting || view.error.is_some() {
        let status = view
            .error
            .map(std::borrow::Cow::Borrowed)
            .unwrap_or_else(|| context.localize("Submitting…"));
        frame.render_widget(
            Paragraph::new(status),
            Rect::new(inner.x, inner.bottom().saturating_sub(1), inner.width, 1),
        );
    }
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
