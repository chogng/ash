use super::policy_feedback::denied_feedback;
use super::policy_feedback::safer_action_feedback;
use crate::ActionPolicyService;
use crate::AutoReviewedToolGrant;
use crate::CoreError;
use crate::ExecPolicyToolGrant;
use crate::PermissionBypassToolGrant;
use crate::RecordToolResultRequest;
use crate::RequestTurnInteraction;
use crate::SandboxDenialOutput;
use crate::ThreadController;
use crate::ThreadUpdateSink;
use crate::ToolAuthorization;
use crate::ToolCallOutput;
use crate::ToolExecutionFacts;
use crate::ToolExecutionOutput;
use crate::ToolInteractionService;
use crate::ToolOutputSink;
use crate::ToolReplaySafety;
use crate::ToolService;
use crate::ToolUserInputOutcome;
use crate::TurnExecutionObserver;
use crate::TurnToolExecutionFinished;
use crate::TurnToolExecutionStarted;
use crate::action_policy_service::durable_sandbox_escalation_approval_request;
use crate::thread_controller::RecordToolExecutionEscalation;
use crate::thread_controller::RecordToolExecutionStart;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::CapabilityKind;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::SandboxDenialEvidence;
use ash_async_utils::CancellationToken;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::ApprovalMode;
use ash_protocol::ItemId;
use ash_protocol::RequestUserInput;
use ash_protocol::StreamCursor;
use ash_protocol::StreamInstanceId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolExecutionAuthority;
use ash_protocol::ToolExecutionAuthority::Sandboxed;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use std::sync::Arc;

const MAX_DENIAL_REASON_CHARS: usize = 500;
const MAX_DENIAL_OUTPUT_CHARS: usize = 2_000;

pub(super) enum ToolExecutionCompletion {
    Complete,
    PolicyRejected,
    WaitingForApproval,
}

pub(super) struct ToolExecutionContext<'a> {
    session_id: &'a ash_protocol::SessionId,
    thread_id: &'a ThreadId,
    turn_id: &'a TurnId,
    item_id: &'a ItemId,
    frozen_policy_revision: &'a str,
    approval_mode: ApprovalMode,
    cancellation: &'a CancellationToken,
}

impl<'a> ToolExecutionContext<'a> {
    pub(super) fn new(
        session_id: &'a ash_protocol::SessionId,
        thread_id: &'a ThreadId,
        turn_id: &'a TurnId,
        item_id: &'a ItemId,
        frozen_policy_revision: &'a str,
        approval_mode: ApprovalMode,
        cancellation: &'a CancellationToken,
    ) -> Self {
        Self {
            session_id,
            thread_id,
            turn_id,
            item_id,
            frozen_policy_revision,
            approval_mode,
            cancellation,
        }
    }

    pub(super) fn thread_id(&self) -> &ThreadId {
        self.thread_id
    }

    pub(super) fn session_id(&self) -> &ash_protocol::SessionId {
        self.session_id
    }

    pub(super) fn turn_id(&self) -> &TurnId {
        self.turn_id
    }

    pub(super) fn item_id(&self) -> &ItemId {
        self.item_id
    }

    pub(super) fn cancellation(&self) -> &CancellationToken {
        self.cancellation
    }
}

enum ToolAttempt {
    Commit {
        output: ToolCallOutput,
        completion: ToolExecutionCompletion,
    },
    WaitingForApproval,
}

pub(super) struct ToolExecutionOrchestrator {
    threads: Arc<ThreadController>,
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
    updates: Arc<dyn ThreadUpdateSink>,
    execution_observer: Arc<dyn TurnExecutionObserver>,
}

impl ToolExecutionOrchestrator {
    pub(super) fn new(
        threads: Arc<ThreadController>,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
        updates: Arc<dyn ThreadUpdateSink>,
        execution_observer: Arc<dyn TurnExecutionObserver>,
    ) -> Self {
        Self {
            threads,
            tools,
            policy,
            updates,
            execution_observer,
        }
    }

