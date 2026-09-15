use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ReviewEvidence;
use ash_async_utils::CancellationToken;
use core_api::CoreError;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_file_access::Authorization;
use ash_protocol::ContentPart;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use ash_tools::DEFAULT_TOOL_OUTPUT_MAX_BYTES;
use ash_tools::EnvId;
use ash_tools::ToolBinding;
use ash_tools::ToolContent;
use ash_tools::ToolExecutionContext;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolOperationId;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputStatus;
use ash_tools::ToolOutputTruncationPolicy;
use ash_tools::ToolPayload;
use ash_tools::ToolRuntimeAuthority;

/// Materializes the security review owned by one executable tool contribution.
///
/// Implementations must resolve every security-relevant field before returning and must not
/// perform the requested side effect. The executor receives authority only after Core reviews the
/// returned action.
pub(crate) trait ToolExecutorReviewer: Send + Sync {
    fn prepare(&self, call: &ToolCall) -> Result<PreparedToolExecution, CoreError>;

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolExecutionFacts,
    ) -> Result<PreparedToolExecution, CoreError> {
        self.prepare(call)
    }

    fn evidence(&self, _: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        Ok(Vec::new())
    }
}

/// Frozen review and payload produced before Core selects execution authority.
pub(crate) struct PreparedToolExecution {
    review: ActionReviewRequest,
    payload: ToolPayload,
    dir_authorizations: Vec<Authorization>,
    execution_dir: Option<PathBuf>,
}

impl PreparedToolExecution {
    pub(crate) fn new(review: ActionReviewRequest, payload: ToolPayload) -> Self {
        Self {
            review,
            payload,
            dir_authorizations: Vec::new(),
            execution_dir: None,
        }
    }

    pub(crate) fn with_dir_authorization(mut self, authorization: Authorization) -> Self {
        self.dir_authorizations.push(authorization);
        self
    }

    pub(crate) fn with_execution_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.execution_dir = Some(dir.into());
        self
    }
}

struct PreparedToolInvocation {
    review: ActionReviewRequest,
    payload: ToolPayload,
    dir_authorizations: Vec<Authorization>,
    execution_dir: Option<PathBuf>,
}

pub(crate) struct ToolExecutorRuntime {
    executor: Arc<dyn ToolExecutor>,
    environment_id: EnvId,
    reviewer: Arc<dyn ToolExecutorReviewer>,
    prepared: Mutex<BTreeMap<ToolCallId, PreparedToolInvocation>>,
}

impl ToolExecutorRuntime {
    pub(crate) fn new(
        executor: Arc<dyn ToolExecutor>,
        environment_id: EnvId,
        reviewer: Arc<dyn ToolExecutorReviewer>,
    ) -> Self {
        Self {
            executor,
            environment_id,
            reviewer,
            prepared: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) fn executor(&self) -> &dyn ToolExecutor {
        self.executor.as_ref()
    }

    pub(crate) fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let prepared = self.reviewer.prepare(call)?;
        self.store_prepared(call, prepared)
    }

