use super::AppServer;
use super::RpcError;
use super::automation_operations::error as automation_error;
use super::core_error;
use super::operations::{ThreadMutation, TurnModelSelection};
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use ash_protocol::AutomationSession;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_protocol::SessionId;
use ash_protocol::TurnStatus;
use ash_protocol::UnixMillis;
use core_api::AgentRuntime;
use core_api::CoreError;
use core_api::StartThreadRequest;

impl AppServer {
    /// Called after archiving has committed the Session's terminal events and before deleting
    /// its Threads. Finish durable runs first so concurrent observations cannot revive them.
    pub(super) fn stop_session_automations(&self, session_id: &SessionId) -> Result<(), RpcError> {
        let Some(store) = self.automation_processor.store() else {
            return Ok(());
        };
        let now = ash_automation::now().map_err(automation_error)?;
        let mut changed = false;
        for plan in store.list().map_err(automation_error)? {
            if plan.status == ash_protocol::AutomationStatus::Enabled
                && plan.definition.condition.is_some()
                && matches!(&plan.definition.session, AutomationSession::Continue { session_id: target, .. } if target == session_id)
            {
                store
                    .write(
                        &ash_automation::AutomationWrite {
                            command_id: command_id(
                                "retire",
                                &format!("{}:{}", plan.id, plan.revision),
                            )
                            .map_err(|error| core_error(CoreError::Execution(error)))?
                            .to_string(),
                            id: plan.id,
                            expected_revision: plan.revision,
                            definition: plan.definition,
                            status: ash_protocol::AutomationStatus::Paused,
                        },
                        now,
                    )
                    .map_err(automation_error)?;
                changed = true;
            }
        }
        for mut run in store.active_runs().map_err(automation_error)? {
            let target_session = match &run.session_id {
                Some(id) => Some(id.clone()),
                None => match &run.definition.session {
                    AutomationSession::Continue { session_id, .. } => Some(session_id.clone()),
                    AutomationSession::New => {
                        // Execution may have created the Session before the scheduler saved its
                        // first observation. Resolve the same durable creation receipt.
                        let command = command_id("session", &run.id)
                            .map_err(|error| core_error(CoreError::Execution(error)))?;
                        self.agent_runtime()
                            .read_started_thread(&command)
                            .map_err(core_error)?
                            .map(|thread| thread.session_id)
                    }
                },
            };
            if target_session.as_ref() != Some(session_id) {
                continue;
            }
            run.status = AutomationRunStatus::Stopped;
            run.finished_at = Some(now);
            run.message = None;
            store.observe(&run).map_err(automation_error)?;
            changed = true;
        }
        if changed {
            self.updates.publish_automation_changed();
        }
        Ok(())
    }

    /// Stops are driven by the request thread as well as the scheduler: an unrelated slow
    /// Provider observation must not delay interruption of an already accepted Turn.
    pub(super) fn advance_stopping_automations(&self) -> Result<(), RpcError> {
        let Some(store) = self.automation_processor.store() else {
            return Ok(());
        };
        let now = ash_automation::now().map_err(automation_error)?;
        let mut changed = false;
        for run in store.active_runs().map_err(automation_error)? {
            if run.status != AutomationRunStatus::Stopping {
                continue;
            }
            let observed = self
                .advance_automation_run(&run, now)
                .unwrap_or_else(|error| {
                    let mut observed = run;
                    observed.message = Some(error);
                    observed
                });
            store.observe(&observed).map_err(automation_error)?;
            changed = true;
        }
        if changed {
            self.updates.publish_automation_changed();
        }
        Ok(())
    }