    pub(super) fn execute(
        &self,
        context: &ToolExecutionContext<'_>,
        call: ToolCall,
        reviewed: &ActionReviewRequest,
        authorization: ToolAuthorization,
    ) -> Result<ToolExecutionCompletion, CoreError> {
        self.threads.record_tool_execution_started(
            context.thread_id,
            context.turn_id,
            RecordToolExecutionStart {
                tool_call_id: call.id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                authority: execution_authority(&authorization),
            },
        )?;

        if let Err(error) = self
            .execution_observer
            .tool_will_execute(&TurnToolExecutionStarted {
                session_id: context.session_id.clone(),
                thread_id: context.thread_id.clone(),
                turn_id: context.turn_id.clone(),
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
                write_capable: reviewed
                    .action()
                    .required_capabilities()
                    .iter()
                    .any(|capability| capability.kind() == &CapabilityKind::FileWrite),
            })
        {
            self.threads.record_tool_result(
                context.thread_id,
                context.turn_id,
                RecordToolResultRequest {
                    tool_call_id: call.id,
                    output: ToolCallOutput::Failure(error.to_string()),
                },
            )?;
            return Ok(ToolExecutionCompletion::Complete);
        }

        let (output, completion) =
            match self.execute_initial_attempt(context, &call, reviewed, authorization) {
                Ok(ToolAttempt::WaitingForApproval) => {
                    return Ok(ToolExecutionCompletion::WaitingForApproval);
                }
                Ok(ToolAttempt::Commit { output, completion }) => (output, completion),
                Err(error @ CoreError::Cancelled(_)) => return Err(error),
                Err(error) => (
                    ToolCallOutput::Failure(format!(
                        "tool execution outcome is unknown after execution started: {error}"
                    )),
                    ToolExecutionCompletion::Complete,
                ),
            };
        self.threads.record_tool_result(
            context.thread_id,
            context.turn_id,
            RecordToolResultRequest {
                tool_call_id: call.id,
                output,
            },
        )?;
        Ok(completion)
    }

    /// Executes one Core-owned control Tool while retaining the ordinary durable start/result
    /// boundary. The operation itself runs only after the start fact is committed.
    pub(super) fn execute_core_control(
        &self,
        context: &ToolExecutionContext<'_>,
        call: ToolCall,
        reviewed: &ActionReviewRequest,
        authorization: ToolAuthorization,
        operation: impl FnOnce() -> Result<ToolExecutionOutput, CoreError>,
    ) -> Result<ToolExecutionCompletion, CoreError> {
        self.threads.record_tool_execution_started(
            context.thread_id,
            context.turn_id,
            RecordToolExecutionStart {
                tool_call_id: call.id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                authority: execution_authority(&authorization),
            },
        )?;
        let output = match operation() {
            Ok(output) => output,
            Err(error @ CoreError::Cancelled(_)) => return Err(error),
            Err(error) => ToolExecutionOutput::OutcomeUnknown(format!(
                "Code Mode control failed after execution started: {error}"
            )),
        };
        self.complete_execution_interaction(context, call, output)
    }

    pub(super) fn start_execution_interaction(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        reviewed: &ActionReviewRequest,
        authorization: &ToolAuthorization,
    ) -> Result<(), CoreError> {
        self.threads.record_tool_execution_started(
            context.thread_id,
            context.turn_id,
            RecordToolExecutionStart {
                tool_call_id: call.id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                authority: execution_authority(authorization),
            },
        )?;
        Ok(())
    }

    pub(super) fn complete_execution_interaction(
        &self,
        context: &ToolExecutionContext<'_>,
        call: ToolCall,
        output: ToolExecutionOutput,
    ) -> Result<ToolExecutionCompletion, CoreError> {
        let output = match output {
            ToolExecutionOutput::Success(text) => ToolCallOutput::Success(text),
            ToolExecutionOutput::Failure(text) => ToolCallOutput::Failure(text),
            ToolExecutionOutput::SuccessContent(content) => ToolCallOutput::SuccessContent(content),
            ToolExecutionOutput::FailureContent(content) => ToolCallOutput::FailureContent(content),
            ToolExecutionOutput::OutcomeUnknown(reason) => ToolCallOutput::Failure(format!(
                "dynamic tool execution outcome is unknown: {reason}"
            )),
            ToolExecutionOutput::SandboxDenied(denial) => ToolCallOutput::Failure(format!(
                "dynamic tool interaction returned an invalid sandbox denial: {}",
                denial.reason()
            )),
        };
        self.threads.record_tool_result(
            context.thread_id,
            context.turn_id,
            RecordToolResultRequest {
                tool_call_id: call.id,
                output,
            },
        )?;
        Ok(ToolExecutionCompletion::Complete)
    }

