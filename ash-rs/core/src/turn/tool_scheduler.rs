use super::code_mode::CodeModeBroker;
use super::policy_feedback::denied_feedback;
use super::policy_feedback::rejection_circuit_breaker;
use super::policy_feedback::safer_action_feedback;
use super::review_context::attach_review_context;
use super::tool_execution::ToolExecutionCompletion;
use super::tool_execution::ToolExecutionContext;
use super::tool_execution::ToolExecutionOrchestrator;
use crate::ActionPolicyService;
use crate::AfterToolHookRequest;
use crate::AutoReviewedToolGrant;
use crate::BeforeToolHookDecision;
use crate::BeforeToolHookRequest;
use crate::CoreError;
use crate::ExecPolicyToolGrant;
use crate::HookOutcome;
use crate::HookService;
use crate::NoHooks;
use crate::NoThreadUpdates;
use crate::OneTimeToolGrant;
use crate::PermissionBypassToolGrant;
use crate::RecordToolResultRequest;
use crate::RequestTurnInteraction;
use crate::ThreadController;
use crate::ThreadSnapshot;
use crate::ThreadUpdateSink;
use crate::ToolAuthorization;
use crate::ToolCallOutput;
use crate::ToolExecutionFacts;
use crate::ToolService;
use crate::TurnExecutionObserver;
use crate::action_policy_service::approval_matches_review;
use crate::durable_approval_request;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;
use ash_protocol::ActionApprovalDecision;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::ItemId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ToolSchedulingProgress {
    Complete,
    WaitingForApproval,
    WaitingForCapability,
}

pub(super) struct ToolScheduler {
    threads: Arc<ThreadController>,
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
    hooks: Arc<dyn HookService>,
    updates: Arc<dyn ThreadUpdateSink>,
    code_mode: Option<CodeModeBroker>,
    harness_context: Option<Arc<dyn crate::HarnessContextProvider>>,
    execution_observer: Arc<dyn TurnExecutionObserver>,
}

impl ToolScheduler {
    pub(super) fn new(
        threads: Arc<ThreadController>,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        Self {
            threads,
            tools,
            policy,
            hooks: Arc::new(NoHooks),
            updates: Arc::new(NoThreadUpdates),
            code_mode: None,
            harness_context: None,
            execution_observer: Arc::new(crate::NoTurnExecutionObserver),
        }
    }

    pub(super) fn with_harness_context(
        mut self,
        provider: Arc<dyn crate::HarnessContextProvider>,
    ) -> Self {
        self.harness_context = Some(provider);
        self
    }

    pub(super) fn with_thread_updates(mut self, updates: Arc<dyn ThreadUpdateSink>) -> Self {
        self.updates = updates;
        self
    }

    pub(super) fn with_hooks(mut self, hooks: Arc<dyn HookService>) -> Self {
        self.hooks = hooks;
        self
    }

    pub(super) fn with_code_mode(mut self, code_mode: CodeModeBroker) -> Self {
        self.code_mode = Some(code_mode);
        self
    }

    pub(super) fn with_execution_observer(
        mut self,
        observer: Arc<dyn TurnExecutionObserver>,
    ) -> Self {
        self.execution_observer = observer;
        self
    }