    /// Advances one durable automation run through the existing Session and Turn execution path.
    /// The caller supplies a directory-scoped server and retains the original run identity.
    pub fn advance_automation_run(
        &self,
        run: &AutomationRun,
        now: UnixMillis,
    ) -> Result<AutomationRun, String> {
        // Always reload the durable stop/event state; the scheduler's snapshot may predate a write.
        let current;
        let run = if let Some(store) = self.automation_processor.store() {
            current = store.get_run(&run.id).map_err(|error| error.to_string())?;
            &current
        } else {
            run
        };
        if run.status.is_finished() {
            return Ok(run.clone());
        }
        let mut observed = run.clone();
        observed.message = None;
        let command = command_id("start", &run.id)?;
        let snapshot = match &run.thread_id {
            Some(id) => self.agent_runtime().read_thread(id),
            None => match &run.definition.session {
                AutomationSession::New => {
                    let session_command = command_id("session", &run.id)?;
                    match self
                        .agent_runtime()
                        .read_started_thread(&session_command)
                        .map_err(|error| error.to_string())?
                    {
                        Some(snapshot) => Ok(snapshot),
                        None if run.status == AutomationRunStatus::Stopping => {
                            observed.status = AutomationRunStatus::Stopped;
                            observed.finished_at = Some(now);
                            return Ok(observed);
                        }
                        None => match self.agent_runtime().start_thread(StartThreadRequest {
                            branch_name: None,
                            agent_id: None,
                            agent: None,
                            command_id: session_command.clone(),
                            title: run.definition.title.clone(),
                            execution_target: Some(ash_protocol::SessionExecutionTarget::Local {
                                root: run.definition.directory.clone().into(),
                            }),
                        }) {
                            Ok(snapshot) => Ok(snapshot),
                            Err(error) => {
                                // Session creation does not dispatch a Turn. Check durable creation
                                // before classifying a rejected provision as a terminal failure.
                                match self
                                    .agent_runtime()
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
                    self.agent_runtime().read_thread(thread_id)
                }
            },
        };
        let snapshot = match snapshot {
            Ok(snapshot) => snapshot,
            // A deleted target cannot make progress or be interrupted. It is a terminal
            // cancellation, whereas storage/transport errors still require reconciliation.
            Err(CoreError::NotFound(_)) => {
                observed.status = AutomationRunStatus::Stopped;
                observed.finished_at = Some(now);
                return Ok(observed);
            }
            Err(error) => return Err(error.to_string()),
        };
        if let AutomationSession::Continue { session_id, .. } = &run.definition.session {
            if session_id != &snapshot.session_id {
                return Err("Automation session and thread do not match".into());
            }
        }
        observed.session_id = Some(snapshot.session_id.clone());
        observed.thread_id = Some(snapshot.thread_id.clone());
        let accepted = self
            .agent_runtime()
            .accepted_turn(&snapshot.thread_id, &command)
            .map_err(|error| error.to_string())?;
        if accepted.is_none() && run.status == AutomationRunStatus::Stopping {
            observed.status = AutomationRunStatus::Stopped;
            observed.finished_at = Some(now);
            return Ok(observed);
        }
        if accepted.is_none() && run.definition.condition.is_some() {
            if snapshot.turns.iter().any(|turn| {
                !matches!(
                    turn.status,
                    TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
                )
            }) {
                return Ok(observed);
            }
            match self.prepare_automation_event(run, now)? {
                Some(prepared) => observed.event = prepared.event,
                None => {
                    let latest = self
                        .automation_processor
                        .store()
                        .ok_or("Automation store unavailable")?
                        .get_run(&run.id)
                        .map_err(|error| error.to_string())?;
                    observed.status = if latest.status == AutomationRunStatus::Stopping {
                        AutomationRunStatus::Stopped
                    } else {
                        AutomationRunStatus::Skipped
                    };
                    observed.finished_at = Some(now);
                    return Ok(observed);
                }
            }
        }
        self.bind_session_runtime(&snapshot.session_id)
            .map_err(|error| error.to_string())?;
        let snapshot = if accepted.is_none() {
            let dispatch = || {
                if let Some(condition) = &run.definition.condition {
                    self.validate_follow_up_account(condition).map_err(|message| RpcError::with_details(
                        -32030, ash_app_server_protocol::protocol::error::AppServerErrorName::AccountAuthenticationRequired, message,
                    ))?;
                }
                self.agent_processor().start_turn_request(
                    ThreadMutation {
                        ide_window_id: None,
                        connection_id: None,
                        command_id: command.clone(),
                        session_id: snapshot.session_id.clone(),
                        expected_sequence: snapshot.sequence,
                    },
                    snapshot.thread_id.clone(),
                    ash_protocol::ApprovalMode::default(),
                    ash_protocol::CollaborationMode::Agent,
                    TurnModelSelection::Current,
                    None,
                    None,
                    vec![InputItem::Text {
                        text: match &observed.event {
                            Some(event) => {
                                format!("{}\n\n{}", run.definition.prompt, event.context)
                            }
                            None => run.definition.prompt.clone(),
                        },
                    }],
                )
            };
            let start = if let Some(store) = self.automation_processor.store() {
                match store
                    .dispatch_if_current(&run.id, dispatch)
                    .map_err(|error| error.to_string())?
                {
                    Some(result) => result,
                    None => {
                        observed.status = AutomationRunStatus::Stopped;
                        observed.finished_at = Some(now);
                        return Ok(observed);
                    }
                }
            } else {
                dispatch()
            };
            let current = self
                .agent_runtime()
                .read_thread(&snapshot.thread_id)
                .map_err(|error| error.to_string())?;
            if self
                .agent_runtime()
                .accepted_turn(&current.thread_id, &command)
                .map_err(|error| error.to_string())?
                .is_none()
            {
                if let Err(error) = start {
                    observed.message = Some(format!("Agent start failed: {:?}", error.message));
                    if run.definition.condition.is_some()
                        && matches!(
                            error.cause.as_deref(),
                            Some(CoreError::ThreadStore(
                                thread_store::ThreadStoreError::SequenceConflict { .. }
                            ))
                        )
                    {
                        // A synchronous sequence rejection with no durable acceptance can
                        // retry. Keep the active run, event claim and command ID together:
                        // the next poll (or restart) reconciles this same command before
                        // submitting with the latest sequence. Other failures retain the
                        // claim and must not authorize a replacement execution.
                        return Ok(observed);
                    }
                    observed.status = AutomationRunStatus::Failed;
                    observed.finished_at = Some(now);
                    return Ok(observed);
                }
                return Err("Accepted automation turn is not yet observable".into());
            }
            current
        } else {
            snapshot
        };
        let turn_id = self
            .agent_runtime()
            .accepted_turn(&snapshot.thread_id, &command)
            .map_err(|error| error.to_string())?
            .ok_or("Automation command receipt is missing")?;
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
            self.agent_processor()
                .interrupt_turn_request(
                    ThreadMutation {
                        ide_window_id: None,
                        connection_id: None,
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
    fn validate_follow_up_account(
        &self,
        condition: &ash_protocol::AutomationCondition,
    ) -> Result<(), String> {
        let ash_protocol::AutomationCondition::GitHubChecks {
            host,
            account_id,
            credential_revision,
            ..
        } = condition;
        let accounts = self
            .github_accounts
            .as_ref()
            .ok_or("GitHub accounts unavailable")?
            .accounts()
            .map_err(|error| error.to_string())?;
        if !accounts.iter().any(|account| {
            account.id == *account_id
                && account.host == *host
                && account.credential_revision.to_string() == *credential_revision
                && account.status == ash_login::AccountStatus::Ready
        }) {
            return Err(
                "PR follow-up account changed; enable follow-up again with the current account"
                    .into(),
            );
        }
        Ok(())
    }

    /// Conditions consume optional domain Providers; the automation store owns dispatch and receipts.
    fn prepare_automation_event(
        &self,
        run: &AutomationRun,
        now: UnixMillis,
    ) -> Result<Option<AutomationRun>, String> {
        let Some(ash_protocol::AutomationCondition::GitHubChecks {
            host,
            owner,
            repository,
            number,
            account_id,
            ..
        }) = &run.definition.condition
        else {
            return Ok(Some(run.clone()));
        };
        self.validate_follow_up_account(
            run.definition
                .condition
                .as_ref()
                .ok_or("Missing provider condition")?,
        )?;
        let source = ash_async_utils::CancellationSource::new();
        let _guard = source.cancel_on_drop();
        let client = self
            .github_processor()
            .map_err(|error| format!("{:?}", error.message))?
            .selected_client(&source.token(), account_id)
            .map_err(|error| format!("{:?}", error.message))?;
        let repository = github::Repository::new(host.clone(), owner.clone(), repository.clone())
            .map_err(|error| error.to_string())?;
        let observation = super::request_dispatch::runtime()
            .map_err(|error| error.to_string())?
            .block_on(async {
                tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    client.pull_request_follow_up(&repository, *number),
                )
                .await
            })
            .map_err(|_| "PR follow-up observation timed out".to_owned())?
            .map_err(|error| error.to_string())?;
        self.validate_follow_up_account(
            run.definition
                .condition
                .as_ref()
                .ok_or("Missing provider condition")?,
        )?;
        let store = self
            .automation_processor
            .store()
            .ok_or("Automation store unavailable")?;
        match observation {
            github::PullRequestFollowUp::Closed => {
                if let Some(plan) = store
                    .list()
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .find(|plan| {
                        plan.id == run.automation_id
                            && plan.revision == run.revision
                            && plan.status == ash_protocol::AutomationStatus::Enabled
                    })
                {
                    store
                        .write(
                            &ash_automation::AutomationWrite {
                                command_id: command_id("closed", &run.id)?.to_string(),
                                id: plan.id,
                                expected_revision: plan.revision,
                                definition: plan.definition,
                                status: ash_protocol::AutomationStatus::Paused,
                            },
                            now,
                        )
                        .map_err(|error| error.to_string())?;
                }
                Ok(None)
            }
            github::PullRequestFollowUp::Waiting => Ok(None),
            github::PullRequestFollowUp::Failed { head, context } => {
                let key = serde_json::to_string(&(host, owner, &repository.name, number, head))
                    .map_err(|error| error.to_string())?;
                if run.event.as_ref().is_some_and(|event| event.key != key) {
                    return Ok(None);
                }
                let event = run
                    .event
                    .clone()
                    .unwrap_or(ash_protocol::AutomationEvent { key, context });
                if !store
                    .claim_event(&run.id, event)
                    .map_err(|error| error.to_string())?
                {
                    return Ok(None);
                }
                store
                    .get_run(&run.id)
                    .map(Some)
                    .map_err(|error| error.to_string())
            }
        }
    }
}

fn command_id(action: &str, run_id: &str) -> Result<CommandId, String> {
    let digest = ContentDigest::sha256(run_id.as_bytes())
        .to_string()
        .replace(':', "-");
    CommandId::new(format!("automation-{action}-{digest}")).map_err(|error| error.to_string())
}