    pub(super) fn execute_approved_escalation(
        &self,
        context: &ToolExecutionContext<'_>,
        call: ToolCall,
        reviewed: &ActionReviewRequest,
        denial: SandboxDenialOutput,
        authorization: ToolAuthorization,
    ) -> Result<ToolExecutionCompletion, CoreError> {
        context
            .cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        self.threads.record_tool_execution_escalated(
            context.thread_id,
            context.turn_id,
            RecordToolExecutionEscalation {
                tool_call_id: call.id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                denial,
                authority: execution_authority(&authorization),
            },
        )?;
        let output = match self.execute_service(context, &call, &authorization) {
            Ok(ToolExecutionOutput::Success(text)) => ToolCallOutput::Success(text),
            Ok(ToolExecutionOutput::Failure(text)) => ToolCallOutput::Failure(text),
            Ok(ToolExecutionOutput::SuccessContent(content)) => {
                ToolCallOutput::SuccessContent(content)
            }
            Ok(ToolExecutionOutput::FailureContent(content)) => {
                ToolCallOutput::FailureContent(content)
            }
            Ok(ToolExecutionOutput::OutcomeUnknown(reason)) => ToolCallOutput::Failure(format!(
                "approved outside-sandbox retry outcome is unknown: {reason}"
            )),
            Ok(ToolExecutionOutput::SandboxDenied(denial)) => ToolCallOutput::Failure(format!(
                "tool service reported a sandbox denial during an approved outside-sandbox \
                 retry: {}",
                denial.reason()
            )),
            Err(error @ CoreError::Cancelled(_)) => return Err(error),
            Err(error) => ToolCallOutput::Failure(format!(
                "approved outside-sandbox retry outcome is unknown after execution started: \
                 {error}"
            )),
        };
        self.threads.record_tool_result(
            context.thread_id,
            context.turn_id,
            RecordToolResultRequest {
                tool_call_id: call.id,
                output,
            },
        )?;
        Ok(ToolExecutionCompletion::Complete)
    }

    fn execute_initial_attempt(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        reviewed: &ActionReviewRequest,
        authorization: ToolAuthorization,
    ) -> Result<ToolAttempt, CoreError> {
        let result = self.execute_service(context, call, &authorization);
        match result {
            Ok(ToolExecutionOutput::Success(text)) => Ok(ToolAttempt::Commit {
                output: ToolCallOutput::Success(text),
                completion: ToolExecutionCompletion::Complete,
            }),
            Ok(ToolExecutionOutput::Failure(text)) => Ok(ToolAttempt::Commit {
                output: ToolCallOutput::Failure(text),
                completion: ToolExecutionCompletion::Complete,
            }),
            Ok(ToolExecutionOutput::SuccessContent(content)) => Ok(ToolAttempt::Commit {
                output: ToolCallOutput::SuccessContent(content),
                completion: ToolExecutionCompletion::Complete,
            }),
            Ok(ToolExecutionOutput::FailureContent(content)) => Ok(ToolAttempt::Commit {
                output: ToolCallOutput::FailureContent(content),
                completion: ToolExecutionCompletion::Complete,
            }),
            Ok(ToolExecutionOutput::OutcomeUnknown(reason)) => Ok(ToolAttempt::Commit {
                output: ToolCallOutput::Failure(format!(
                    "tool execution outcome is unknown: {reason}"
                )),
                completion: ToolExecutionCompletion::Complete,
            }),
            Ok(ToolExecutionOutput::SandboxDenied(denial)) => {
                if !matches!(authorization, ToolAuthorization::Sandboxed(_)) {
                    return Ok(ToolAttempt::Commit {
                        output: ToolCallOutput::Failure(format!(
                            "tool service reported a sandbox denial for an execution that was not \
                             sandboxed: {}",
                            denial.reason()
                        )),
                        completion: ToolExecutionCompletion::Complete,
                    });
                }
                if denial.replay_safety() == ToolReplaySafety::MayHaveSideEffects {
                    return Ok(ToolAttempt::Commit {
                        output: ToolCallOutput::Failure(format!(
                            "sandbox denied the action, but the attempt may have produced side \
                             effects, so the exact call was not retried; reason: {}; output: {}",
                            denial.reason(),
                            denial.output().aggregated_output()
                        )),
                        completion: ToolExecutionCompletion::Complete,
                    });
                }
                self.review_denial_and_retry(context, call, reviewed, denial)
            }
            Err(error) => Err(error),
        }
    }

