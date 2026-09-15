use crate::keymap::bindings;
use crate::thread::ThreadRequestKind;
use crate::thread::ThreadRequestResponse;
use crate::widgets::navigation::Navigation;
use ash_protocol::ActionApprovalCapability;
use ash_protocol::ActionApprovalCapabilityKind;
use ash_protocol::ActionApprovalDecision;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::ActionApprovalResponse;
use ash_protocol::AgentResponse;
use ash_protocol::RequestId;
use ash_protocol::TurnId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalDecision {
    ApproveOnce,
    Decline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ApprovalSpec {
    pub(crate) title: String,
    pub(crate) reason: String,
    pub(crate) details: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalOutcome {
    Consumed,
    Respond(ApprovalDecision),
    Unhandled,
}

#[derive(Debug)]
pub(crate) struct Approval {
    turn_id: TurnId,
    request_id: RequestId,
    spec: ApprovalSpec,
    selected: ApprovalDecision,
    submitting: bool,
    error: Option<String>,
}

impl Approval {
    pub(crate) fn open(
        turn_id: TurnId,
        request_id: RequestId,
        request: ActionApprovalRequest,
    ) -> Self {
        Self {
            turn_id,
            request_id,
            spec: ApprovalSpec {
                title: "Approval required".into(),
                reason: request.reason,
                details: request.capabilities.iter().map(capability_detail).collect(),
            },
            selected: ApprovalDecision::ApproveOnce,
            submitting: false,
            error: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn new(spec: ApprovalSpec) -> Self {
        Self {
            turn_id: TurnId::new("test-turn").expect("the test Turn ID is valid"),
            request_id: RequestId::new("test-request").expect("the test request ID is valid"),
            spec,
            selected: ApprovalDecision::ApproveOnce,
            submitting: false,
            error: None,
        }
    }

    pub(crate) fn matches_request(&self, turn_id: &TurnId, request_id: &RequestId) -> bool {
        &self.turn_id == turn_id && &self.request_id == request_id
    }

    pub(crate) fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    pub(crate) fn response(&self, decision: ApprovalDecision) -> ThreadRequestResponse {
        let decision = match decision {
            ApprovalDecision::ApproveOnce => ActionApprovalDecision::ApproveOnce,
            ApprovalDecision::Decline => ActionApprovalDecision::Decline,
        };
        ThreadRequestResponse {
            kind: ThreadRequestKind::Approval,
            turn_id: self.turn_id.clone(),
            request_id: self.request_id.clone(),
            response: AgentResponse::Approval {
                response: ActionApprovalResponse { decision },
            },
        }
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ApprovalOutcome {
        if self.submitting {
            return ApprovalOutcome::Consumed;
        }
        if let Some(navigation) = Navigation::from_key(key) {
            let index = usize::from(self.selected == ApprovalDecision::Decline);
            self.selected = if navigation.offset(index, 1, 2) == 0 {
                ApprovalDecision::ApproveOnce
            } else {
                ApprovalDecision::Decline
            };
            return ApprovalOutcome::Consumed;
        }
        if key.kind != KeyEventKind::Press {
            return ApprovalOutcome::Consumed;
        }
        match key.code {
            _ if bindings::APPROVE.matches(key) => {
                self.submitting = true;
                self.error = None;
                ApprovalOutcome::Respond(self.selected)
            }
            KeyCode::Esc => ApprovalOutcome::Consumed,
            _ => ApprovalOutcome::Unhandled,
        }
    }

    pub(crate) fn activate(&mut self, index: usize) -> ApprovalOutcome {
        self.selected = match index {
            0 => ApprovalDecision::ApproveOnce,
            1 => ApprovalDecision::Decline,
            _ => return ApprovalOutcome::Consumed,
        };
        self.handle_key(KeyEvent::new(
            KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        ))
    }

    pub(crate) fn submission_failed(&mut self, error: String) {
        self.submitting = false;
        self.error = Some(error);
    }

    pub(crate) fn view(&self) -> ApprovalView<'_> {
        ApprovalView {
            title: &self.spec.title,
            reason: &self.spec.reason,
            details: &self.spec.details,
            selected: self.selected,
            submitting: self.submitting,
            error: self.error.as_deref(),
        }
    }
}

fn capability_detail(capability: &ActionApprovalCapability) -> String {
    format!(
        "{}  ·  {}",
        capability_kind(capability.kind),
        capability.scope
    )
}

fn capability_kind(kind: ActionApprovalCapabilityKind) -> &'static str {
    match kind {
        ActionApprovalCapabilityKind::FileRead => "File read",
        ActionApprovalCapabilityKind::FileWrite => "File write",
        ActionApprovalCapabilityKind::ProcessSpawn => "Process spawn",
        ActionApprovalCapabilityKind::Network => "Network",
        ActionApprovalCapabilityKind::CredentialUse => "Credential use",
        ActionApprovalCapabilityKind::ExternalMutation => "External mutation",
        ActionApprovalCapabilityKind::SystemConfiguration => "System configuration",
        ActionApprovalCapabilityKind::UserInterface => "User interface",
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ApprovalView<'a> {
    pub(crate) title: &'a str,
    pub(crate) reason: &'a str,
    pub(crate) details: &'a [String],
    pub(crate) selected: ApprovalDecision,
    pub(crate) submitting: bool,
    pub(crate) error: Option<&'a str>,
}

use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::selection_marker;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;

const MAX_DETAIL_ROWS: usize = 5;

pub(crate) fn desired_height(view: ApprovalView<'_>) -> u16 {
    let content_rows = 4usize
        .saturating_add(view.details.len().min(MAX_DETAIL_ROWS))
        .saturating_add(usize::from(view.error.is_some()));
    u16::try_from(content_rows.saturating_add(2)).unwrap_or(u16::MAX)
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    view: ApprovalView<'_>,
    hovered: Option<usize>,
    pressed: Option<usize>,
    context: RenderContext<'_>,
) {
    let states = [
        choice_state(
            0,
            view.selected == ApprovalDecision::ApproveOnce,
            hovered,
            pressed,
        ),
        choice_state(
            1,
            view.selected == ApprovalDecision::Decline,
            hovered,
            pressed,
        ),
    ];
    let mut lines = vec![Line::styled(
        view.reason,
        Style::default().add_modifier(Modifier::BOLD),
    )];
    lines.extend(
        view.details
            .iter()
            .take(MAX_DETAIL_ROWS)
            .map(|detail| Line::styled(detail, Style::default().fg(context.muted()))),
    );
    lines.push(choice_line("Approve once", states[0], context));
    lines.push(choice_line("Decline", states[1], context));
    if view.submitting {
        lines.push(Line::styled(
            "Submitting…",
            Style::default().fg(context.muted()),
        ));
    } else if let Some(error) = view.error {
        lines.push(Line::styled(error, Style::default().fg(context.danger())));
    }
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .title(view.title)
                .borders(Borders::ALL)
                .style(Style::default().bg(context.background())),
        ),
        area,
    );
    for (index, state) in states.into_iter().enumerate() {
        let row = choice_row(area, view, index);
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
    view: ApprovalView<'_>,
    position: ratatui::layout::Position,
) -> Option<usize> {
    if view.submitting {
        return None;
    }
    (0..2).find(|index| {
        Rect::new(
            area.x.saturating_add(1),
            choice_row(area, view, *index),
            area.width.saturating_sub(2),
            1,
        )
        .contains(position)
    })
}

fn choice_row(area: Rect, view: ApprovalView<'_>, index: usize) -> u16 {
    area.y
        .saturating_add(2)
        .saturating_add(view.details.len().min(MAX_DETAIL_ROWS) as u16)
        .saturating_add(index as u16)
}

fn choice_line<'a>(
    label: &'a str,
    state: InteractionState,
    context: RenderContext<'_>,
) -> Line<'a> {
    let marker = selection_marker(state.selected);
    let style = interaction_style(context, state);
    Line::from(vec![
        Span::styled(marker, style),
        Span::styled(label, style),
    ])
}

fn choice_state(
    index: usize,
    selected: bool,
    hovered: Option<usize>,
    pressed: Option<usize>,
) -> InteractionState {
    InteractionState {
        target: InteractionTarget::Rest,
        selected,
        hovered: hovered == Some(index),
        pressed: pressed == Some(index),
    }
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
