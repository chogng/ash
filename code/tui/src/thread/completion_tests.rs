use super::CommandActivity;
use super::CommandPreparation;
use super::CommandRequest;
use super::CommandState;
use super::prepare_command;
use crate::thread::Command;
use crate::thread::Event;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::ChatSubmission;
use crate::thread::composer::Steer;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_protocol::ApprovalMode;
use ash_protocol::TurnId;

#[test]
fn idle_interrupt_finishes_without_starting_a_request() {
    let preparation = prepare_command(
        None,
        command_state(None, CommandActivity::Ready),
        Command::Interrupt,
    );

    assert!(matches!(preparation, CommandPreparation::None));
}

#[test]
fn unavailable_interrupt_reports_the_race_to_the_thread() {
    let preparation = prepare_command(
        None,
        command_state(None, CommandActivity::Other),
        Command::Interrupt,
    );

    assert!(matches!(
        preparation,
        CommandPreparation::Present(Event::InterruptFailed(error))
            if error == "the active turn is not available"
    ));
}

#[test]
fn active_interrupt_preserves_the_exact_turn_identity() {
    let turn_id = TurnId::new("turn-1").unwrap();
    let preparation = prepare_command(
        None,
        command_state(Some(turn_id.clone()), CommandActivity::Working),
        Command::Interrupt,
    );

    assert!(matches!(
        preparation,
        CommandPreparation::Request(CommandRequest::Interrupt { turn_id: prepared })
            if prepared == turn_id
    ));
}

#[test]
fn older_history_request_uses_the_subscription_cursor() {
    let turn_id = TurnId::new("turn-50").unwrap();
    let preparation = prepare_command(
        Some(ThreadSnapshotHistory::Before {
            turn_id: turn_id.clone(),
            turn_limit: 50,
        }),
        command_state(None, CommandActivity::Ready),
        Command::LoadOlderHistory,
    );

    assert!(matches!(
        preparation,
        CommandPreparation::Request(CommandRequest::LoadOlderHistory {
            before_turn_id
        }) if before_turn_id == turn_id
    ));
}

#[test]
fn working_turn_requeues_a_steer_until_the_composer_marks_it_active() {
    let mut steer = Steer::default();
    let steer_id = steer.push("change direction".into());
    let preparation = prepare_command(
        None,
        command_state(
            Some(TurnId::new("turn-1").unwrap()),
            CommandActivity::Working,
        ),
        Command::SteerTurn {
            steer_id,
            submission: submission(),
        },
    );

    assert!(matches!(
        preparation,
        CommandPreparation::Requeue(Command::SteerTurn {
            steer_id: prepared,
            ..
        }) if prepared == steer_id
    ));
}

#[test]
fn waiting_turn_can_start_a_steer_request() {
    let mut steer = Steer::default();
    let steer_id = steer.push("change direction".into());
    let turn_id = TurnId::new("turn-1").unwrap();
    let preparation = prepare_command(
        None,
        command_state(Some(turn_id.clone()), CommandActivity::Other),
        Command::SteerTurn {
            steer_id,
            submission: submission(),
        },
    );

    assert!(matches!(
        preparation,
        CommandPreparation::Request(CommandRequest::SteerTurn {
            turn_id: prepared,
            steer_id: prepared_steer,
            ..
        }) if prepared == turn_id && prepared_steer == steer_id
    ));
}

fn command_state(active_turn: Option<TurnId>, activity: CommandActivity) -> CommandState {
    CommandState::new(active_turn, ApprovalMode::AskPermissions, activity, false)
}

fn submission() -> ChatSubmission {
    ChatSubmission {
        display_text: "change direction".into(),
        input: vec![ChatInputItem::Text("change direction".into())],
    }
}