    fn execute_service(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        authorization: &ToolAuthorization,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let snapshot = self.threads.read_thread(context.thread_id)?;
        let facts = ToolExecutionFacts::for_turn(
            &snapshot,
            context.turn_id,
            self.tools
                .definitions()
                .into_iter()
                .map(|definition| definition.name),
        )?;
        let mut stream = ToolUpdateStream {
            updates: self.updates.as_ref(),
            session_id: snapshot.session_id,
            thread_id: context.thread_id.clone(),
            turn_id: context.turn_id.clone(),
            tool_call_id: call.id.clone(),
            durable_sequence: snapshot.sequence,
            stream_instance_id: self.threads.next_stream_instance_id(),
            next_sequence: 0,
        };
        let interactions: Arc<dyn ToolInteractionService> = Arc::new(CoreToolInteractions {
            threads: Arc::clone(&self.threads),
            updates: Arc::clone(&self.updates),
            thread_id: context.thread_id.clone(),
            turn_id: context.turn_id.clone(),
            item_id: context.item_id.clone(),
            cancellation: context.cancellation.clone(),
            policy: Arc::clone(&self.policy),
            frozen_policy_revision: context.frozen_policy_revision.to_owned(),
            approval_mode: context.approval_mode,
            source_id: call.name.as_str().to_owned(),
        });
        let before_sequence = snapshot.sequence;
        let output = self.tools.execute_streaming_with_facts_and_interactions(
            call,
            authorization,
            context.cancellation,
            &facts,
            interactions,
            &mut stream,
        );
        let outcome_unknown = match &output {
            Err(_) | Ok(ToolExecutionOutput::OutcomeUnknown(_)) => true,
            Ok(ToolExecutionOutput::SandboxDenied(denial)) => {
                denial.replay_safety() == ToolReplaySafety::MayHaveSideEffects
            }
            Ok(_) => false,
        };
        self.execution_observer
            .tool_did_finish(&TurnToolExecutionFinished {
                session_id: context.session_id.clone(),
                thread_id: context.thread_id.clone(),
                turn_id: context.turn_id.clone(),
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
                outcome_unknown,
            });
        for update in self
            .threads
            .thread_updates_after(context.thread_id, before_sequence)?
        {
            self.updates.publish(update);
        }
        output
    }

