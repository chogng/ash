use super::AppServer;
use super::operations::ThreadMutation;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_core::StartThreadRequest;
use ash_core::ThreadCommandResult;
use ash_core::ThreadSnapshot;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use ash_protocol::AutomationSession;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_protocol::TurnStatus;
use ash_protocol::UnixMillis;

impl AppServer {
    /// Advances one durable automation run through the existing Session and Turn execution path.
    /// The caller supplies a directory-scoped server and retains the original run identity.
    pub fn advance_automation_run(
        &self,
        run: &AutomationRun,
        now: UnixMillis,
    ) -> Result<AutomationRun, String> {
        let mut observed = run.clone();
        observed.message = None;
        let command = command_id("start", &run.id)?;
        let snapshot = match &run.thread_id {
            Some(id) => self.threads.read_thread(id),
            None => match &run.definition.session {
                AutomationSession::New => {
                    let session_command = command_id("session", &run.id)?;
                    match self
                        .threads
                        .read_started_thread(&session_command)
                        .map_err(|error| error.to_string())?
                    {
                        Some(snapshot) => Ok(snapshot),
                        None if run.status == AutomationRunStatus::Stopping => {
                            observed.status = AutomationRunStatus::Stopped;
                            observed.finished_at = Some(now);
                            return Ok(observed);
                        }
                        None => match self.start_thread(StartThreadRequest {
                            agent_id: None,
                            agent: None,
                            command_id: session_command.clone(),
                            title: run.definition.title.clone(),
                        }) {
                            Ok(snapshot) => Ok(snapshot),
                            Err(error) => {
                                // Session creation does not dispatch a Turn. Check durable creation
                                // before classifying a rejected provision as a terminal failure.
                                match self
                                    .threads
                                    .read_started_thread(&session_command)
                                    .map_err(|error| error.to_string())?
                                {
                                    Some(snapshot) => Ok(snapshot),
                                    None => {
                                        observed.status = AutomationRunStatus::Failed;
                                        observed.finished_at = Some(now);
                                        observed.message =
                                            Some(format!("Conversation creation failed: {error}"));
                                        return Ok(observed);
                                    }
                                }
                            }
                        },
                    }
                }
                AutomationSession::Continue { thread_id, .. } => {
                    self.threads.read_thread(thread_id)
                }
            },
        }
        .map_err(|error| error.to_string())?;
        if let AutomationSession::Continue { session_id, .. } = &run.definition.session {
            if session_id != &snapshot.session_id {
                return Err("Automation session and thread do not match".into());
            }
        }
        observed.session_id = Some(snapshot.session_id.clone());
        observed.thread_id = Some(snapshot.thread_id.clone());
        let accepted = accepted_turn(&snapshot, &command);
        if accepted.is_none() && run.status == AutomationRunStatus::Stopping {
            observed.status = AutomationRunStatus::Stopped;
            observed.finished_at = Some(now);
            return Ok(observed);
        }
        self.bind_session_runtime(&snapshot.session_id)
            .map_err(|error| error.to_string())?;
        let snapshot = if accepted.is_none() {
            let start = self.start_turn_request(
                ThreadMutation {
                    command_id: command.clone(),
                    session_id: snapshot.session_id.clone(),
                    expected_sequence: snapshot.sequence,
                },
                snapshot.thread_id.clone(),
                ash_protocol::ApprovalMode::default(),
                None,
                vec![InputItem::Text {
                    text: run.definition.prompt.clone(),
                }],
            );
            let current = self
                .threads
                .read_thread(&snapshot.thread_id)
                .map_err(|error| error.to_string())?;
            if accepted_turn(&current, &command).is_none() {
                if let Err(error) = start {
                    observed.status = AutomationRunStatus::Failed;
                    observed.finished_at = Some(now);
                    observed.message = Some(format!("Agent start failed: {:?}", error.message));
                    return Ok(observed);
                }
                return Err("Accepted automation turn is not yet observable".into());
            }
            current
        } else {
            snapshot
        };
        let turn_id =
            accepted_turn(&snapshot, &command).ok_or("Automation command receipt is missing")?;
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.turn_id == turn_id)
            .ok_or("Automation turn is missing")?;
        observed.turn_id = Some(turn_id.clone());
        observed.started_at = turn
            .started_at_unix_ms
            .map(UnixMillis::new)
            .transpose()
            .map_err(str::to_owned)?;
        observed.status = match turn.status {
            TurnStatus::Created | TurnStatus::Running => AutomationRunStatus::Running,
            TurnStatus::WaitingForApproval
            | TurnStatus::WaitingForUserInput
            | TurnStatus::WaitingForCapability => AutomationRunStatus::NeedsInput,
            TurnStatus::Cancelling => AutomationRunStatus::Stopping,
            TurnStatus::Completed => AutomationRunStatus::Completed,
            TurnStatus::Failed => AutomationRunStatus::Failed,
            TurnStatus::Interrupted => AutomationRunStatus::Stopped,
        };
        if observed.status.is_finished() {
            observed.message = turn.failure.as_ref().map(|error| error.message.clone());
            observed.finished_at =
                Some(UnixMillis::new(turn.status_changed_at_unix_ms).map_err(str::to_owned)?);
        } else if run.status == AutomationRunStatus::Stopping
            && turn.status != TurnStatus::Cancelling
        {
            self.interrupt_turn_request(
                ThreadMutation {
                    command_id: command_id("stop", &run.id)?,
                    session_id: snapshot.session_id,
                    expected_sequence: snapshot.sequence,
                },
                snapshot.thread_id,
                turn_id,
            )
            .map_err(|error| format!("Agent stop failed: {:?}", error.message))?;
            observed.status = AutomationRunStatus::Stopping;
        }
        Ok(observed)
    }
}

fn command_id(action: &str, run_id: &str) -> Result<CommandId, String> {
    let digest = ContentDigest::sha256(run_id.as_bytes())
        .to_string()
        .replace(':', "-");
    CommandId::new(format!("automation-{action}-{digest}")).map_err(|error| error.to_string())
}

fn accepted_turn(
    snapshot: &ThreadSnapshot,
    command_id: &CommandId,
) -> Option<ash_protocol::TurnId> {
    snapshot
        .commands
        .iter()
        .find(|command| &command.receipt.command_id == command_id)
        .and_then(|command| match &command.result {
            ThreadCommandResult::TurnAccepted { turn_id } => Some(turn_id.clone()),
            _ => None,
        })
}
