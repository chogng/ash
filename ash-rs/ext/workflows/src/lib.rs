//! User-owned Team and Develop commands, immutable candidates, and dedicated Agent launches.
mod model;
mod store;
pub use model::Command;
pub use model::Mode;
pub use store::Store;

use ash_core::MultiAgentCoordinator;
use ash_core::SpawnAgentRequest;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::TurnExecutionBackend;
use core_api::CoreError;
use model::Action;
use model::Candidate;
use model::Outcome;
use model::Plan;
use model::Stage;
use model::Status;
use model::Work;
use model::invalid;
use protocol::AgentConfiguration;
use protocol::AgentContextMode;
use protocol::AgentRoleSelection;
use protocol::AgentRoleSource;
use protocol::DelegatedPolicyCeiling;
use protocol::DelegatedTask;
use protocol::ItemId;
use protocol::ThreadId;
use protocol::ThreadItem;
use protocol::TurnId;
use protocol::TurnStatus;
use sha2::Digest;
use sha2::Sha256;

/// Runs product workflow transitions over the existing Thread and Agent owners.
pub struct Runtime<'a> {
    pub store: &'a Store,
    pub threads: &'a ThreadController,
    pub agents: &'a MultiAgentCoordinator,
    pub backend: &'a dyn TurnExecutionBackend,
}

pub struct Receipt {
    pub turn_id: TurnId,
    pub sequence: u64,
    pub child: Option<ThreadId>,
}