    fn review_denial_and_retry(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        reviewed: &ActionReviewRequest,
        denial: SandboxDenialOutput,
    ) -> Result<ToolAttempt, CoreError> {
        let denial_reason = truncate(denial.reason(), MAX_DENIAL_REASON_CHARS);
        let denial_output = truncate(denial.output().aggregated_output(), MAX_DENIAL_OUTPUT_CHARS);
        let second_review = reviewed
            .clone()
            .after_sandbox_denial(SandboxDenialEvidence::new(
                denial_reason.clone(),
                denial_output,
            ));
        let decision = match crate::decide_turn_action(
            self.policy.as_ref(),
            context.frozen_policy_revision,
            context.approval_mode,
            &second_review,
            context.cancellation,
        ) {
            Ok(decision) => decision,
            Err(error @ CoreError::Cancelled(_)) => return Err(error),
            Err(error) => {
                return Ok(ToolAttempt::Commit {
                    output: ToolCallOutput::Failure(format!(
                        "sandbox denied the action and secondary review failed closed; the exact \
                         call was not retried: {error}"
                    )),
                    completion: ToolExecutionCompletion::Complete,
                });
            }
        };

        let authorization = match decision {
            ExecutionDecision::RunUnsandboxed { grant_id } => {
                ToolAuthorization::UnsandboxedGrant { grant_id }
            }
            ExecutionDecision::RunExecPolicyGranted(grant) => {
                if !grant.matches(
                    reviewed.action().digest(),
                    reviewed.action().required_capabilities(),
                    reviewed.action_policy_revision(),
                ) {
                    return Err(CoreError::Policy(
                        "execution-policy retry grant is not bound to the prepared action".into(),
                    ));
                }
                ToolAuthorization::ExecPolicyGranted(ExecPolicyToolGrant::new(
                    call.id.clone(),
                    grant,
                ))
            }
            ExecutionDecision::RunAutoReviewed(grant) => {
                if !grant.matches(
                    reviewed.action().digest(),
                    reviewed.action().required_capabilities(),
                    reviewed.action_policy_revision(),
                ) {
                    return Err(CoreError::Policy(
                        "automatic-review retry grant is not bound to the prepared action".into(),
                    ));
                }
                ToolAuthorization::AutoReviewed(AutoReviewedToolGrant::new(call.id.clone(), grant))
            }
            ExecutionDecision::RunWithPermissionBypass(grant) => {
                if !grant.matches(
                    reviewed.action().digest(),
                    reviewed.action().required_capabilities(),
                    reviewed.action_policy_revision(),
                ) {
                    return Err(CoreError::Policy(
                        "permission-bypass retry grant is not bound to the prepared action".into(),
                    ));
                }
                ToolAuthorization::PermissionBypassed(PermissionBypassToolGrant::new(
                    call.id.clone(),
                    grant,
                ))
            }
            ExecutionDecision::RunSandboxed(_) => {
                return Ok(ToolAttempt::Commit {
                    output: ToolCallOutput::Failure(
                        "sandbox-denial review did not authorize execution outside the sandbox; \
                         the exact call was not retried"
                            .into(),
                    ),
                    completion: ToolExecutionCompletion::Complete,
                });
            }
            ExecutionDecision::ReviseAction(revision) => {
                return Ok(ToolAttempt::Commit {
                    output: ToolCallOutput::Failure(safer_action_feedback(&revision)),
                    completion: ToolExecutionCompletion::PolicyRejected,
                });
            }
            ExecutionDecision::AskUser(approval) => {
                let request =
                    durable_sandbox_escalation_approval_request(&second_review, &approval, denial)?;
                self.threads.request_turn_interaction(
                    context.thread_id,
                    context.turn_id,
                    RequestTurnInteraction {
                        request_id: self.threads.next_interaction_request_id(),
                        item_id: Some(context.item_id.clone()),
                        request: AgentRequest::Approval { request },
                        deadline: None,
                    },
                )?;
                return Ok(ToolAttempt::WaitingForApproval);
            }
            ExecutionDecision::Block(reason) => {
                let feedback = denied_feedback(&reason);
                let completion = if feedback.is_some() {
                    ToolExecutionCompletion::PolicyRejected
                } else {
                    ToolExecutionCompletion::Complete
                };
                return Ok(ToolAttempt::Commit {
                    output: ToolCallOutput::Failure(feedback.unwrap_or_else(|| {
                        format!(
                            "sandbox denied the action and policy blocked an outside-sandbox \
                             retry: {reason:?}"
                        )
                    })),
                    completion,
                });
            }
        };

        context
            .cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let authority = execution_authority(&authorization);
        self.threads.record_tool_execution_escalated(
            context.thread_id,
            context.turn_id,
            RecordToolExecutionEscalation {
                tool_call_id: call.id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                denial,
                authority,
            },
        )?;

        let output = match self.execute_service(context, call, &authorization) {
            Ok(ToolExecutionOutput::Success(text)) => ToolCallOutput::Success(text),
            Ok(ToolExecutionOutput::Failure(text)) => ToolCallOutput::Failure(text),
            Ok(ToolExecutionOutput::SuccessContent(content)) => {
                ToolCallOutput::SuccessContent(content)
            }
            Ok(ToolExecutionOutput::FailureContent(content)) => {
                ToolCallOutput::FailureContent(content)
            }
            Ok(ToolExecutionOutput::OutcomeUnknown(reason)) => ToolCallOutput::Failure(format!(
                "outside-sandbox retry outcome is unknown: {reason}"
            )),
            Ok(ToolExecutionOutput::SandboxDenied(denial)) => ToolCallOutput::Failure(format!(
                "tool service reported another sandbox denial after outside-sandbox \
                     authorization: {}",
                denial.reason()
            )),
            Err(error) => return Err(error),
        };
        Ok(ToolAttempt::Commit {
            output,
            completion: ToolExecutionCompletion::Complete,
        })
    }
}

