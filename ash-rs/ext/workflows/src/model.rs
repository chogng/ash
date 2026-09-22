use core_api::CoreError;
use protocol::DelegationId;
use protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Team,
    Develop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Command {
    pub(crate) mode: Mode,
    pub(crate) action: Action,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Action {
    Start(String),
    Status,
    Resume(String),
    Cancel,
    Accept(u32),
    Revise(Stage, String),
}

impl Command {
    /// Recognizes exact product commands; ordinary conversation is never interpreted as a workflow.
    pub fn parse(text: &str) -> Result<Option<Self>, CoreError> {
        let (name, tail) = text
            .trim()
            .split_once(char::is_whitespace)
            .unwrap_or((text.trim(), ""));
        let mode = match name {
            "/team" => Mode::Team,
            "/develop" => Mode::Develop,
            _ => return Ok(None),
        };
        let tail = tail.trim();
        let (verb, argument) = tail.split_once(char::is_whitespace).unwrap_or((tail, ""));
        let argument = argument.trim();
        let action = match verb {
            "" => Action::Resume(String::new()),
            "status" if argument.is_empty() => Action::Status,
            "cancel" if argument.is_empty() => Action::Cancel,
            "resume" => Action::Resume(argument.into()),
            "accept" if mode == Mode::Develop => Action::Accept(
                argument
                    .parse()
                    .map_err(|_| invalid("Use /develop accept <candidate revision>"))?,
            ),
            "revise" if mode == Mode::Develop => {
                let (stage, reason) = argument
                    .split_once(char::is_whitespace)
                    .ok_or_else(|| invalid("Use /develop revise <stage> <reason>"))?;
                let stage = match stage {
                    "intent" => Stage::Intent,
                    "spec" => Stage::Spec,
                    "plan" => Stage::Plan,
                    "implementation" => Stage::Implementation,
                    "acceptance" => Stage::Acceptance,
                    _ => return Err(invalid("Unknown Develop stage")),
                };
                if reason.trim().is_empty() {
                    return Err(invalid("Revision requires a reason"));
                }
                Action::Revise(stage, reason.trim().into())
            }
            "status" | "cancel" | "accept" | "revise" => {
                return Err(invalid("Invalid workflow command arguments"));
            }
            _ => Action::Start(tail.into()),
        };
        Ok(Some(Self { mode, action }))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Team,
    Intent,
    Spec,
    Plan,
    Implementation,
    Acceptance,
}

impl Stage {
    pub(crate) fn role(self) -> &'static str {
        match self {
            Self::Team => "team-coordinator",
            Self::Intent => "develop-intent",
            Self::Spec => "develop-spec",
            Self::Plan => "develop-plan",
            Self::Implementation => "develop-implementer",
            Self::Acceptance => "develop-acceptance",
        }
    }
    fn next(self) -> Option<Self> {
        match self {
            Self::Team | Self::Acceptance => None,
            Self::Intent => Some(Self::Spec),
            Self::Spec => Some(Self::Plan),
            Self::Plan => Some(Self::Implementation),
            Self::Implementation => Some(Self::Acceptance),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Work {
    pub id: String,
    pub mode: Mode,
    pub task: String,
    pub anchor_sequence: u64,
    pub stage: Stage,
    pub status: Status,
    pub accepted: BTreeMap<Stage, u32>,
    pub attempts: Vec<Attempt>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Active,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Attempt {
    pub revision: u32,
    pub stage: Stage,
    pub delegation: DelegationId,
    pub parent_turn: Option<TurnId>,
    pub candidate: Option<Candidate>,
    pub invalidation: Option<String>,
    pub feedback: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Candidate {
    pub outcome: Outcome,
    pub content: String,
    pub evidence: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Ready,
    Passed,
    Failed,
    NeedsUserDecision,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Transition {
    pub work: Work,
    pub launch: Option<u32>,
    pub cancel: Vec<DelegationId>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Plan {
    pub turn: Option<TurnId>,
    pub response_sequence: Option<u64>,
    pub transition: Transition,
    pub agent: Option<protocol::AgentConfiguration>,
    pub submission: Submission,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Submission {
    pub command_id: protocol::CommandId,
    pub sequence: u64,
    pub policy: String,
    pub command: protocol::ThreadCommand,
}

impl Submission {
    pub fn new(request: ash_core::StartTurnRequest, sequence: u64) -> Self {
        Self {
            command_id: request.command_id,
            sequence,
            policy: request.policy_revision,
            command: protocol::ThreadCommand::StartTurn {
                kind: request.kind,
                instructions: Some(request.instructions),
                model: request.model,
                advisor: request.advisor,
                activated_skills: request.activated_skills.clone(),
                host_activated_skills: Some(request.activated_skills),
                approval_mode: request.approval_mode,
                tool_mode: request.tool_mode,
                tool_profile: request.tool_profile.map(Box::new),
                input: request.input,
            },
        }
    }
    pub fn request(&self) -> ash_core::StartTurnRequest {
        let protocol::ThreadCommand::StartTurn {
            kind,
            instructions,
            model,
            advisor,
            activated_skills,
            approval_mode,
            tool_mode,
            tool_profile,
            input,
            ..
        } = &self.command
        else {
            unreachable!("workflow submissions only start control Turns")
        };
        ash_core::StartTurnRequest {
            command_id: self.command_id.clone(),
            expected_sequence: core_api::SequenceExpectation::Exact(self.sequence),
            model: model.clone(),
            advisor: advisor.clone(),
            kind: *kind,
            instructions: instructions.clone().expect("frozen command instructions"),
            policy_revision: self.policy.clone(),
            approval_mode: *approval_mode,
            tool_mode: *tool_mode,
            tool_profile: tool_profile.as_deref().cloned(),
            activated_skills: activated_skills.clone(),
            input: input.clone(),
        }
    }
}

impl Work {
    pub fn start(id: String, mode: Mode, task: String, sequence: u64) -> Self {
        Self {
            id,
            mode,
            task,
            anchor_sequence: sequence,
            stage: if mode == Mode::Team {
                Stage::Team
            } else {
                Stage::Intent
            },
            status: Status::Active,
            accepted: BTreeMap::new(),
            attempts: Vec::new(),
        }
    }

    pub fn current(&self) -> Option<&Attempt> {
        self.attempts
            .iter()
            .rev()
            .find(|attempt| attempt.stage == self.stage && attempt.invalidation.is_none())
    }

    pub fn apply(mut self, action: &Action) -> Result<Transition, CoreError> {
        let mut cancel = Vec::new();
        let mut feedback = String::new();
        let launch = match action {
            Action::Status => false,
            Action::Cancel => {
                if self.status == Status::Active {
                    cancel.extend(self.current().map(|attempt| attempt.delegation.clone()));
                    self.status = Status::Cancelled;
                }
                false
            }
            Action::Start(_) => true,
            Action::Accept(revision) => {
                if self.status != Status::Active {
                    return Err(invalid("This work is not active"));
                }
                let attempt = self
                    .current()
                    .ok_or_else(|| invalid("There is no candidate"))?;
                let candidate = attempt
                    .candidate
                    .as_ref()
                    .ok_or_else(|| invalid("The stage Agent is still running"))?;
                if attempt.revision != *revision {
                    return Err(invalid("The candidate revision is stale"));
                }
                let expected = if self.stage == Stage::Acceptance {
                    Outcome::Passed
                } else {
                    Outcome::Ready
                };
                if candidate.outcome != expected {
                    return Err(invalid(
                        "A failed or undecided candidate cannot be accepted",
                    ));
                }
                self.accepted.insert(self.stage, *revision);
                if let Some(next) = self.stage.next() {
                    self.stage = next;
                    true
                } else {
                    self.status = Status::Completed;
                    false
                }
            }
            Action::Resume(answer) => {
                if self.status != Status::Active {
                    return Err(invalid("This work has ended; start a new work with a task"));
                }
                feedback = answer.clone();
                match self
                    .current()
                    .and_then(|attempt| attempt.candidate.as_ref())
                {
                    Some(candidate)
                        if candidate.outcome == Outcome::NeedsUserDecision && answer.is_empty() =>
                    {
                        return Err(invalid(
                            "Use /develop resume <your decision> to answer the pending question",
                        ));
                    }
                    Some(candidate)
                        if matches!(candidate.outcome, Outcome::Ready | Outcome::Passed) =>
                    {
                        return Err(invalid(
                            "Accept the current candidate by revision, or revise it explicitly",
                        ));
                    }
                    Some(_) => true,
                    None => self.current().is_none(),
                }
            }
            Action::Revise(stage, reason) => {
                if self.mode != Mode::Develop || *stage > self.stage {
                    return Err(invalid("Cannot revise a stage that has not been reached"));
                }
                if self.status == Status::Cancelled {
                    return Err(invalid("Cancelled work cannot be revised"));
                }
                cancel.extend(self.current().map(|attempt| attempt.delegation.clone()));
                self.accepted.retain(|accepted, _| accepted < stage);
                for attempt in &mut self.attempts {
                    if attempt.stage >= *stage && attempt.invalidation.is_none() {
                        attempt.invalidation = Some(reason.clone());
                    }
                }
                self.stage = *stage;
                self.status = Status::Active;
                feedback = reason.clone();
                true
            }
        };
        let revision = if launch {
            let revision = u32::try_from(self.attempts.len() + 1)
                .map_err(|_| invalid("Too many workflow attempts"))?;
            self.attempts.push(Attempt {
                revision,
                stage: self.stage,
                delegation: DelegationId::new(format!("workflow:{}:{revision}", self.id))
                    .map_err(|error| invalid(&error.to_string()))?,
                parent_turn: None,
                candidate: None,
                invalidation: None,
                feedback,
            });
            Some(revision)
        } else if matches!(action, Action::Resume(_)) {
            self.current()
                .filter(|attempt| attempt.candidate.is_none())
                .map(|attempt| attempt.revision)
        } else {
            None
        };
        Ok(Transition {
            work: self,
            launch: revision,
            cancel,
        })
    }

    pub fn context(&self, attempt: &Attempt) -> Result<String, CoreError> {
        let accepted = self.accepted.iter().map(|(stage, revision)| {
            let accepted = &self.attempts[*revision as usize - 1];
            serde_json::json!({ "stage": stage, "revision": revision, "candidate": accepted.candidate })
        }).collect::<Vec<_>>();
        serde_json::to_string(&serde_json::json!({
            "work": self.id, "task": self.task, "anchor_sequence": self.anchor_sequence,
            "stage": attempt.stage, "candidate_revision": attempt.revision,
            "accepted": accepted, "user_feedback": attempt.feedback,
            "previous_candidate": self.attempts.iter().rev().find(|previous| previous.revision < attempt.revision && previous.stage == attempt.stage).map(|previous| serde_json::json!({"revision": previous.revision, "invalidation": previous.invalidation, "candidate": previous.candidate})),
        })).map_err(|error| CoreError::Journal(error.to_string()))
    }

    pub fn render(&self) -> String {
        let current = self.current();
        let state = match self.status {
            Status::Completed => "completed",
            Status::Cancelled => "cancelled",
            Status::Active => "active",
        };
        let mut result = format!("{:?} {} · {:?} · {state}\n", self.mode, self.id, self.stage);
        if let Some(attempt) = current {
            result.push_str(&format!(
                "Candidate revision {} · Agent delegation {}\n",
                attempt.revision, attempt.delegation
            ));
            if let Some(candidate) = &attempt.candidate {
                result.push_str(&format!(
                    "{:?}\n\n{}\n",
                    candidate.outcome, candidate.content
                ));
                if !candidate.evidence.is_empty() {
                    result.push_str(&format!("\nEvidence:\n{}\n", candidate.evidence.join("\n")));
                }
                if self.mode == Mode::Develop
                    && self.status == Status::Active
                    && matches!(candidate.outcome, Outcome::Ready | Outcome::Passed)
                {
                    result.push_str(&format!(
                        "\nAccept this exact candidate: /develop accept {}",
                        attempt.revision
                    ));
                }
                if candidate.outcome == Outcome::NeedsUserDecision {
                    result.push_str("\nAnswer: /develop resume <your decision>");
                }
            } else {
                result.push_str("Agent running. Read progress with /team status or /develop status for this mode.");
            }
        }
        result
    }
}

pub(crate) fn invalid(message: &str) -> CoreError {
    CoreError::InvalidInput(message.into())
}