impl Runtime<'_> {
    pub fn execute(
        &self,
        root: &ThreadId,
        command: Command,
        request: StartTurnRequest,
    ) -> Result<Receipt, CoreError> {
        let plan = self.prepare(root, command, request)?;
        self.finish(root, plan)
    }

    fn prepare(
        &self,
        root: &ThreadId,
        command: Command,
        request: StartTurnRequest,
    ) -> Result<Plan, CoreError> {
        let parent = self.threads.read_thread(root)?;
        if parent.agent_context_seed.is_some() {
            return Err(invalid("Workflow commands require the root Agent"));
        }
        let request_key = serde_json::to_string(&(
            request.input.clone(),
            request.tool_mode,
            request.approval_mode,
        ))
        .map_err(store::journal)?;
        let command_id = request.command_id.clone();
        self.store.commit(
            &parent.session_id,
            root,
            &command_id,
            &request_key,
            |previous| self.plan(&parent, &command, request, previous),
        )
    }

    fn plan(
        &self,
        parent: &ash_core::ThreadSnapshot,
        command: &Command,
        request: StartTurnRequest,
        mut previous: Option<Work>,
    ) -> Result<Plan, CoreError> {
        if let core_api::SequenceExpectation::Exact(expected) = request.expected_sequence
            && expected != parent.sequence
        {
            return Err(invalid(
                "Thread sequence changed; refresh before sending this command",
            ));
        }
        if let Some(work) = &mut previous {
            self.collect(&parent.thread_id, work)?;
        }
        let work = match (&command.action, previous) {
            (Action::Start(task), previous) => {
                if previous.is_some_and(|work| work.status == Status::Active) {
                    return Err(invalid(
                        "A workflow is already active; finish or cancel it before starting another",
                    ));
                }
                Work::start(
                    request.command_id.to_string(),
                    command.mode,
                    task.clone(),
                    parent.sequence,
                )
            }
            (Action::Resume(_), None) => {
                let task = parent
                    .items
                    .iter()
                    .rev()
                    .find_map(|item| match item {
                        ThreadItem::UserMessage { text, .. }
                            if !text.trim_start().starts_with('/') =>
                        {
                            Some(text.clone())
                        }
                        _ => None,
                    })
                    .ok_or_else(|| invalid("Start the workflow with an explicit task"))?;
                Work::start(
                    request.command_id.to_string(),
                    command.mode,
                    task,
                    parent.sequence,
                )
            }
            (_, Some(work)) if work.mode == command.mode => work,
            (_, Some(_)) => {
                return Err(invalid(
                    "The active work belongs to the other workflow mode",
                ));
            }
            (_, None) => return Err(invalid("There is no workflow in this Thread")),
        };
        // Validate the transition and role before accepting a command Turn.
        let transition = work.apply(&command.action)?;
        let agent = if transition.launch.is_some() {
            let mut ceiling = request
                .tool_profile
                .as_ref()
                .map(|profile| profile.tool_names.clone())
                .unwrap_or_default();
            if let Some(parent_agent) = parent.agent_configuration() {
                ceiling.retain(|tool| {
                    parent_agent
                        .capability_scope
                        .delegation_tools
                        .contains(tool)
                });
            }
            let selected = agent::resolve_launched_agent(
                &AgentRoleSelection::Exact {
                    source: AgentRoleSource::BuiltIn,
                    name: transition.work.stage.role().into(),
                },
                request.model.as_ref(),
                ceiling,
                &request.activated_skills,
                &[agent_roles::built_in_roles()],
                &[],
                agent::AgentLaunch::Workflow,
            )?;
            Some(AgentConfiguration {
                role: selected.role,
                capability_scope: selected.capability_scope,
                base_instructions: Some(request.instructions.clone()),
            })
        } else {
            None
        };
        Ok(Plan {
            turn: None,
            response_sequence: None,
            transition,
            agent,
            submission: model::Submission::new(request, parent.sequence),
        })
    }

    /// Replays committed workflow actions after host services and Thread journals are restored.
    pub fn recover(&self) -> Result<usize, CoreError> {
        let pending = self.store.pending()?;
        let count = pending.len();
        for (root, plan) in pending {
            self.finish(&root, plan)?;
        }
        Ok(count)
    }

    fn finish(&self, root: &ThreadId, mut plan: Plan) -> Result<Receipt, CoreError> {
        if plan.turn.is_none() {
            let started = match self.threads.start_turn(root, plan.submission.request()) {
                Ok(started) => started,
                Err(error) => {
                    if matches!(
                        error,
                        CoreError::InvalidInput(_)
                            | CoreError::InvalidTransition { .. }
                            | CoreError::Policy(_)
                            | CoreError::CommandConflict
                            | CoreError::NotFound(_)
                    ) {
                        self.store.abort(root, &plan.submission.command_id)?;
                    }
                    return Err(error);
                }
            };
            plan.turn = Some(started.turn_id.clone());
            if let Some(revision) = plan.transition.launch {
                let attempt = &mut plan.transition.work.attempts[revision as usize - 1];
                if attempt.parent_turn.is_none() {
                    attempt.parent_turn = Some(started.turn_id);
                }
            }
            let session = self.threads.read_thread(root)?.session_id;
            self.store.activate(&session, root, &plan)?;
        }
        let turn_id = plan.turn.as_ref().expect("activated workflow command");
        let parent = self.threads.read_thread(root)?;
        let turn = parent
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
        for delegation in &plan.transition.cancel {
            if parent.delegations.contains_key(delegation) {
                if let Some(child) = parent.delegations[delegation].child_thread_id.as_ref() {
                    self.agents.cancel_descendants(child)?;
                }
                self.agents.cancel_delegation(root, delegation)?;
            }
        }
        let mut child = None;
        let mut dispatch = None;
        if let Some(revision) = plan.transition.launch {
            let attempt = &plan.transition.work.attempts[revision as usize - 1];
            // Resume the immutable Core seed, never reselect a role or regenerate task context.
            let spawned = if parent.delegations.contains_key(&attempt.delegation) {
                Some(self.agents.resume_delegation(root, &attempt.delegation)?)
            } else if matches!(turn.status, TurnStatus::Created | TurnStatus::Running) {
                let agent = plan.agent.as_ref().expect("launch plans freeze an Agent");
                let context = plan.transition.work.context(attempt)?;
                let digest = format!("sha256:{:x}", Sha256::digest(context.as_bytes()));
                let spawned = self.agents.spawn(SpawnAgentRequest {
                    delegation_id: attempt.delegation.clone(),
                    session_id: parent.session_id.clone(),
                    parent_thread_id: root.clone(),
                    parent_turn_id: attempt.parent_turn.clone().expect("activated stage launch"),
                    task: DelegatedTask {
                        title: format!("{} · {}", attempt.stage.role(), revision),
                        instructions: format!("Fixed workflow context ({digest}):\n{context}"),
                    },
                    role: agent.role.clone(),
                    base_instructions: agent
                        .base_instructions
                        .clone()
                        .expect("workflow base instructions"),
                    inheritance: if matches!(attempt.stage, Stage::Intent | Stage::Team) {
                        AgentContextMode::ForkedPrefix {
                            selection: protocol::ForkedAgentContext::Full,
                        }
                    } else {
                        AgentContextMode::Fresh
                    },
                    policy_ceiling: DelegatedPolicyCeiling {
                        policy_revision: turn.policy_revision.clone(),
                    },
                    capability_scope: agent.capability_scope.clone(),
                });
                match spawned {
                    Ok(spawned) => Some(spawned),
                    Err(error)
                        if matches!(error, CoreError::InvalidInput(_) | CoreError::Policy(_))
                            && !self
                                .threads
                                .read_thread(root)?
                                .delegations
                                .contains_key(&attempt.delegation) =>
                    {
                        self.record_failure(root, &mut plan, error.to_string())?;
                        return self.complete_command(root, &plan, None);
                    }
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            if let Some(spawned) = spawned {
                let snapshot = self.threads.read_thread(&spawned.child_thread_id)?;
                if snapshot.turns.iter().any(|turn| {
                    turn.turn_id == spawned.child_turn_id && turn.status == TurnStatus::Running
                }) {
                    dispatch = Some((spawned.child_thread_id.clone(), spawned.child_turn_id));
                }
                child = Some(spawned.child_thread_id);
            }
        }
        if let Some((thread, turn)) = dispatch {
            if let Err(error) = self.backend.start(&thread, &turn) {
                let snapshot = self.threads.read_thread(&thread)?;
                if snapshot.turns.iter().any(|candidate| {
                    candidate.turn_id == turn && candidate.status == TurnStatus::Running
                }) {
                    self.threads.fail_turn(
                        &thread,
                        &turn,
                        protocol::StableTurnError::model_invocation_failed(),
                    )?;
                }
                self.record_failure(root, &mut plan, error.to_string())?;
            }
        }
        self.complete_command(root, &plan, child)
    }

    fn record_failure(
        &self,
        root: &ThreadId,
        plan: &mut Plan,
        message: String,
    ) -> Result<(), CoreError> {
        let revision = plan.transition.launch.expect("a launch failed");
        plan.transition.work.attempts[revision as usize - 1].candidate = Some(Candidate {
            outcome: Outcome::Failed,
            content: message,
            evidence: Vec::new(),
        });
        self.store
            .activate(&self.threads.read_thread(root)?.session_id, root, plan)
    }

    fn complete_command(
        &self,
        root: &ThreadId,
        plan: &Plan,
        child: Option<ThreadId>,
    ) -> Result<Receipt, CoreError> {
        let turn_id = plan.turn.as_ref().expect("activated workflow command");
        let parent = self.threads.read_thread(root)?;
        let turn = parent
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .expect("accepted workflow Turn");
        let sequence = if matches!(turn.status, TurnStatus::Created | TurnStatus::Running) {
            self.threads
                .complete_turn_with_agent_message(
                    root,
                    turn_id,
                    ItemId::new(format!("workflow:{turn_id}")).map_err(store::journal)?,
                    plan.transition.work.render(),
                )?
                .sequence
        } else {
            parent.sequence
        };
        let sequence = plan.response_sequence.unwrap_or(sequence);
        self.store.finish(root, turn_id, sequence)?;
        Ok(Receipt {
            turn_id: turn_id.clone(),
            sequence,
            child,
        })
    }

    fn collect(&self, root: &ThreadId, work: &mut Work) -> Result<(), CoreError> {
        if work.status != Status::Active {
            return Ok(());
        }
        let parent = self.threads.read_thread(root)?;
        let Some(attempt) = work
            .attempts
            .iter_mut()
            .rev()
            .find(|attempt| attempt.stage == work.stage && attempt.invalidation.is_none())
        else {
            return Ok(());
        };
        if attempt.candidate.is_some() {
            return Ok(());
        }
        let Some(child_id) = parent
            .delegations
            .get(&attempt.delegation)
            .and_then(|delegation| delegation.child_thread_id.as_ref())
        else {
            if let Some(parent_turn) = &attempt.parent_turn {
                if parent.turns.iter().any(|turn| {
                    &turn.turn_id == parent_turn
                        && !matches!(turn.status, TurnStatus::Created | TurnStatus::Running)
                }) {
                    attempt.candidate = Some(Candidate { outcome: Outcome::Failed, content: "Stage launch was interrupted before creating its Agent. Resume to start a new attempt.".into(), evidence: Vec::new() });
                }
            }
            return Ok(());
        };
        let child = self.threads.read_thread(child_id)?;
        if !self.tree_finished(&child)? {
            return Ok(());
        }
        let latest = child
            .turns
            .last()
            .ok_or_else(|| invalid("Workflow child has no Turn"))?;
        let output = child.items.iter().rev().find_map(|item| match item {
            ThreadItem::AgentMessage { turn_id, text, .. } if *turn_id == latest.turn_id => {
                Some(text.as_str())
            }
            _ => None,
        });
        let failed = |message: String| Candidate {
            outcome: Outcome::Failed,
            content: message,
            evidence: Vec::new(),
        };
        let candidate = if latest.status != TurnStatus::Completed {
            failed(format!(
                "Stage Agent ended with {:?}. Inspect its Thread and use resume to create a new attempt.",
                latest.status
            ))
        } else if work.mode == Mode::Team {
            match output.filter(|text| !text.trim().is_empty()) {
                Some(output) => Candidate {
                    outcome: Outcome::Ready,
                    content: output.into(),
                    evidence: Vec::new(),
                },
                None => {
                    failed("Team ended without a final report. Resume to request a report.".into())
                }
            }
        } else {
            match output.and_then(|text| serde_json::from_str::<Candidate>(text).ok()) {
                Some(candidate) if !candidate.content.trim().is_empty() && candidate.content.len() <= 128 * 1024
                    && (candidate.outcome != Outcome::Passed || attempt.stage == Stage::Acceptance)
                    && (attempt.stage != Stage::Acceptance || candidate.outcome != Outcome::Ready)
                    && (!matches!(attempt.stage, Stage::Implementation | Stage::Acceptance) || !matches!(candidate.outcome, Outcome::Ready | Outcome::Passed) || !candidate.evidence.is_empty()) => candidate,
                _ => failed("The Agent did not return a valid candidate with the required outcome and evidence. Resume to request a corrected candidate.".into()),
            }
        };
        if work.mode == Mode::Team && candidate.outcome == Outcome::Ready {
            work.status = Status::Completed;
        }
        attempt.candidate = Some(candidate);
        Ok(())
    }

    fn tree_finished(&self, thread: &ash_core::ThreadSnapshot) -> Result<bool, CoreError> {
        if thread.turns.iter().any(|turn| {
            !matches!(
                turn.status,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
            )
        }) {
            return Ok(false);
        }
        for delegation in thread.delegations.values() {
            let Some(child) = &delegation.child_thread_id else {
                return Ok(false);
            };
            if !self.tree_finished(&self.threads.read_thread(child)?)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod tests;