struct CoreToolInteractions {
    threads: Arc<ThreadController>,
    updates: Arc<dyn ThreadUpdateSink>,
    thread_id: ThreadId,
    turn_id: TurnId,
    item_id: ItemId,
    cancellation: CancellationToken,
    policy: Arc<dyn crate::ActionPolicyService>,
    frozen_policy_revision: String,
    approval_mode: ApprovalMode,
    source_id: String,
}

impl ToolInteractionService for CoreToolInteractions {
    fn approve_network(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ActionApprovalDecision, CoreError> {
        use ash_protocol::ActionApprovalDecision;
        self.cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.to_string()))?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.to_string()))?;
        if request.action().kind() != &ash_action_policy::ActionKind::NetworkRequest
            || !matches!(
                request.phase(),
                ash_action_policy::ActionReviewPhase::Initial
            )
            || request.provenance().source_id() != self.source_id
            || request.action().required_capabilities().iter().count() != 1
            || request
                .action()
                .required_capabilities()
                .iter()
                .any(|capability| capability.kind() != &CapabilityKind::Network)
            || !matches!(
                request.sandbox(),
                ash_action_policy::SandboxCompatibility::NotApplicable { .. }
            )
        {
            return Err(CoreError::Policy(
                "live network review must describe exactly one network capability for this tool"
                    .into(),
            ));
        }
        let decision = crate::decide_turn_action(
            self.policy.as_ref(),
            &self.frozen_policy_revision,
            self.approval_mode,
            request,
            cancellation,
        )?;
        match decision {
            ExecutionDecision::RunExecPolicyGranted(grant)
                if grant.matches(
                    request.action().digest(),
                    request.action().required_capabilities(),
                    request.action_policy_revision(),
                ) =>
            {
                Ok(ActionApprovalDecision::ApproveOnce)
            }
            ExecutionDecision::RunAutoReviewed(grant)
                if grant.matches(
                    request.action().digest(),
                    request.action().required_capabilities(),
                    request.action_policy_revision(),
                ) =>
            {
                Ok(ActionApprovalDecision::ApproveOnce)
            }
            ExecutionDecision::RunWithPermissionBypass(grant)
                if grant.matches(
                    request.action().digest(),
                    request.action().required_capabilities(),
                    request.action_policy_revision(),
                ) =>
            {
                Ok(ActionApprovalDecision::ApproveOnce)
            }
            ExecutionDecision::RunUnsandboxed { .. } => Ok(ActionApprovalDecision::ApproveOnce),
            ExecutionDecision::AskUser(approval) => {
                let request =
                    crate::action_policy_service::durable_approval_request(request, &approval)?;
                match self.request_live(AgentRequest::Approval { request }, cancellation)? {
                    crate::thread_controller::live_interaction::LiveInteractionOutcome::Response(AgentResponse::Approval { response }) => Ok(response.decision),
                    crate::thread_controller::live_interaction::LiveInteractionOutcome::Cancelled(_) => Ok(ActionApprovalDecision::Decline),
                    _ => Err(CoreError::Journal("network approval resolved with the wrong response kind".into())),
                }
            }
            _ => Ok(ActionApprovalDecision::Decline),
        }
    }

    fn request_user_input(
        &self,
        request: RequestUserInput,
    ) -> Result<ToolUserInputOutcome, CoreError> {
        match self.request_live(AgentRequest::UserInput { request }, &self.cancellation)? {
            crate::thread_controller::live_interaction::LiveInteractionOutcome::Response(
                AgentResponse::UserInput { response },
            ) => Ok(ToolUserInputOutcome::Answered(response)),
            crate::thread_controller::live_interaction::LiveInteractionOutcome::Cancelled(
                reason,
            ) => Ok(ToolUserInputOutcome::Cancelled(reason)),
            _ => Err(CoreError::Journal(
                "live Tool user-input interaction resolved with the wrong response kind".into(),
            )),
        }
    }
}

