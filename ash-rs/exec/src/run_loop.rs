use crate::ExecEntry;
use crate::ExecEvent;
use crate::ExecEventKind;
use crate::ExecEventSink;
use crate::ExecOrigin;
use crate::ExecOutcome;
use crate::ExecRunId;
use crate::ExecRunRequest;
use crate::connection::ConnectionError;
use crate::connection::ConnectionEvent;
use crate::connection::ExecConnection;
use crate::runner::ExecCancellation;
use crate::runner::ExecError;
use crate::runner::ExecRunnerOptions;
use crate::turn_outcome::InterruptIntent;
use crate::turn_outcome::protocol_approval_mode;
use crate::turn_outcome::required_interaction;
use crate::turn_outcome::terminal_outcome;
use crate::turn_outcome::unknown_outcome;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::time::Instant;

pub(crate) fn run_connected<C, S, K>(
    options: ExecRunnerOptions,
    connection: &mut C,
    request: ExecRunRequest,
    sink: &mut S,
    cancellation: &K,
) -> Result<ExecOutcome, ExecError>
where
    C: ExecConnection,
    S: ExecEventSink + ?Sized,
    K: ExecCancellation + ?Sized,
{
    let prepared = prepare_run(connection, &request)?;
    let subscription = connection
        .subscribe_thread(
            prepared.session_id.clone(),
            prepared.thread_id.clone(),
            prepared.thread.sequence,
        )
        .map_err(|error| app_server_error("subscribe Thread", error))?;
    let result = run_subscribed(
        options,
        connection,
        &request,
        subscription.thread,
        subscription.updates,
        sink,
        cancellation,
    );
    let unsubscribe = connection.unsubscribe_thread(prepared.session_id, prepared.thread_id);
    match (result, unsubscribe) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(app_server_error("unsubscribe Thread", error)),
        (Ok(outcome), Ok(())) => Ok(outcome),
    }
}

fn run_subscribed<C, S, K>(
    options: ExecRunnerOptions,
    connection: &mut C,
    request: &ExecRunRequest,
    thread: Thread,
    gap_updates: Vec<ash_protocol::ThreadUpdateEnvelope>,
    sink: &mut S,
    cancellation: &K,
) -> Result<ExecOutcome, ExecError>
where
    C: ExecConnection,
    S: ExecEventSink + ?Sized,
    K: ExecCancellation + ?Sized,
{
    let session_id = thread.session_id.clone();
    let thread_id = thread.thread_id.clone();
    emit(
        sink,
        &request.run_id,
        ExecEventKind::RunStarted {
            origin: ExecOrigin::Local,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
        },
    )?;
    for update in gap_updates {
        emit(
            sink,
            &request.run_id,
            ExecEventKind::ThreadUpdated {
                update: Box::new(update),
            },
        )?;
    }
    if cancellation.is_cancelled() {
        return Err(ExecError::CancelledBeforeStart);
    }
    let started = connection
        .start_turn(
            command_id(&request.run_id, "start-turn"),
            session_id.clone(),
            thread_id.clone(),
            thread.sequence,
            protocol_approval_mode(request.approval),
            request.entry.input().to_vec(),
        )
        .map_err(|error| app_server_error("start Turn", error))?;
    if let Err(error) = emit(
        sink,
        &request.run_id,
        ExecEventKind::TurnStarted {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: started.turn_id.clone(),
        },
    ) {
        best_effort_interrupt(
            connection,
            &request.run_id,
            &session_id,
            &thread_id,
            &started.turn_id,
            started.sequence,
        );
        return Err(error);
    }
    let outcome = drive_turn(
        options,
        connection,
        request,
        ActiveTurn {
            session_id,
            thread_id,
            turn_id: started.turn_id,
        },
        sink,
        cancellation,
    )?;
    emit(
        sink,
        &request.run_id,
        ExecEventKind::RunCompleted {
            outcome: outcome.clone(),
        },
    )?;
    Ok(outcome)
}