    pub(super) fn run_pending(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<ToolSchedulingProgress, CoreError> {
        self.run_pending_matching(thread_id, turn_id, None, cancellation)
    }

    /// Runs only one durable Tool Call.
    ///
    /// Code Mode uses this entry point for a nested call so it cannot recursively consume the
    /// model-facing `exec` call or unrelated work already queued on the same Turn.
    #[cfg(feature = "code-mode")]
    pub(super) fn run_pending_for_call(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        tool_call_id: &ToolCallId,
        cancellation: &CancellationToken,
    ) -> Result<ToolSchedulingProgress, CoreError> {
        self.run_pending_matching(thread_id, turn_id, Some(tool_call_id), cancellation)
    }

    fn run_pending_matching(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        target_tool_call_id: Option<&ToolCallId>,
        cancellation: &CancellationToken,
    ) -> Result<ToolSchedulingProgress, CoreError> {
        loop {
            cancellation
                .check()
                .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
            let snapshot = self.threads.read_thread(thread_id)?;
            if let Some(streak) =
                crate::tool_repetition::project_tool_failures(&snapshot.items, turn_id)?.active()
                && streak.count >= crate::tool_repetition::TOOL_REPETITION_FAILURE_THRESHOLD
            {
                return Err(CoreError::ToolRepetition(format!(
                    "{} with arguments digest {} failed {} consecutive times",
                    streak.tool_name, streak.arguments_digest, streak.count
                )));
            }
            let Some(pending) = next_pending_call(&snapshot.items, turn_id, target_tool_call_id)?
            else {
                return Ok(ToolSchedulingProgress::Complete);
            };
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            let control_broker = self.code_mode.as_ref().filter(|broker| {
                broker.owns_control_binding(&pending.call, pending.binding.as_ref())
            });
            let binding_validation = match control_broker {
                Some(broker) if turn.tool_mode.requires_code_mode() => {
                    broker.validate_control_binding(&pending.call, pending.binding.as_ref())
                }
                Some(_) => Err(CoreError::Policy(
                    "Code Mode control Tool Call is unavailable for this Turn".into(),
                )),
                None => self
                    .tools
                    .validate_call_binding(&pending.call, pending.binding.as_ref()),
            };
            if let Err(error) = binding_validation {
                let message = if snapshot.started_tool_calls.contains(&pending.call.id) {
                    format!(
                        "tool execution outcome is unknown after its durable binding became unavailable: {error}"
                    )
                } else {
                    format!("durable tool binding is unavailable: {error}")
                };
                self.record_failure(thread_id, turn_id, pending.call.id, message)?;
                continue;
            }
            if !snapshot.started_tool_calls.contains(&pending.call.id)
                && let Some(provider) = &self.harness_context
            {
                let boundary = match pending.binding.as_ref().map(|binding| &binding.caller) {
                    Some(ash_protocol::ToolCallCaller::CodeMode {
                        parent_tool_call_id,
                        ..
                    }) => parent_tool_call_id,
                    _ => &pending.call.id,
                };
                let paths = crate::services::read_paths_before_call(&snapshot, turn_id, boundary);
                let request = crate::HarnessContextRequest {
                    session_id: &snapshot.session_id,
                    thread_id,
                    turn_id,
                    read_paths: &paths,
                };
                match provider.validate_tool_context(&request, &pending.call) {
                    Ok(()) => {}
                    Err(CoreError::InvalidInput(message)) => {
                        self.record_failure(thread_id, turn_id, pending.call.id, message)?;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            let frozen_policy_revision = turn.policy_revision.as_str();
            let approval_mode = turn.approval_mode;
            let execution = ToolExecutionContext::new(
                &snapshot.session_id,
                thread_id,
                turn_id,
                &pending.item_id,
                frozen_policy_revision,
                approval_mode,
                cancellation,
            );

            if snapshot.started_tool_calls.contains(&pending.call.id)
                && let Some((request, response)) = resolved_execution_interaction(
                    &snapshot.resolved_interactions,
                    turn_id,
                    &pending.item_id,
                    &pending.call,
                )
            {
                let output = self
                    .tools
                    .resolve_execution_interaction(&pending.call, request, response)?
                    .ok_or_else(|| {
                        CoreError::Execution(format!(
                            "resolved execution interaction is not owned by tool {}",
                            pending.call.name
                        ))
                    })?;
                ToolExecutionOrchestrator::new(
                    Arc::clone(&self.threads),
                    Arc::clone(&self.tools),
                    Arc::clone(&self.policy),
                    Arc::clone(&self.updates),
                    Arc::clone(&self.execution_observer),
                )
                .complete_execution_interaction(
                    &execution,
                    pending.call,
                    output,
                )?;
                continue;
            }

            if let Some((request_id, request, decision)) =
                resolved_approval(&snapshot.resolved_interactions, turn_id, &pending.item_id)
            {
                match decision {
                    ActionApprovalDecision::Decline => {
                        self.record_failure(
                            thread_id,
                            turn_id,
                            pending.call.id,
                            "user declined the requested one-time tool authorization",
                        )?;
                    }
                    ActionApprovalDecision::ApproveOnce => {
                        let Some(reviewed) = self.prepare_review_or_record_failure(
                            &snapshot,
                            turn_id,
                            &pending.item_id,
                            &pending.call,
                        )?
                        else {
                            continue;
                        };
                        if !approval_matches_review(request, &reviewed) {
                            self.record_failure(
                                thread_id,
                                turn_id,
                                pending.call.id,
                                "approved action no longer matches the exact prepared tool call",
                            )?;
                            continue;
                        }
                        let authorization = ToolAuthorization::ApprovedOnce(OneTimeToolGrant::new(
                            request_id.clone(),
                            pending.call.id.clone(),
                            request.clone(),
                        ));
                        if let Some(denial) = request.sandbox_denial.clone() {
                            if !snapshot.started_tool_calls.contains(&pending.call.id) {
                                self.record_failure(
                                    thread_id,
                                    turn_id,
                                    pending.call.id,
                                    "sandbox escalation approval does not reference a started Tool Call",
                                )?;
                                continue;
                            }
                            if snapshot.escalated_tool_calls.contains(&pending.call.id) {
                                self.record_failure(
                                    thread_id,
                                    turn_id,
                                    pending.call.id,
                                    "approved outside-sandbox retry outcome is unknown after process interruption; the exact call was not retried",
                                )?;
                                continue;
                            }
                            ToolExecutionOrchestrator::new(
                                Arc::clone(&self.threads),
                                Arc::clone(&self.tools),
                                Arc::clone(&self.policy),
                                Arc::clone(&self.updates),
                                Arc::clone(&self.execution_observer),
                            )
                            .execute_approved_escalation(
                                &execution,
                                pending.call.clone(),
                                &reviewed,
                                denial,
                                authorization,
                            )?;
                            self.run_after_tool(
                                &execution,
                                &pending.call.id,
                                pending.call.name.to_string(),
                            )?;
                        } else if snapshot.started_tool_calls.contains(&pending.call.id) {
                            self.record_failure(
                                thread_id,
                                turn_id,
                                pending.call.id,
                                "tool execution outcome is unknown after process interruption; the exact call was not retried",
                            )?;
                        } else {
                            let progress =
                                self.execute(&execution, pending.call, &reviewed, authorization)?;
                            if progress != ToolSchedulingProgress::Complete {
                                return Ok(progress);
                            }
                        }
                    }
                }
                continue;
            }

            if snapshot.started_tool_calls.contains(&pending.call.id) {
                self.record_failure(
                    thread_id,
                    turn_id,
                    pending.call.id,
                    "tool execution outcome is unknown after process interruption; the exact call was not retried",
                )?;
                continue;
            }

            let Some(reviewed) = self.prepare_review_or_record_failure(
                &snapshot,
                turn_id,
                &pending.item_id,
                &pending.call,
            )?
            else {
                continue;
            };
            match self.policy.decide_for_turn_with_approval_mode(
                frozen_policy_revision,
                approval_mode,
                &reviewed,
                cancellation,
            )? {
                ExecutionDecision::RunSandboxed(sandbox) => {
                    let progress = self.execute(
                        &execution,
                        pending.call,
                        &reviewed,
                        ToolAuthorization::Sandboxed(sandbox),
                    )?;
                    if progress != ToolSchedulingProgress::Complete {
                        return Ok(progress);
                    }
                }
                ExecutionDecision::RunUnsandboxed { grant_id } => {
                    let progress = self.execute(
                        &execution,
                        pending.call,
                        &reviewed,
                        ToolAuthorization::UnsandboxedGrant { grant_id },
                    )?;
                    if progress != ToolSchedulingProgress::Complete {
                        return Ok(progress);
                    }
                }
                ExecutionDecision::RunExecPolicyGranted(grant) => {
                    if !grant.matches(
                        reviewed.action().digest(),
                        reviewed.action().required_capabilities(),
                        reviewed.action_policy_revision(),
                    ) {
                        return Err(CoreError::Policy(
                            "execution-policy grant is not bound to the prepared action".into(),
                        ));
                    }
                    let authorization = ToolAuthorization::ExecPolicyGranted(
                        ExecPolicyToolGrant::new(pending.call.id.clone(), grant),
                    );
                    let progress =
                        self.execute(&execution, pending.call, &reviewed, authorization)?;
                    if progress != ToolSchedulingProgress::Complete {
                        return Ok(progress);
                    }
                }
                ExecutionDecision::RunAutoReviewed(grant) => {
                    if !grant.matches(
                        reviewed.action().digest(),
                        reviewed.action().required_capabilities(),
                        reviewed.action_policy_revision(),
                    ) {
                        return Err(CoreError::Policy(
                            "automatic-review grant is not bound to the prepared action".into(),
                        ));
                    }
                    let authorization = ToolAuthorization::AutoReviewed(
                        AutoReviewedToolGrant::new(pending.call.id.clone(), grant),
                    );
                    let progress =
                        self.execute(&execution, pending.call, &reviewed, authorization)?;
                    if progress != ToolSchedulingProgress::Complete {
                        return Ok(progress);
                    }
                }
                ExecutionDecision::RunWithPermissionBypass(grant) => {
                    if !grant.matches(
                        reviewed.action().digest(),
                        reviewed.action().required_capabilities(),
                        reviewed.action_policy_revision(),
                    ) {
                        return Err(CoreError::Policy(
                            "permission-bypass grant is not bound to the prepared action".into(),
                        ));
                    }
                    let authorization = ToolAuthorization::PermissionBypassed(
                        PermissionBypassToolGrant::new(pending.call.id.clone(), grant),
                    );
                    if matches!(
                        self.execute(&execution, pending.call, &reviewed, authorization)?,
                        ToolSchedulingProgress::WaitingForApproval
                    ) {
                        return Ok(ToolSchedulingProgress::WaitingForApproval);
                    }
                }
                ExecutionDecision::ReviseAction(revision) => {
                    self.record_failure(
                        thread_id,
                        turn_id,
                        pending.call.id,
                        safer_action_feedback(&revision),
                    )?;
                    self.enforce_rejection_circuit_breaker(thread_id, turn_id)?;
                }
                ExecutionDecision::AskUser(approval) => {
                    let request = durable_approval_request(&reviewed, &approval)?;
                    self.threads.request_turn_interaction(
                        thread_id,
                        turn_id,
                        RequestTurnInteraction {
                            request_id: self.threads.next_interaction_request_id(),
                            item_id: Some(pending.item_id),
                            request: AgentRequest::Approval { request },
                            deadline: None,
                        },
                    )?;
                    return Ok(ToolSchedulingProgress::WaitingForApproval);
                }
                ExecutionDecision::Block(reason) => {
                    let feedback = denied_feedback(&reason);
                    self.record_failure(
                        thread_id,
                        turn_id,
                        pending.call.id,
                        feedback.clone().unwrap_or_else(|| {
                            format!("tool execution blocked by policy: {reason:?}")
                        }),
                    )?;
                    if feedback.is_some() {
                        self.enforce_rejection_circuit_breaker(thread_id, turn_id)?;
                    }
                }
            }
        }
    }

    fn prepare_review(
        &self,
        snapshot: &ThreadSnapshot,
        turn_id: &TurnId,
        item_id: &ItemId,
        call: &ToolCall,
    ) -> Result<ash_action_policy::ActionReviewRequest, CoreError> {
        let control_broker = self
            .code_mode
            .as_ref()
            .filter(|broker| broker.owns_control_binding(call, call_binding(snapshot, item_id)));
        let (request, evidence) = match control_broker {
            Some(broker) => (broker.prepare_control(call)?, Vec::new()),
            None => {
                let facts = ToolExecutionFacts::for_turn(
                    snapshot,
                    turn_id,
                    self.tools
                        .definitions()
                        .into_iter()
                        .map(|definition| definition.name),
                )?;
                (
                    self.tools.prepare_with_facts(call, &facts)?,
                    self.tools.review_evidence(call)?,
                )
            }
        };
        Ok(attach_review_context(
            request,
            &snapshot.items,
            turn_id,
            item_id,
            evidence,
        ))
    }

    fn prepare_review_or_record_failure(
        &self,
        snapshot: &ThreadSnapshot,
        turn_id: &TurnId,
        item_id: &ItemId,
        call: &ToolCall,
    ) -> Result<Option<ash_action_policy::ActionReviewRequest>, CoreError> {
        match self.prepare_review(snapshot, turn_id, item_id, call) {
            Ok(review) => Ok(Some(review)),
            Err(error @ (CoreError::InvalidInput(_) | CoreError::Policy(_))) => {
                self.record_failure(
                    &snapshot.thread_id,
                    turn_id,
                    call.id.clone(),
                    format!("tool preparation rejected: {error}"),
                )?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn enforce_rejection_circuit_breaker(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<(), CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        match rejection_circuit_breaker(&snapshot.items, turn_id) {
            Some(reason) => Err(CoreError::PolicyCircuitBreaker(reason)),
            None => Ok(()),
        }
    }

    fn execute(
        &self,
        context: &ToolExecutionContext<'_>,
        call: ToolCall,
        reviewed: &ash_action_policy::ActionReviewRequest,
        authorization: ToolAuthorization,
    ) -> Result<ToolSchedulingProgress, CoreError> {
        let tool_name = call.name.to_string();
        let tool_call_id = call.id.clone();
        let orchestrator = ToolExecutionOrchestrator::new(
            Arc::clone(&self.threads),
            Arc::clone(&self.tools),
            Arc::clone(&self.policy),
            Arc::clone(&self.updates),
            Arc::clone(&self.execution_observer),
        );
        let persisted_binding = self
            .threads
            .read_thread(context.thread_id())?
            .items
            .iter()
            .find_map(|item| match item {
                ThreadItem::ToolCall {
                    item_id, binding, ..
                } if item_id == context.item_id() => binding.clone(),
                _ => None,
            });
        let control_broker = self
            .code_mode
            .as_ref()
            .filter(|broker| broker.owns_control_binding(&call, persisted_binding.as_ref()))
            .cloned();
        if control_broker.is_none()
            && let Some(request) = self.tools.execution_interaction(&call)?
        {
            if !matches!(request, AgentRequest::DynamicTool { call: ref dynamic } if dynamic.call_id == call.id && dynamic.name == call.name)
            {
                return Err(CoreError::Policy(
                    "tool execution interaction must preserve Tool Call identity".into(),
                ));
            }
            orchestrator.start_execution_interaction(context, &call, reviewed, &authorization)?;
            self.threads.request_turn_interaction(
                context.thread_id(),
                context.turn_id(),
                RequestTurnInteraction {
                    request_id: self.threads.next_interaction_request_id(),
                    item_id: Some(context.item_id().clone()),
                    request,
                    deadline: None,
                },
            )?;
            return Ok(ToolSchedulingProgress::WaitingForCapability);
        }
        let hook_decision = self.hooks.before_tool(
            &BeforeToolHookRequest {
                session_id: context.session_id().clone(),
                thread_id: context.thread_id().clone(),
                turn_id: context.turn_id().clone(),
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
            },
            context.cancellation(),
        )?;
        if let BeforeToolHookDecision::Deny { reason } = hook_decision {
            self.record_failure(context.thread_id(), context.turn_id(), tool_call_id, reason)?;
            return Ok(ToolSchedulingProgress::Complete);
        }
        let completion = match control_broker {
            Some(broker) => {
                let control_call = call.clone();
                let updates = Arc::clone(&self.updates);
                let hooks = Arc::clone(&self.hooks);
                orchestrator.execute_core_control(context, call, reviewed, authorization, || {
                    broker.execute(context, &control_call, updates, hooks)
                })?
            }
            None => orchestrator.execute(context, call, reviewed, authorization)?,
        };
        match completion {
            ToolExecutionCompletion::Complete => {
                self.run_after_tool(context, &tool_call_id, tool_name)?;
                Ok(ToolSchedulingProgress::Complete)
            }
            ToolExecutionCompletion::PolicyRejected => {
                self.run_after_tool(context, &tool_call_id, tool_name)?;
                self.enforce_rejection_circuit_breaker(context.thread_id(), context.turn_id())?;
                Ok(ToolSchedulingProgress::Complete)
            }
            ToolExecutionCompletion::WaitingForApproval => {
                Ok(ToolSchedulingProgress::WaitingForApproval)
            }
        }
    }

    fn run_after_tool(
        &self,
        context: &ToolExecutionContext<'_>,
        tool_call_id: &ToolCallId,
        tool_name: String,
    ) -> Result<(), CoreError> {
        let outcome = self
            .threads
            .read_thread(context.thread_id())?
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                ash_protocol::ThreadItem::ToolResult {
                    tool_call_id: result_id,
                    is_error,
                    ..
                } if result_id == tool_call_id => Some(if *is_error {
                    HookOutcome::Failed
                } else {
                    HookOutcome::Succeeded
                }),
                _ => None,
            })
            .unwrap_or(HookOutcome::Failed);
        self.hooks.after_tool(
            &AfterToolHookRequest {
                session_id: context.session_id().clone(),
                thread_id: context.thread_id().clone(),
                turn_id: context.turn_id().clone(),
                tool_call_id: tool_call_id.clone(),
                tool_name,
                outcome,
            },
            context.cancellation(),
        )
    }

    fn record_failure(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        tool_call_id: ToolCallId,
        message: impl Into<String>,
    ) -> Result<(), CoreError> {
        self.threads.record_tool_result(
            thread_id,
            turn_id,
            RecordToolResultRequest {
                tool_call_id,
                output: ToolCallOutput::Failure(message.into()),
            },
        )?;
        Ok(())
    }
}

struct PendingToolCall {
    item_id: ItemId,
    call: ToolCall,
    binding: Option<ash_protocol::ToolCallBinding>,
}

fn call_binding<'a>(
    snapshot: &'a ThreadSnapshot,
    item_id: &ItemId,
) -> Option<&'a ash_protocol::ToolCallBinding> {
    snapshot.items.iter().find_map(|item| match item {
        ThreadItem::ToolCall {
            item_id: candidate,
            binding,
            ..
        } if candidate == item_id => binding.as_ref(),
        _ => None,
    })
}

fn next_pending_call(
    items: &[ThreadItem],
    turn_id: &TurnId,
    target_tool_call_id: Option<&ToolCallId>,
) -> Result<Option<PendingToolCall>, CoreError> {
    for item in items {
        let ThreadItem::ToolCall {
            item_id,
            turn_id: item_turn_id,
            tool_call_id,
            name,
            arguments_json,
            binding,
        } = item
        else {
            continue;
        };
        if item_turn_id != turn_id
            || target_tool_call_id.is_some_and(|target| target != tool_call_id)
            || items.iter().any(|candidate| {
                matches!(
                    candidate,
                    ThreadItem::ToolResult {
                        tool_call_id: result_call_id,
                        ..
                    } if result_call_id == tool_call_id
                )
            })
        {
            continue;
        }
        let arguments = serde_json::from_str(arguments_json).map_err(|error| {
            CoreError::Journal(format!(
                "durable Tool Call {} has invalid arguments: {error}",
                tool_call_id
            ))
        })?;
        return Ok(Some(PendingToolCall {
            item_id: item_id.clone(),
            call: ToolCall {
                id: tool_call_id.clone(),
                name: name.clone(),
                arguments,
            },
            binding: binding.clone(),
        }));
    }
    Ok(None)
}

fn resolved_approval<'a>(
    resolved: &'a [crate::ResolvedTurnInteraction],
    turn_id: &TurnId,
    item_id: &ItemId,
) -> Option<(
    &'a ash_protocol::RequestId,
    &'a ash_protocol::ActionApprovalRequest,
    ActionApprovalDecision,
)> {
    resolved.iter().rev().find_map(|resolved| {
        if &resolved.turn_id != turn_id || resolved.interaction.item_id.as_ref() != Some(item_id) {
            return None;
        }
        match (&resolved.interaction.request, &resolved.response) {
            (AgentRequest::Approval { request }, AgentResponse::Approval { response }) => {
                Some((&resolved.interaction.request_id, request, response.decision))
            }
            _ => None,
        }
    })
}

fn resolved_execution_interaction<'a>(
    resolved: &'a [crate::ResolvedTurnInteraction],
    turn_id: &TurnId,
    item_id: &ItemId,
    call: &ToolCall,
) -> Option<(&'a AgentRequest, &'a AgentResponse)> {
    resolved.iter().rev().find_map(|resolved| {
        if &resolved.turn_id != turn_id || resolved.interaction.item_id.as_ref() != Some(item_id) {
            return None;
        }
        match (&resolved.interaction.request, &resolved.response) {
            (
                AgentRequest::DynamicTool { call: request },
                response @ AgentResponse::DynamicTool { response: result },
            ) if request.call_id == call.id
                && request.name == call.name
                && result.call_id == call.id =>
            {
                Some((&resolved.interaction.request, response))
            }
            _ => None,
        }
    })
}

#[cfg(test)]
#[path = "tool_scheduler_tests.rs"]
mod tests;