impl CoreToolInteractions {
    fn request_live(
        &self,
        request: AgentRequest,
        cancellation: &CancellationToken,
    ) -> Result<crate::thread_controller::live_interaction::LiveInteractionOutcome, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.to_string()))?;
        self.cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let request_id = self.threads.next_interaction_request_id();
        let key = crate::thread_controller::live_interaction::LiveInteractionKey {
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            request_id: request_id.clone(),
        };
        let waiter = self.threads.live_interactions.register(key)?;
        let before_sequence = self.threads.read_thread(&self.thread_id)?.sequence;
        self.threads.request_turn_interaction(
            &self.thread_id,
            &self.turn_id,
            RequestTurnInteraction {
                request_id: request_id.clone(),
                item_id: Some(self.item_id.clone()),
                request,
                deadline: None,
            },
        )?;
        for update in self
            .threads
            .thread_updates_after(&self.thread_id, before_sequence)?
        {
            self.updates.publish(update);
        }
        let outcome = waiter.wait(cancellation);
        if outcome.is_err() {
            let snapshot = self.threads.read_thread(&self.thread_id)?;
            if snapshot.turns.iter().any(|turn| {
                turn.turn_id == self.turn_id
                    && turn
                        .pending_interaction
                        .as_ref()
                        .is_some_and(|pending| pending.request_id == request_id)
            }) {
                self.threads.cancel_turn_interaction(
                    &self.thread_id,
                    crate::CancelTurnInteractionRequest {
                        turn_id: self.turn_id.clone(),
                        request_id,
                        reason: ash_protocol::InteractionCancelReason::OwnerDisconnected,
                    },
                )?;
                for update in self
                    .threads
                    .thread_updates_after(&self.thread_id, snapshot.sequence)?
                {
                    self.updates.publish(update);
                }
            }
        }
        outcome
    }
}

struct ToolUpdateStream<'a> {
    updates: &'a dyn ThreadUpdateSink,
    session_id: ash_protocol::SessionId,
    thread_id: ThreadId,
    turn_id: TurnId,
    tool_call_id: ToolCallId,
    durable_sequence: u64,
    stream_instance_id: StreamInstanceId,
    next_sequence: u64,
}

impl ToolOutputSink for ToolUpdateStream<'_> {
    fn emit(&mut self, stream: ToolOutputStream, text: String) -> Result<(), CoreError> {
        if text.is_empty() {
            return Ok(());
        }
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.updates.publish(ThreadUpdateEnvelope {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            durable_sequence: self.durable_sequence,
            stream_cursor: Some(StreamCursor {
                stream_instance_id: self.stream_instance_id.clone(),
                sequence: self.next_sequence,
            }),
            update: ThreadUpdate::ToolOutputDelta {
                turn_id: self.turn_id.clone(),
                tool_call_id: self.tool_call_id.clone(),
                stream,
                text,
            },
        });
        Ok(())
    }
}

fn execution_authority(authorization: &ToolAuthorization) -> ToolExecutionAuthority {
    match authorization {
        ToolAuthorization::Sandboxed(_) => Sandboxed,
        ToolAuthorization::UnsandboxedGrant { grant_id } => {
            ToolExecutionAuthority::UnsandboxedGrant {
                grant_id: grant_id.as_str().to_owned(),
            }
        }
        ToolAuthorization::ExecPolicyGranted(grant) => ToolExecutionAuthority::ExecPolicyGranted {
            layer_id: grant.policy_grant().source().layer_id().as_str().to_owned(),
            rule_id: grant.policy_grant().source().rule_id().as_str().to_owned(),
            exec_policy_revision: grant
                .policy_grant()
                .exec_policy_revision()
                .as_str()
                .to_owned(),
        },
        ToolAuthorization::AutoReviewed(grant) => ToolExecutionAuthority::AutoReviewed {
            assessment_id: grant.policy_grant().assessment_id().as_str().to_owned(),
        },
        ToolAuthorization::PermissionBypassed(_) => ToolExecutionAuthority::PermissionBypassed,
        ToolAuthorization::ApprovedOnce(grant) => ToolExecutionAuthority::ApprovedOnce {
            request_id: grant.request_id().clone(),
        },
    }
}

fn truncate(value: &str, maximum_chars: usize) -> String {
    if value.chars().count() <= maximum_chars {
        return value.to_owned();
    }
    let mut truncated = value.chars().take(maximum_chars).collect::<String>();
    truncated.push('…');
    truncated
}
