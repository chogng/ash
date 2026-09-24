use super::Approval;
use super::ApprovalDecision;
use super::ApprovalOutcome;
use super::ApprovalSpec;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;

#[test]
fn approval_uses_fixed_choices_and_blocks_duplicate_submission() {
    let mut approval = approval();
    approval.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));

    assert_eq!(
        approval.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ApprovalOutcome::Respond(ApprovalDecision::Decline)
    );
    assert_eq!(
        approval.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ApprovalOutcome::Consumed
    );
}

#[test]
fn submission_failure_restores_the_approval_and_exposes_the_error() {
    let mut approval = approval();
    approval.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    approval.submission_failed("request failed".into());

    assert!(!approval.view().submitting);
    assert_eq!(approval.view().error, Some("request failed"));
    approval.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        approval.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ApprovalOutcome::Respond(ApprovalDecision::Decline)
    );
}

fn approval() -> Approval {
    Approval::new(ApprovalSpec {
        title: "Approval required".into(),
        reason: "Run command?".into(),
        details: vec!["Process spawn  ·  cargo test".into()],
    })
}

#[test]
fn navigation_repeats_never_submit_or_wrap_the_approval_choice() {
    let mut approval = approval();
    for _ in 0..3 {
        assert_eq!(
            approval.handle_key(KeyEvent::new_with_kind(
                KeyCode::Char('j'),
                KeyModifiers::NONE,
                crossterm::event::KeyEventKind::Repeat
            )),
            ApprovalOutcome::Consumed
        );
    }
    assert_eq!(approval.view().selected, ApprovalDecision::Decline);
    assert_eq!(
        approval.handle_key(KeyEvent::new_with_kind(
            KeyCode::Enter,
            KeyModifiers::NONE,
            crossterm::event::KeyEventKind::Repeat
        )),
        ApprovalOutcome::Consumed
    );
    assert!(!approval.view().submitting);
    approval.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(
        approval.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        ApprovalOutcome::Consumed
    );
    assert_eq!(approval.view().selected, ApprovalDecision::ApproveOnce);
}

#[test]
fn pointer_choice_uses_the_full_row_and_the_ordinary_activation_path() {
    let mut approval = approval();
    let area = Rect::new(0, 0, 40, super::desired_height(approval.view()));
    let decline_row = area.y + 4;
    assert_eq!(
        super::choice_at(
            area,
            approval.view(),
            ratatui::layout::Position::new(area.right() - 2, decline_row)
        ),
        Some(1)
    );
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            super::draw(
                frame,
                area,
                approval.view(),
                Some(1),
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    for column in area.x + 1..area.right() - 1 {
        assert_eq!(
            terminal.backend().buffer()[(column, decline_row)].bg,
            crate::render::test_context().hover_background()
        );
    }
    assert_eq!(
        approval.activate(1),
        ApprovalOutcome::Respond(ApprovalDecision::Decline)
    );
}