    pub(crate) fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        let prepared = self.reviewer.prepare_with_facts(call, facts)?;
        self.store_prepared(call, prepared)
    }

    fn store_prepared(
        &self,
        call: &ToolCall,
        prepared: PreparedToolExecution,
    ) -> Result<ActionReviewRequest, CoreError> {
        self.prepared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                call.id.clone(),
                PreparedToolInvocation {
                    review: prepared.review.clone(),
                    payload: prepared.payload,
                    dir_authorizations: prepared.dir_authorizations,
                    execution_dir: prepared.execution_dir,
                },
            );
        Ok(prepared.review)
    }

    pub(crate) fn evidence(&self, call: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        self.reviewer.evidence(call)
    }

    pub(crate) fn execute(
        &self,
        binding: &ToolBinding,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution(
                "ToolExecutor invocation requires durable Thread/Turn execution facts".into(),
            )
        })?;
        self.execute_for_turn(
            binding,
            call,
            authorization,
            cancellation,
            identity.session_id(),
            identity.thread_id(),
            identity.turn_id(),
            None,
            sink,
        )
    }

    pub(crate) fn execute_with_interactions(
        &self,
        binding: &ToolBinding,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Arc<dyn ash_core::ToolInteractionService>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("ToolExecutor requires durable execution identity".into())
        })?;
        self.execute_for_turn(
            binding,
            call,
            authorization,
            cancellation,
            identity.session_id(),
            identity.thread_id(),
            identity.turn_id(),
            Some(interactions),
            sink,
        )
    }

    fn execute_for_turn(
        &self,
        binding: &ToolBinding,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
        turn_id: &TurnId,
        interactions: Option<Arc<dyn ash_core::ToolInteractionService>>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let operation_id = ToolOperationId::new(format!("{turn_id}:{}", call.id))
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        let (review, payload, dir_authorizations, execution_dir) = {
            let prepared = self
                .prepared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let prepared = prepared.get(&call.id).ok_or_else(|| {
                CoreError::Execution(format!(
                    "ToolExecutor call {} has no frozen prepared payload",
                    call.id
                ))
            })?;
            (
                prepared.review.clone(),
                prepared.payload.clone(),
                prepared.dir_authorizations.clone(),
                prepared.execution_dir.clone(),
            )
        };
        for authorization in &dir_authorizations {
            if authorization.dir().env() != &self.environment_id {
                self.prepared
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&call.id);
                return Err(CoreError::Execution(format!(
                    "directory authorization belongs to environment {}, but the tool runs in {}",
                    authorization.dir().env(),
                    self.environment_id
                )));
            }
            if let Err(error) = authorization.ensure_active() {
                self.prepared
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&call.id);
                return Err(CoreError::Execution(error.to_string()));
            }
        }
        if let Some(execution_dir) = &execution_dir
            && !dir_authorizations.iter().any(|authorization| {
                authorization.dir().canonical_path() == execution_dir
                    || authorization.dir().requested_path() == execution_dir
            })
        {
            self.prepared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&call.id);
            return Err(CoreError::Execution(
                "host-selected execution directory has no matching authorization".into(),
            ));
        }
        let mut authority = match authorization {
            ToolAuthorization::Sandboxed(policy) => ToolRuntimeAuthority::Sandboxed(*policy),
            ToolAuthorization::UnsandboxedGrant { .. }
            | ToolAuthorization::ExecPolicyGranted(_)
            | ToolAuthorization::AutoReviewed(_)
            | ToolAuthorization::PermissionBypassed(_)
            | ToolAuthorization::ApprovedOnce(_) => ToolRuntimeAuthority::Unrestricted,
        };
        let managed = matches!(review.sandbox(), ash_action_policy::SandboxCompatibility::Supported(policy) if policy.network() == ash_sandboxing::NetworkAccess::Managed);
        if managed && authority == ToolRuntimeAuthority::Unrestricted {
            authority = ToolRuntimeAuthority::Sandboxed(ash_sandboxing::SandboxPolicy::new(
                ash_sandboxing::FileSystemAccess::FullAccess,
                ash_sandboxing::NetworkAccess::Managed,
            ));
        }
        let mut context =
            ToolExecutionContext::new(self.environment_id.clone(), cancellation.clone(), authority)
                .with_session_id(session_id.clone())
                .with_thread_id(thread_id.clone());
        if managed {
            let interactions = interactions.ok_or_else(|| {
                self.prepared
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&call.id);
                CoreError::Policy(
                    "managed networking requires Core's live approval authority".into(),
                )
            })?;
            context = context.with_network_policy(crate::network_policy::for_execution(
                review,
                operation_id.as_str().to_owned(),
                interactions,
            ));
        }
        if let Some(execution_dir) = execution_dir {
            context = context.with_execution_dir(execution_dir);
        }
        let invocation = ash_tools::ToolInvocation::new(
            operation_id,
            call.id.clone(),
            turn_id.clone(),
            binding.clone(),
            payload,
            context,
        );
        let outcome = pollster::block_on(self.executor.execute(invocation));
        if !matches!(outcome, ToolExecutionOutcome::SandboxDenied(_)) {
            self.prepared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&call.id);
        }
        protocol_execution_output(outcome, sink)
    }
}

#[cfg(test)]
#[path = "tool_executor_adapter_tests.rs"]
mod tests;

fn protocol_execution_output(
    outcome: ToolExecutionOutcome,
    sink: &mut dyn ToolOutputSink,
) -> Result<ToolExecutionOutput, CoreError> {
    match outcome {
        ToolExecutionOutcome::Returned(output) => returned_output(output, sink),
        ToolExecutionOutcome::NotStarted(failure) => {
            Ok(ToolExecutionOutput::Failure(failure.message().to_owned()))
        }
        ToolExecutionOutcome::SandboxDenied(denial) => {
            Ok(ToolExecutionOutput::SandboxDenied(denial))
        }
        ToolExecutionOutcome::OutcomeUncertain(uncertain) => Ok(
            ToolExecutionOutput::OutcomeUnknown(uncertain.message().to_owned()),
        ),
    }
}

fn returned_output(
    output: ToolOutput,
    sink: &mut dyn ToolOutputSink,
) -> Result<ToolExecutionOutput, CoreError> {
    returned_output_with_policy(
        output,
        sink,
        ToolOutputTruncationPolicy::Bytes(DEFAULT_TOOL_OUTPUT_MAX_BYTES),
    )
}

fn returned_output_with_policy(
    output: ToolOutput,
    sink: &mut dyn ToolOutputSink,
    policy: ToolOutputTruncationPolicy,
) -> Result<ToolExecutionOutput, CoreError> {
    let output = output.truncate_text(policy);
    let content = output
        .content()
        .iter()
        .map(|content| match content {
            ToolContent::Text(text) => {
                sink.emit(ToolOutputStream::Stdout, text.clone())?;
                Ok(ContentPart::Text(text.clone()))
            }
            ToolContent::Image { url, detail } => Ok(ContentPart::ImageUrl {
                url: url.clone(),
                detail: *detail,
            }),
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    Ok(match output.status() {
        ToolOutputStatus::Success => ToolExecutionOutput::SuccessContent(content),
        ToolOutputStatus::Error => ToolExecutionOutput::FailureContent(content),
    })
}