fn drive_turn<C, S, K>(
    options: ExecRunnerOptions,
    connection: &mut C,
    request: &ExecRunRequest,
    active: ActiveTurn,
    sink: &mut S,
    cancellation: &K,
) -> Result<ExecOutcome, ExecError>
where
    C: ExecConnection,
    S: ExecEventSink + ?Sized,
    K: ExecCancellation + ?Sized,
{
    let ActiveTurn {
        session_id,
        thread_id,
        turn_id,
    } = active;
    let run_deadline = Instant::now()
        .checked_add(options.turn_timeout)
        .ok_or_else(|| ExecError::InvalidRequest("turn timeout is too large".into()))?;
    let mut interrupt = None;
    let mut interrupt_deadline = None;
    loop {
        let snapshot = match connection.read_thread(session_id.clone(), thread_id.clone()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Ok(unknown_outcome(
                    &session_id,
                    &thread_id,
                    &turn_id,
                    crate::ExecUnknownReason::ObservationFailed {
                        message: error.to_string(),
                    },
                ));
            }
        };
        let last_sequence = snapshot.sequence;
        let turn = match snapshot.turns.iter().find(|turn| turn.turn_id == turn_id) {
            Some(turn) => turn,
            None => {
                return Ok(unknown_outcome(
                    &session_id,
                    &thread_id,
                    &turn_id,
                    crate::ExecUnknownReason::ObservationFailed {
                        message: "App Server snapshot omitted the started Turn".into(),
                    },
                ));
            }
        };
        if let Some(outcome) = terminal_outcome(&session_id, &thread_id, turn, interrupt.as_ref()) {
            return Ok(outcome);
        }

        let now = Instant::now();
        if interrupt.is_none() {
            let requested = if cancellation.is_cancelled() {
                Some(InterruptIntent::CancellationRequested)
            } else if let Some(interaction) = required_interaction(request.approval, turn) {
                Some(InterruptIntent::RequiresInteraction(interaction))
            } else if now >= run_deadline {
                Some(InterruptIntent::TurnTimeout)
            } else {
                None
            };
            if let Some(requested) = requested {
                if let Err(error) = connection.interrupt_turn(
                    command_id(&request.run_id, "interrupt-turn"),
                    session_id.clone(),
                    thread_id.clone(),
                    turn_id.clone(),
                    last_sequence,
                ) {
                    return Ok(unknown_outcome(
                        &session_id,
                        &thread_id,
                        &turn_id,
                        crate::ExecUnknownReason::InterruptFailed {
                            message: error.to_string(),
                        },
                    ));
                }
                interrupt = Some(requested);
                interrupt_deadline = now.checked_add(options.interrupt_timeout);
                if interrupt_deadline.is_none() {
                    return Err(ExecError::InvalidRequest(
                        "interrupt timeout is too large".into(),
                    ));
                }
            }
        }
        if interrupt_deadline.is_some_and(|deadline| now >= deadline) {
            return Ok(unknown_outcome(
                &session_id,
                &thread_id,
                &turn_id,
                crate::ExecUnknownReason::TerminalDeadlineElapsed,
            ));
        }

        match connection
            .poll_event(options.event_poll_interval)
            .map_err(|error| app_server_error("receive App Server event", error))?
        {
            ConnectionEvent::ThreadUpdated(update)
                if update.session_id == session_id && update.thread_id == thread_id =>
            {
                if let Err(error) = emit(
                    sink,
                    &request.run_id,
                    ExecEventKind::ThreadUpdated { update },
                ) {
                    if interrupt.is_none() {
                        best_effort_interrupt(
                            connection,
                            &request.run_id,
                            &session_id,
                            &thread_id,
                            &turn_id,
                            last_sequence,
                        );
                    }
                    return Err(error);
                }
            }
            ConnectionEvent::Closed(reason) => {
                let final_snapshot = connection
                    .read_thread(session_id.clone(), thread_id.clone())
                    .ok();
                if let Some(outcome) = final_snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.turns.iter().find(|turn| turn.turn_id == turn_id))
                    .and_then(|turn| {
                        terminal_outcome(&session_id, &thread_id, turn, interrupt.as_ref())
                    })
                {
                    return Ok(outcome);
                }
                return Ok(unknown_outcome(
                    &session_id,
                    &thread_id,
                    &turn_id,
                    crate::ExecUnknownReason::ConnectionClosed { reason },
                ));
            }
            ConnectionEvent::ThreadUpdated(_)
            | ConnectionEvent::Other
            | ConnectionEvent::TimedOut => {}
        }
    }
}

struct PreparedRun {
    session_id: SessionId,
    thread_id: ThreadId,
    thread: Thread,
}

struct ActiveTurn {
    session_id: SessionId,
    thread_id: ThreadId,
    turn_id: TurnId,
}

fn prepare_run<C>(connection: &mut C, request: &ExecRunRequest) -> Result<PreparedRun, ExecError>
where
    C: ExecConnection,
{
    let (session_id, thread_id) = match &request.entry {
        ExecEntry::New { title, .. } => {
            let session = connection
                .create_session(command_id(&request.run_id, "create-session"), title.clone())
                .map_err(|error| app_server_error("create Session", error))?;
            let thread_id = ThreadId::new(session.session_id.as_str().to_owned())
                .map_err(|error| ExecError::InvalidRequest(error.to_string()))?;
            (session.session_id, thread_id)
        }
        ExecEntry::Resume {
            session_id,
            thread_id,
            ..
        } => {
            connection
                .read_session(session_id.clone())
                .map_err(|error| app_server_error("read Session", error))?;
            (session_id.clone(), thread_id.clone())
        }
        ExecEntry::Fork {
            session_id,
            parent_thread_id,
            title,
            ..
        } => {
            connection
                .read_session(session_id.clone())
                .map_err(|error| app_server_error("read Session", error))?;
            let thread_id = connection
                .fork_thread(
                    command_id(&request.run_id, "fork-thread"),
                    session_id.clone(),
                    parent_thread_id.clone(),
                    title.clone(),
                )
                .map_err(|error| app_server_error("fork Thread", error))?;
            (session_id.clone(), thread_id)
        }
    };
    let thread = connection
        .read_thread(session_id.clone(), thread_id.clone())
        .map_err(|error| app_server_error("read Thread", error))?;
    Ok(PreparedRun {
        session_id,
        thread_id,
        thread,
    })
}

fn command_id(run_id: &ExecRunId, operation: &str) -> CommandId {
    CommandId::new(format!("{run_id}-{operation}"))
        .expect("generated exec command IDs are non-empty")
}

fn emit<S>(sink: &mut S, run_id: &ExecRunId, event: ExecEventKind) -> Result<(), ExecError>
where
    S: ExecEventSink + ?Sized,
{
    sink.emit(&ExecEvent::new(run_id, event))
        .map_err(ExecError::Output)
}

fn best_effort_interrupt<C>(
    connection: &mut C,
    run_id: &ExecRunId,
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    expected_sequence: u64,
) where
    C: ExecConnection,
{
    let _ = connection.interrupt_turn(
        command_id(run_id, "interrupt-turn"),
        session_id.clone(),
        thread_id.clone(),
        turn_id.clone(),
        expected_sequence,
    );
}

fn app_server_error(operation: &'static str, error: ConnectionError) -> ExecError {
    ExecError::AppServer {
        operation,
        message: error.to_string(),
    }
}
