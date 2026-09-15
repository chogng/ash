use super::code_mode::CodeModeBroker;
use super::tool_scheduler::ToolScheduler;
use super::tool_scheduler::ToolSchedulingProgress;
use crate::ActionPolicyService;
use crate::CompletedTurn;
use crate::ContextAssembler;
use crate::ContextCompactionRequest;
use crate::ContextCompactionResult;
use crate::ContextCompactionService;
use crate::CoreError;
use crate::HarnessContext;
use crate::HarnessContextProvider;
use crate::HarnessInstructions;
use crate::HookService;
use crate::ModelSelection;
use crate::ModelService;
use crate::ModelStreamSink;
use crate::NoHooks;
use crate::NoThreadUpdates;
use crate::NoTools;
use crate::ThreadController;
use crate::ThreadUpdateSink;
use crate::ToolService;
use crate::TurnCompletedHookRequest;
use crate::TurnExecutionFinished;
use crate::TurnExecutionKind;
use crate::TurnExecutionObserver;
use crate::TurnExecutionStarted;
use crate::TurnExecutionTerminalState;
use crate::turn_policy::UnavailableActionPolicyService;
use crate::context::CONTEXT_CALIBRATION_REVISION;
use crate::context::CONTEXT_ESTIMATOR_REVISION;
use crate::context::ContextMeasurementDisposition;
use crate::context::ContextMeasurementPolicy;
use crate::context::ContextOverflowRecoveryPreparation;
use crate::context::ManualContextCompactionPreparation;
use crate::context::ModelContextCompactionService;
use crate::context::ModelInvocationPreparation;
use crate::context::calibrated_budget;
use crate::thread_controller::CommitContextCheckpointRequest;
use crate::thread_controller::CommitModelInvocationItemsResult;
use crate::thread_controller::CompleteModelInvocationResult;
use crate::thread_controller::PrepareModelInvocationRequest;
use crate::turn::TurnExecutionBackend;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use ash_async_utils::Cancellation;
use ash_async_utils::CancellationReason;
use ash_async_utils::CancellationToken;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_protocol::ItemId;
use ash_protocol::ModelInputEstimate;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_protocol::ResponseItem;
use ash_protocol::SessionId;
use ash_protocol::StableTurnError;
use ash_protocol::StreamCursor;
use ash_protocol::StreamInstanceId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCall;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_utils_stream_parser::AssistantTextMode;
use ash_utils_stream_parser::AssistantTextStreamParser;
use ash_utils_stream_parser::strip_citations;

/// Executes provider-independent model and tool steps for one already-started Turn.
///
/// The executor derives every invocation from the latest durable Thread snapshot. It delegates
/// all mutations to [`ThreadController`], so model and tool I/O never owns the Thread projection
/// lock or writer lease. The loop continues while the model requests follow-up work; it does not
/// impose a process-local model-invocation count that would reset after approval or recovery.
#[derive(Clone)]
pub struct TurnExecutor {
    threads: Arc<ThreadController>,
    model: Arc<dyn ModelService>,
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
    compaction: Arc<dyn ContextCompactionService>,
    updates: Arc<dyn ThreadUpdateSink>,
    harness_context: Arc<dyn HarnessContextProvider>,
    context_sources: std::collections::BTreeMap<&'static str, Arc<dyn crate::ContextSource>>,
    hooks: Arc<dyn HookService>,
    execution_observer: Arc<dyn TurnExecutionObserver>,
    activity: Option<Arc<dyn core_api::TurnExecutionActivity>>,
    extensions: Arc<ash_extension_api::ExtensionRegistry>,
    code_mode: CodeModeBroker,
}

struct FixedHarnessContext {
    snapshot: Arc<HarnessContext>,
}

impl HarnessContextProvider for FixedHarnessContext {
    fn snapshot(
        &self,
        _: &crate::HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        Ok(Arc::clone(&self.snapshot))
    }
}

/// Terminal result of one executor run.
pub enum TurnExecutionOutcome {
    Completed(CompletedTurn),
    ShellCompleted { sequence: u64 },
    ContextCompacted { sequence: u64 },
    WaitingForApproval,
    WaitingForCapability,
}

impl TurnExecutor {
    /// Captures the model-neutral direct tool surface for a newly accepted Turn.
    pub fn tool_profile_snapshot(&self) -> Result<ash_protocol::ToolProfileSnapshot, CoreError> {
        let catalog = self.tools.model_catalog_snapshot(&BTreeSet::new())?;
        crate::tool_profile::snapshot_tool_profile(catalog.definitions())
    }

    /// Freezes an explicitly selected subset of the current tool definitions for a worker.
    pub fn tool_profile_for_names(
        &self,
        names: &[ash_protocol::ToolName],
    ) -> Result<ash_protocol::ToolProfileSnapshot, CoreError> {
        let catalog = self.tools.model_catalog_snapshot(&BTreeSet::new())?;
        let selected = catalog
            .definitions()
            .iter()
            .filter(|definition| names.contains(&definition.name))
            .cloned()
            .collect::<Vec<_>>();
        if selected.len() != names.iter().collect::<BTreeSet<_>>().len() {
            return Err(CoreError::InvalidInput(
                "Requested worker tools are no longer available".into(),
            ));
        }
        let mut profile = crate::tool_profile::snapshot_tool_profile(&selected)?;
        profile.id = crate::tool_profile::SELECTED_CODING_TOOL_PROFILE_ID.into();
        Ok(profile)
    }

    /// Freezes the exact durable binding for a host-created Tool Call.
    pub fn bind_tool_call(
        &self,
        call: &ToolCall,
        caller: ash_protocol::ToolCallCaller,
    ) -> Result<ash_protocol::ToolCallBinding, CoreError> {
        self.tools
            .bind_call(call, caller)?
            .ok_or_else(|| CoreError::Execution("tool service did not return a binding".into()))
    }

    /// Creates and durably commits one code-mode nested call through the ordinary scheduler path.
    ///
    /// The code runtime supplies only stable cell/runtime identities and canonical arguments. Core
    /// allocates the nested Tool Call identity, freezes the ordinary binding, and records the call;
    /// approval, execution, cancellation, and uncertain-outcome handling remain unchanged.
    pub fn record_code_mode_nested_call(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        parent_tool_call_id: &ash_protocol::ToolCallId,
        cell_id: impl Into<String>,
        runtime_call_id: impl Into<String>,
        name: ash_protocol::ToolName,
        arguments: serde_json::Value,
    ) -> Result<ash_protocol::ToolCallId, CoreError> {
        let runtime_call_id = runtime_call_id.into();
        let call_id = ash_protocol::ToolCallId::new(format!(
            "code-{}-{}",
            parent_tool_call_id, runtime_call_id
        ))
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let call = ToolCall {
            id: call_id.clone(),
            name: name.clone(),
            arguments,
        };
        let binding = self.bind_tool_call(
            &call,
            ash_protocol::ToolCallCaller::CodeMode {
                parent_tool_call_id: parent_tool_call_id.clone(),
                cell_id: cell_id.into(),
                runtime_call_id,
            },
        )?;
        self.threads.record_tool_call(
            thread_id,
            turn_id,
            crate::RecordToolCallRequest {
                tool_call_id: Some(call_id.clone()),
                name,
                arguments_json: serde_json::to_string(&call.arguments)
                    .map_err(|error| CoreError::Context(error.to_string()))?,
                binding: Some(binding),
            },
        )?;
        Ok(call_id)
    }

    pub fn new(
        threads: Arc<ThreadController>,
        model: Arc<dyn ModelService>,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        let model: Arc<dyn ModelService> = Arc::new(
            crate::attachment_model_service::AttachmentModelService::new(
                model,
                threads.image_attachments(),
            ),
        );
        let compaction = Arc::new(ModelContextCompactionService::new(model.clone()));
        let code_mode = CodeModeBroker::new(
            Arc::clone(&threads),
            Arc::clone(&tools),
            Arc::clone(&policy),
        );
        Self {
            threads,
            model,
            tools,
            policy,
            compaction,
            updates: Arc::new(NoThreadUpdates),
            harness_context: Arc::new(FixedHarnessContext {
                snapshot: Arc::new(HarnessContext::default()),
            }),
            context_sources: std::collections::BTreeMap::new(),
            hooks: Arc::new(NoHooks),
            execution_observer: Arc::new(crate::NoTurnExecutionObserver),
            activity: None,
            extensions: Arc::new(ash_extension_api::ExtensionRegistry::default()),
            code_mode,
        }
    }

    pub fn without_tools(threads: Arc<ThreadController>, model: Arc<dyn ModelService>) -> Self {
        Self::new(
            threads,
            model,
            Arc::new(NoTools),
            Arc::new(UnavailableActionPolicyService),
        )
    }

    /// Adds the outer transport sink for durable and transient Thread updates.
    pub fn with_thread_updates(mut self, updates: Arc<dyn ThreadUpdateSink>) -> Self {
        self.updates = updates;
        self
    }

    /// Uses immutable prompt additions captured by the host for this environment runtime.
    pub fn with_instructions(mut self, instructions: Arc<HarnessInstructions>) -> Self {
        self.harness_context = Arc::new(FixedHarnessContext {
            snapshot: Arc::new(HarnessContext::new(instructions.as_ref().clone())),
        });
        self
    }

    /// Resolves immutable host context at model-invocation boundaries.
    pub fn with_harness_context_provider(
        mut self,
        harness_context: Arc<dyn HarnessContextProvider>,
    ) -> Self {
        self.harness_context = harness_context;
        self
    }

    /// Rebinds execution capabilities while preserving installed context and lifecycle services.
    pub fn with_tool_service(
        mut self,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        self.code_mode = self
            .code_mode
            .with_tool_service(Arc::clone(&tools), Arc::clone(&policy));
        self.tools = tools;
        self.policy = policy;
        self
    }

    /// Installs one named evidence source without replacing other domains. Rebinding the same
    /// name replaces only that source; names define deterministic collection order.
    pub fn with_context_source(
        mut self,
        name: &'static str,
        source: Arc<dyn crate::ContextSource>,
    ) -> Self {
        self.context_sources.insert(name, source);
        self
    }

    /// Removes the named domain when its host authority or runtime is retired.
    pub fn without_context_source(mut self, name: &'static str) -> Self {
        self.context_sources.remove(name);
        self
    }

    /// Overrides checkpoint generation while retaining Core-owned provenance and commit checks.
    pub fn with_context_compaction_service(
        mut self,
        compaction: Arc<dyn ContextCompactionService>,
    ) -> Self {
        self.compaction = compaction;
        self
    }

    /// Installs the host-owned Hook runtime used at Core safe-points.
    pub fn with_hooks(mut self, hooks: Arc<dyn HookService>) -> Self {
        self.hooks = hooks;
        self
    }

    /// Installs the host-owned durable change checkpoint observer.
    pub fn with_execution_observer(mut self, observer: Arc<dyn TurnExecutionObserver>) -> Self {
        self.execution_observer = observer;
        self
    }

    /// Installs host resources scoped to execution, including resumed and Shell Turns.
    pub fn with_execution_activity(
        mut self,
        activity: Arc<dyn core_api::TurnExecutionActivity>,
    ) -> Self {
        self.activity = Some(activity);
        self
    }

    /// Installs the shared agent extension registry used at model-invocation safe points.
    pub fn with_extensions(
        mut self,
        extensions: Arc<ash_extension_api::ExtensionRegistry>,
    ) -> Self {
        self.extensions = extensions;
        self
    }

    pub fn policy_revision(&self) -> String {
        self.policy.revision()
    }

    /// Enqueues one Turn on its Thread-owned execution mailbox and returns after acceptance.
    ///
    /// The mailbox runs model and tool I/O away from the caller and from the Thread projection
    /// lock. Completion, failure, and cancellation remain durable Core transitions.
    pub fn start(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        let executor = self.clone();
        let queued_thread_id = thread_id.clone();
        let queued_turn_id = turn_id.clone();
        self.threads
            .enqueue_turn_execution(thread_id, turn_id, move |execution| {
                if execution.check_current().is_ok() {
                    let _ = executor.execute(
                        &queued_thread_id,
                        &queued_turn_id,
                        execution.cancellation(),
                    );
                }
            })
    }

    /// Enqueues one already-started model-free Shell Turn.
    pub fn start_shell(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        let executor = self.clone();
        let queued_thread_id = thread_id.clone();
        let queued_turn_id = turn_id.clone();
        self.threads
            .enqueue_turn_execution(thread_id, turn_id, move |execution| {
                if execution.check_current().is_ok() {
                    let _ = executor.execute_shell(
                        &queued_thread_id,
                        &queued_turn_id,
                        execution.cancellation(),
                    );
                }
            })
    }

    /// Resumes a waiting or recovered Turn through the executor matching its durable command.
    pub fn resume(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        if self.is_shell_turn(thread_id, turn_id)? {
            self.start_shell(thread_id, turn_id)
        } else {
            self.start(thread_id, turn_id)
        }
    }

    /// Enqueues every recovered running Turn that owns an unresolved durable Tool Call.
    ///
    /// Hosts should call this only after installing the same tool and policy services used for
    /// normal execution. A call that crossed its durable execution-start boundary is converted
    /// into an unknown-outcome Tool failure and is never replayed.
    pub fn resume_recovered_tool_continuations(&self) -> Result<usize, CoreError> {
        self.resume_recovered_tool_continuations_matching(|_| true)
    }

    /// Resumes durable Tool continuations owned by the supplied Session authorities.
    pub fn resume_recovered_tool_continuations_in_sessions(
        &self,
        session_ids: &BTreeSet<SessionId>,
    ) -> Result<usize, CoreError> {
        self.resume_recovered_tool_continuations_matching(|session_id| {
            session_ids.contains(session_id)
        })
    }

    /// Recovers durable extension work using its owning contributors.
    pub fn resume_recovered_extension_turns_in_sessions(
        &self,
        sessions: &BTreeSet<SessionId>,
    ) -> Result<usize, CoreError> {
        let turns = self
            .extensions
            .recover_turns(sessions)
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        for turn in &turns {
            self.resume(&turn.thread_id, &turn.turn_id)?;
        }
        Ok(turns.len())
    }

    /// Re-evaluates extension work after an explicit user state change.
    pub fn resume_extension_continuation(&self, thread: &ThreadId) -> Result<bool, CoreError> {
        let snapshot = self.threads.read_thread(thread)?;
        let Some(completed) = snapshot
            .turns
            .iter()
            .rev()
            .find(|turn| turn.status == TurnStatus::Completed)
        else {
            return Ok(false);
        };
        self.start_extension_continuation(thread, &completed.turn_id)
    }

    fn resume_recovered_tool_continuations_matching(
        &self,
        matches_session: impl Fn(&SessionId) -> bool,
    ) -> Result<usize, CoreError> {
        let mut resumed = 0;
        for snapshot in self.threads.list_loaded_threads()? {
            if !matches_session(&snapshot.session_id) {
                continue;
            }
            for turn in &snapshot.turns {
                if turn.status == TurnStatus::Running
                    && snapshot.has_resumable_tool_continuation(&turn.turn_id)
                {
                    self.resume(&snapshot.thread_id, &turn.turn_id)?;
                    resumed += 1;
                }
            }
        }
        Ok(resumed)
    }

    fn execute_shell(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<TurnExecutionOutcome, CoreError> {
        let _activity = self.activity.as_ref().and_then(|activity| activity.enter());
        let sequence_before_execution = self
            .threads
            .read_thread(thread_id)
            .map(|snapshot| snapshot.sequence)
            .unwrap_or(0);
        let execution = self.execution_started(thread_id, turn_id, TurnExecutionKind::Shell)?;
        if let Err(error) = self.execution_observer.will_execute(&execution) {
            self.threads
                .fail_turn(thread_id, turn_id, StableTurnError::change_capture_failed())?;
            self.publish_committed_after(thread_id, sequence_before_execution);
            self.execution_observer.did_finish(&TurnExecutionFinished {
                session_id: execution.session_id,
                thread_id: execution.thread_id,
                turn_id: execution.turn_id,
                terminal_state: TurnExecutionTerminalState::Failed,
            });
            return Err(error);
        }
        let (result, terminal_state) =
            match self.execute_shell_steps(thread_id, turn_id, cancellation) {
                Ok(completion @ TurnExecutionOutcome::WaitingForApproval)
                | Ok(completion @ TurnExecutionOutcome::WaitingForCapability) => {
                    (Ok(completion), None)
                }
                Ok(completion) => (Ok(completion), Some(TurnExecutionTerminalState::Completed)),
                Err(ExecutionFailure::Cancelled(error))
                | Err(ExecutionFailure::Interrupted(error)) => {
                    self.threads.interrupt_execution(thread_id, turn_id)?;
                    (Err(error), Some(TurnExecutionTerminalState::Interrupted))
                }
                Err(ExecutionFailure::Failed { error, stable }) => {
                    self.threads.fail_turn(thread_id, turn_id, stable)?;
                    (Err(error), Some(TurnExecutionTerminalState::Failed))
                }
            };
        self.publish_committed_after(thread_id, sequence_before_execution);
        if let Some(terminal_state) = terminal_state {
            self.execution_observer.did_finish(&TurnExecutionFinished {
                session_id: execution.session_id,
                thread_id: execution.thread_id,
                turn_id: execution.turn_id,
                terminal_state,
            });
        }
        if matches!(&result, Ok(TurnExecutionOutcome::Completed(_))) {
            let _ = self.start_extension_continuation(thread_id, turn_id);
        }
        result
    }

    fn execute_shell_steps(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<TurnExecutionOutcome, ExecutionFailure> {
        check_cancellation(cancellation)?;
        self.require_running_turn(thread_id, turn_id)?;
        match self
            .tool_scheduler()
            .run_pending(thread_id, turn_id, cancellation)
            .map_err(ExecutionFailure::service)?
        {
            ToolSchedulingProgress::Complete => {}
            ToolSchedulingProgress::WaitingForApproval => {
                return Ok(TurnExecutionOutcome::WaitingForApproval);
            }
            ToolSchedulingProgress::WaitingForCapability => {
                return Ok(TurnExecutionOutcome::WaitingForCapability);
            }
        }
        let session_id = self
            .threads
            .read_thread(thread_id)
            .map_err(ExecutionFailure::persistence)?
            .session_id;
        let sequence = self
            .threads
            .complete_turn_without_agent_message(thread_id, turn_id)
            .map_err(ExecutionFailure::persistence)?;
        let _ = self.hooks.turn_completed(
            &TurnCompletedHookRequest {
                session_id,
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
            cancellation,
        );
        Ok(TurnExecutionOutcome::ShellCompleted { sequence })
    }

    fn is_shell_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<bool, CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        Ok(snapshot.commands.iter().any(|command| {
            matches!(
                (&command.result, &command.receipt.command),
                (
                    crate::ThreadCommandResult::TurnAccepted {
                        turn_id: command_turn_id,
                    },
                    ThreadCommand::StartShellTurn { .. },
                ) if command_turn_id == turn_id
            )
        }))
    }

    fn is_context_compaction_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<bool, CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        Ok(snapshot.commands.iter().any(|command| {
            matches!(
                (&command.result, &command.receipt.command),
                (
                    crate::ThreadCommandResult::TurnAccepted {
                        turn_id: command_turn_id,
                    },
                    ThreadCommand::CompactContext { .. },
                ) if command_turn_id == turn_id
            )
        }))
    }

    fn execute(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<TurnExecutionOutcome, CoreError> {
        let _activity = self.activity.as_ref().and_then(|activity| activity.enter());
        let sequence_before_execution = self
            .threads
            .read_thread(thread_id)
            .map(|snapshot| snapshot.sequence)
            .unwrap_or(0);
        let execution_kind = if self.is_context_compaction_turn(thread_id, turn_id)? {
            TurnExecutionKind::ContextCompaction
        } else {
            TurnExecutionKind::Agent
        };
        let execution = self.execution_started(thread_id, turn_id, execution_kind)?;
        if let Err(error) = self.execution_observer.will_execute(&execution) {
            self.threads
                .fail_turn(thread_id, turn_id, StableTurnError::change_capture_failed())?;
            self.publish_committed_after(thread_id, sequence_before_execution);
            self.execution_observer.did_finish(&TurnExecutionFinished {
                session_id: execution.session_id,
                thread_id: execution.thread_id,
                turn_id: execution.turn_id,
                terminal_state: TurnExecutionTerminalState::Failed,
            });
            return Err(error);
        }
        let (result, terminal_state) = match self.execute_steps(thread_id, turn_id, cancellation) {
            Ok(completion @ TurnExecutionOutcome::WaitingForApproval)
            | Ok(completion @ TurnExecutionOutcome::WaitingForCapability) => (Ok(completion), None),
            Ok(completion) => (Ok(completion), Some(TurnExecutionTerminalState::Completed)),
            Err(ExecutionFailure::Cancelled(error)) => {
                self.threads.interrupt_execution(thread_id, turn_id)?;
                (Err(error), Some(TurnExecutionTerminalState::Interrupted))
            }
            Err(ExecutionFailure::Interrupted(error)) => {
                self.threads.interrupt_execution(thread_id, turn_id)?;
                (Err(error), Some(TurnExecutionTerminalState::Interrupted))
            }
            Err(ExecutionFailure::Failed { error, stable }) => {
                self.threads.fail_turn(thread_id, turn_id, stable)?;
                (Err(error), Some(TurnExecutionTerminalState::Failed))
            }
        };
        self.publish_committed_after(thread_id, sequence_before_execution);
        if let Some(terminal_state) = terminal_state {
            self.execution_observer.did_finish(&TurnExecutionFinished {
                session_id: execution.session_id,
                thread_id: execution.thread_id,
                turn_id: execution.turn_id,
                terminal_state,
            });
        }
        if !matches!(
            &result,
            Ok(TurnExecutionOutcome::WaitingForApproval
                | TurnExecutionOutcome::WaitingForCapability)
        ) {
            let _ = self.code_mode.close_turn(thread_id, turn_id);
        }
        if matches!(&result, Ok(TurnExecutionOutcome::Completed(_))) {
            let _ = self.start_extension_continuation(thread_id, turn_id);
        }
        result
    }

    fn execution_started(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        kind: TurnExecutionKind,
    ) -> Result<TurnExecutionStarted, CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        Ok(TurnExecutionStarted {
            session_id: snapshot.session_id,
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            kind,
        })
    }

    fn execute_steps(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<TurnExecutionOutcome, ExecutionFailure> {
        check_cancellation(cancellation)?;
        self.require_running_turn(thread_id, turn_id)?;
        if self
            .is_context_compaction_turn(thread_id, turn_id)
            .map_err(ExecutionFailure::model)?
        {
            return self.execute_manual_context_compaction(thread_id, turn_id, cancellation);
        }
        match self
            .tool_scheduler()
            .run_pending(thread_id, turn_id, cancellation)
            .map_err(ExecutionFailure::service)?
        {
            ToolSchedulingProgress::Complete => {}
            ToolSchedulingProgress::WaitingForApproval => {
                return Ok(TurnExecutionOutcome::WaitingForApproval);
            }
            ToolSchedulingProgress::WaitingForCapability => {
                return Ok(TurnExecutionOutcome::WaitingForCapability);
            }
        }
        let mut measurement_policy = ContextMeasurementPolicy::default();
        'model_steps: loop {
            check_cancellation(cancellation)?;
            let snapshot = self
                .threads
                .read_thread(thread_id)
                .map_err(ExecutionFailure::model)?;
            let activated = activated_tool_names(self.tools.as_ref(), &snapshot.items, turn_id)
                .map_err(ExecutionFailure::model)?;
            let ordinary_tool_catalog = self
                .tools
                .model_catalog_snapshot(&activated)
                .map_err(ExecutionFailure::model)?;
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| ExecutionFailure::model(CoreError::NotFound(turn_id.to_string())))?;
            let ordinary_tool_catalog = if let Some(profile) = &turn.tool_profile {
                if profile.id == crate::tool_profile::SELECTED_CODING_TOOL_PROFILE_ID {
                    ordinary_tool_catalog.restrict_to_names(&profile.tool_names)
                } else {
                    ordinary_tool_catalog
                }
            } else {
                ordinary_tool_catalog
            };
            if let Some(profile) = &turn.tool_profile {
                let frozen_definitions = ordinary_tool_catalog
                    .definitions()
                    .iter()
                    .filter(|definition| !activated.contains(&definition.name))
                    .cloned()
                    .collect::<Vec<_>>();
                crate::tool_profile::validate_tool_profile_definitions(
                    profile,
                    &frozen_definitions,
                )
                .map_err(ExecutionFailure::model)?;
            }
            let tool_catalog = self
                .code_mode
                .augment_catalog(ordinary_tool_catalog, turn.tool_mode)
                .map_err(ExecutionFailure::model)?;
            let tools = tool_catalog.definitions().to_vec();
            let frozen_model = turn.model.clone();
            let model = match frozen_model.as_ref() {
                Some(model) => ModelSelection::Session(model),
                None => ModelSelection::ConfiguredDefault,
            };
            let configured_budget = self
                .model
                .context_budget(model)
                .map_err(ExecutionFailure::model)?;
            let calibration = frozen_model
                .as_ref()
                .and_then(|model| snapshot.context_calibration(model, CONTEXT_ESTIMATOR_REVISION));
            let base_budget = calibrated_budget(configured_budget, calibration)
                .map_err(|error| ExecutionFailure::model(CoreError::Context(error.to_string())))?;
            let budget = measurement_policy.adjusted_budget(base_budget);
            let read_paths = crate::services::read_paths_for_turn(&snapshot, turn_id);
            let harness_context = self
                .harness_context
                .snapshot(&crate::HarnessContextRequest {
                    session_id: &snapshot.session_id,
                    thread_id,
                    turn_id,
                    read_paths: &read_paths,
                })
                .map_err(ExecutionFailure::model)?;
            let mut evidence = Vec::new();
            if is_first_model_invocation(&snapshot, turn_id)
                && let Some(query) = current_turn_query(&snapshot, turn_id)
            {
                let request = crate::ContextSourceRequest {
                    session_id: &snapshot.session_id,
                    thread_id,
                    turn_id,
                    query: &query,
                };
                let contributed = self.extensions.collect_context(&request, cancellation);
                check_cancellation(cancellation)?;
                evidence.extend(contributed.map_err(|error| {
                    ExecutionFailure::model(CoreError::Context(error.to_string()))
                })?);
                // Recollect at each preparation attempt so compaction or token measurement cannot
                // retain evidence after its source was deleted or its read permission revoked.
                for source in self.context_sources.values() {
                    check_cancellation(cancellation)?;
                    evidence.extend(source.collect(&request, cancellation).map_err(|error| {
                        match error {
                            CoreError::Cancelled(_) => ExecutionFailure::Cancelled(error),
                            error => ExecutionFailure::model(error),
                        }
                    })?);
                }
            }
            let extension_fragments = self
                .extensions
                .contribute_turn_input(ash_extension_api::TurnInputContext::for_session(
                    &snapshot.session_id,
                    thread_id,
                    turn_id,
                    &turn.activated_skills,
                ))
                .map_err(|error| ExecutionFailure::model(CoreError::Context(error.to_string())))?;
            let harness_context = harness_context.as_ref().clone().with_time_context(
                self.threads
                    .sample_time_context()
                    .map_err(ExecutionFailure::model)?,
            );
            let invocation = match self
                .threads
                .prepare_model_invocation(
                    thread_id,
                    PrepareModelInvocationRequest {
                        turn_id,
                        harness_context: &harness_context,
                        extension_fragments,
                        evidence,
                        tools: tools.clone(),
                        budget,
                    },
                )
                .map_err(ExecutionFailure::model)?
            {
                ModelInvocationPreparation::Ready(invocation) => invocation,
                ModelInvocationPreparation::NeedsCompaction { model, plan } => {
                    let request = ContextCompactionRequest::from_plan(&plan, &model);
                    let (result, source_thread_sequence) =
                        self.compact_context(thread_id, turn_id, &request, cancellation)?;
                    check_cancellation(cancellation)?;
                    self.threads
                        .commit_context_checkpoint(
                            thread_id,
                            CommitContextCheckpointRequest {
                                referenced_items: request.referenced_items(),
                                source_thread_sequence,
                                covered: request.covered(),
                                summary: result.summary().into(),
                                schema_revision: result.schema_revision().into(),
                                prompt_revision: result.prompt_revision().into(),
                                context_policy_revision: result.context_policy_revision().into(),
                                generator_model: request.generator_model().cloned(),
                            },
                        )
                        .map_err(ExecutionFailure::persistence)?;
                    measurement_policy.note_compaction();
                    continue;
                }
            };
            let mut request = ContextAssembler::assemble(invocation.context())
                .map_err(ExecutionFailure::model)?;
            request.prompt_cache_key = Some(invocation.session_id().as_str().to_owned());
            if let Some(profile) = &turn.tool_profile {
                request.parallel_tool_calls = profile.parallel_tool_calls;
            }
            let model = invocation.model().as_service_selection();
            request.reasoning = self
                .model
                .reasoning_config(model)
                .map_err(ExecutionFailure::service)?;
            let billing_scope = self
                .model
                .billing_scope(model)
                .map_err(ExecutionFailure::service)?;
            let estimated_input = invocation.context().budget().total_input();
            let input_estimate = frozen_model.as_ref().map(|_| ModelInputEstimate {
                estimated_input_tokens: u64::from(estimated_input.get()),
                estimator_revision: invocation.context().budget().estimator_revision().into(),
                calibration_revision: CONTEXT_CALIBRATION_REVISION.into(),
            });
            let measurement_capability = self
                .model
                .input_token_measurement_capability(model)
                .map_err(ExecutionFailure::service)?;
            let should_measure = measurement_policy
                .should_measure(base_budget, estimated_input, measurement_capability)
                .map_err(|error| ExecutionFailure::model(CoreError::Context(error.to_string())))?;
            if should_measure {
                match retry_invalid_model_response(|| {
                    self.model.measure_input(model, &request, cancellation)
                })
                .map_err(ExecutionFailure::service)?
                {
                    ContextTokenMeasurementOutcome::Unavailable => {}
                    ContextTokenMeasurementOutcome::Measured(measurement) => {
                        let disposition = measurement_policy
                            .assess(base_budget, estimated_input, measurement)
                            .map_err(|error| {
                                ExecutionFailure::model(CoreError::Context(error.to_string()))
                            })?;
                        if disposition == ContextMeasurementDisposition::Replan {
                            continue;
                        }
                    }
                }
            }
            let mut transient_attempt = 0;
            let mut invalid_response_attempt = false;
            let mut empty_attempt = false;
            let (response, mut stream) = loop {
                let started_at_unix_ms = current_unix_ms().map_err(ExecutionFailure::model)?;
                let mut stream = InvocationStream::new(
                    self.threads.clone(),
                    self.updates.clone(),
                    invocation.session_id().clone(),
                    invocation.thread_id().clone(),
                    invocation.turn_id().clone(),
                    invocation.context().source_thread_sequence(),
                    cancellation.clone(),
                );
                match self
                    .model
                    .stream(model, &request, cancellation, &mut stream)
                {
                    Ok(response) => {
                        self.threads
                            .record_model_invocation(
                                thread_id,
                                turn_id,
                                frozen_model.as_ref(),
                                response.billing.as_ref(),
                                billing_scope,
                                response.usage.clone(),
                                input_estimate.clone(),
                                harness_context.time_context().cloned(),
                                started_at_unix_ms,
                                current_unix_ms().map_err(ExecutionFailure::model)?,
                            )
                            .map_err(ExecutionFailure::persistence)?;
                        check_cancellation(cancellation)?;
                        stream.finish_text();
                        let tool_calls = response.tool_calls().count();
                        let text = final_text(&response, &stream);
                        if tool_calls == 0
                            && text.trim().is_empty()
                            && response_refusal_message(&response).is_none()
                        {
                            if !empty_attempt {
                                empty_attempt = true;
                                continue;
                            }
                            return Err(ExecutionFailure::model(CoreError::Execution(
                                "model returned no final text or Tool Call".into(),
                            )));
                        }
                        break (response, stream);
                    }
                    Err(CoreError::ModelTransient { retry_after_ms, .. })
                        if transient_attempt < 3 =>
                    {
                        wait_for_model_retry(cancellation, transient_attempt, retry_after_ms)?;
                        transient_attempt += 1;
                    }
                    Err(CoreError::ModelInvalidResponse) if !invalid_response_attempt => {
                        invalid_response_attempt = true;
                    }
                    Err(CoreError::ModelContextOverflow) => {
                        self.recover_context_overflow(thread_id, turn_id, cancellation)?;
                        measurement_policy.note_compaction();
                        continue 'model_steps;
                    }
                    Err(error) => return Err(ExecutionFailure::service(error)),
                }
            };
            let source_thread_sequence = invocation.context().source_thread_sequence();
            if !self
                .threads
                .model_invocation_is_current(thread_id, turn_id, source_thread_sequence)
                .map_err(ExecutionFailure::persistence)?
            {
                measurement_policy.finish_invocation();
                continue 'model_steps;
            }
            measurement_policy.finish_invocation();

            let tool_calls = response.tool_calls().cloned().collect::<Vec<_>>();
            validate_model_tool_calls(&tool_calls, &request.tools)
                .map_err(ExecutionFailure::model)?;
            let reasoning_items = self.model_reasoning_items(turn_id, &response, &mut stream);
            let text = final_text(&response, &stream);
            if tool_calls.is_empty() {
                let text = response_refusal_message(&response).unwrap_or(text);
                if text.trim().is_empty() {
                    return Err(ExecutionFailure::model(CoreError::Execution(
                        response_failure_message(&response),
                    )));
                }
                let item_id = stream
                    .text_item_id()
                    .unwrap_or_else(|| self.threads.next_stream_item_id());
                let completion = match self
                    .threads
                    .complete_model_invocation_with_agent_message(
                        thread_id,
                        turn_id,
                        source_thread_sequence,
                        reasoning_items,
                        item_id,
                        text,
                    )
                    .map_err(ExecutionFailure::persistence)?
                {
                    CompleteModelInvocationResult::Completed(completion) => {
                        TurnExecutionOutcome::Completed(completion)
                    }
                    CompleteModelInvocationResult::SupersededBySteer => {
                        continue 'model_steps;
                    }
                };
                let session_id = self
                    .threads
                    .read_thread(thread_id)
                    .map_err(ExecutionFailure::persistence)?
                    .session_id;
                let _ = self.hooks.turn_completed(
                    &TurnCompletedHookRequest {
                        session_id,
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                    cancellation,
                );
                return Ok(completion);
            }

            let mut response_items = reasoning_items;
            if !text.trim().is_empty() {
                response_items.push(ash_protocol::ThreadItem::AgentMessage {
                    item_id: stream
                        .text_item_id()
                        .unwrap_or_else(|| self.threads.next_stream_item_id()),
                    turn_id: turn_id.clone(),
                    text,
                });
            }
            response_items.extend(self.bind_model_tool_calls(
                turn_id,
                &tool_calls,
                &tool_catalog,
            )?);
            match self
                .threads
                .commit_model_invocation_items(
                    thread_id,
                    turn_id,
                    source_thread_sequence,
                    response_items,
                )
                .map_err(ExecutionFailure::persistence)?
            {
                CommitModelInvocationItemsResult::Committed => {}
                CommitModelInvocationItemsResult::SupersededBySteer => {
                    continue 'model_steps;
                }
            }
            match self
                .tool_scheduler()
                .run_pending(thread_id, turn_id, cancellation)
                .map_err(ExecutionFailure::service)?
            {
                ToolSchedulingProgress::Complete => {}
                ToolSchedulingProgress::WaitingForApproval => {
                    return Ok(TurnExecutionOutcome::WaitingForApproval);
                }
                ToolSchedulingProgress::WaitingForCapability => {
                    return Ok(TurnExecutionOutcome::WaitingForCapability);
                }
            }
        }
    }

    fn execute_manual_context_compaction(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<TurnExecutionOutcome, ExecutionFailure> {
        loop {
            check_cancellation(cancellation)?;
            let snapshot = self
                .threads
                .read_thread(thread_id)
                .map_err(ExecutionFailure::model)?;
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| ExecutionFailure::model(CoreError::NotFound(turn_id.to_string())))?;
            let frozen_model = turn.model.clone();
            let selection = match frozen_model.as_ref() {
                Some(model) => ModelSelection::Session(model),
                None => ModelSelection::ConfiguredDefault,
            };
            let configured_budget = self
                .model
                .context_budget(selection)
                .map_err(ExecutionFailure::model)?;
            let calibration = frozen_model
                .as_ref()
                .and_then(|model| snapshot.context_calibration(model, CONTEXT_ESTIMATOR_REVISION));
            let budget = calibrated_budget(configured_budget, calibration)
                .map_err(|error| ExecutionFailure::model(CoreError::Context(error.to_string())))?;
            let (model, retention_prompt, plan) = match self
                .threads
                .prepare_manual_context_compaction(thread_id, turn_id, budget)
                .map_err(ExecutionFailure::model)?
            {
                ManualContextCompactionPreparation::Complete => {
                    let sequence = self
                        .threads
                        .complete_turn_without_agent_message(thread_id, turn_id)
                        .map_err(ExecutionFailure::persistence)?;
                    return Ok(TurnExecutionOutcome::ContextCompacted { sequence });
                }
                ManualContextCompactionPreparation::NeedsCompaction {
                    model,
                    retention_prompt,
                    plan,
                } => (model, retention_prompt, plan),
            };
            let request =
                ContextCompactionRequest::from_manual_plan(&plan, &model, retention_prompt);
            let (result, source_thread_sequence) =
                self.compact_context(thread_id, turn_id, &request, cancellation)?;
            check_cancellation(cancellation)?;
            self.threads
                .commit_context_checkpoint(
                    thread_id,
                    CommitContextCheckpointRequest {
                        referenced_items: request.referenced_items(),
                        source_thread_sequence,
                        covered: request.covered(),
                        summary: result.summary().into(),
                        schema_revision: result.schema_revision().into(),
                        prompt_revision: result.prompt_revision().into(),
                        context_policy_revision: result.context_policy_revision().into(),
                        generator_model: request.generator_model().cloned(),
                    },
                )
                .map_err(ExecutionFailure::persistence)?;
        }
    }

    fn recover_context_overflow(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        cancellation: &CancellationToken,
    ) -> Result<(), ExecutionFailure> {
        let (model, plan) = match self
            .threads
            .prepare_context_overflow_recovery(thread_id, turn_id)
            .map_err(ExecutionFailure::model)?
        {
            ContextOverflowRecoveryPreparation::AlreadyAttempted
            | ContextOverflowRecoveryPreparation::Unavailable => {
                return Err(ExecutionFailure::service(CoreError::ModelContextOverflow));
            }
            ContextOverflowRecoveryPreparation::NeedsCompaction { model, plan } => (model, plan),
        };
        let request = ContextCompactionRequest::from_plan(&plan, &model);
        let (result, source_thread_sequence) =
            self.compact_context(thread_id, turn_id, &request, cancellation)?;
        check_cancellation(cancellation)?;
        self.threads
            .commit_context_overflow_recovery(
                thread_id,
                turn_id,
                CommitContextCheckpointRequest {
                    referenced_items: request.referenced_items(),
                    source_thread_sequence,
                    covered: request.covered(),
                    summary: result.summary().into(),
                    schema_revision: result.schema_revision().into(),
                    prompt_revision: result.prompt_revision().into(),
                    context_policy_revision: result.context_policy_revision().into(),
                    generator_model: request.generator_model().cloned(),
                },
            )
            .map_err(ExecutionFailure::persistence)?;
        Ok(())
    }

    fn compact_context(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request: &ContextCompactionRequest,
        cancellation: &CancellationToken,
    ) -> Result<(ContextCompactionResult, u64), ExecutionFailure> {
        let mut usage_sequence = None;
        let mut usage_recording_error = None;
        let input_estimate = request
            .generator_model()
            .map(|_| {
                request
                    .estimated_input_tokens()
                    .map(|estimated_input| ModelInputEstimate {
                        estimated_input_tokens: u64::from(estimated_input.get()),
                        estimator_revision: CONTEXT_ESTIMATOR_REVISION.into(),
                        calibration_revision: CONTEXT_CALIBRATION_REVISION.into(),
                    })
            })
            .transpose()
            .map_err(ExecutionFailure::model)?;
        let model_selection = request
            .generator_model()
            .map_or(ModelSelection::ConfiguredDefault, ModelSelection::Session);
        let billing_scope = self
            .model
            .billing_scope(model_selection)
            .map_err(ExecutionFailure::service)?;
        let started_at_unix_ms = current_unix_ms().map_err(ExecutionFailure::model)?;
        let result = {
            let mut record_model_usage = |usage| {
                let recorded = self.threads.record_model_invocation(
                    thread_id,
                    turn_id,
                    request.generator_model(),
                    None,
                    billing_scope,
                    usage,
                    input_estimate.clone(),
                    None,
                    started_at_unix_ms,
                    current_unix_ms()?,
                );
                match recorded {
                    Ok(sequence) => {
                        usage_sequence = Some(sequence);
                        Ok(())
                    }
                    Err(error) => {
                        usage_recording_error = Some(error.clone());
                        Err(error)
                    }
                }
            };
            retry_invalid_model_response(|| {
                self.compaction
                    .compact(request, cancellation, &mut record_model_usage)
            })
        };
        if let Some(error) = usage_recording_error {
            return Err(ExecutionFailure::persistence(error));
        }
        let result = result.map_err(ExecutionFailure::service)?;
        Ok((
            result,
            usage_sequence.unwrap_or(request.source_thread_sequence()),
        ))
    }

    fn require_running_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<(), ExecutionFailure> {
        let snapshot = self
            .threads
            .read_thread(thread_id)
            .map_err(ExecutionFailure::model)?;
        let status = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .map(|turn| turn.status)
            .ok_or_else(|| ExecutionFailure::model(CoreError::NotFound(turn_id.to_string())))?;
        if status == TurnStatus::Running {
            Ok(())
        } else {
            Err(ExecutionFailure::model(CoreError::Execution(format!(
                "cannot execute a {status:?} Turn"
            ))))
        }
    }

    fn model_reasoning_items(
        &self,
        turn_id: &TurnId,
        response: &ModelResponse,
        stream: &mut InvocationStream,
    ) -> Vec<ash_protocol::ThreadItem> {
        if let Some((item_id, text)) = stream.take_reasoning() {
            if !text.trim().is_empty() {
                return vec![ash_protocol::ThreadItem::Reasoning {
                    item_id,
                    turn_id: turn_id.clone(),
                    text,
                }];
            }
            return Vec::new();
        }
        response
            .output
            .iter()
            .filter_map(|item| match item {
                ResponseItem::Reasoning(text) if !text.trim().is_empty() => {
                    Some(ash_protocol::ThreadItem::Reasoning {
                        item_id: self.threads.next_stream_item_id(),
                        turn_id: turn_id.clone(),
                        text: text.clone(),
                    })
                }
                _ => None,
            })
            .collect()
    }

    fn publish_committed_after(&self, thread_id: &ThreadId, sequence: u64) {
        if let Ok(updates) = self.threads.thread_updates_after(thread_id, sequence) {
            for update in updates {
                self.updates.publish(update);
            }
        }
    }

    fn start_extension_continuation(
        &self,
        thread_id: &ThreadId,
        completed: &TurnId,
    ) -> Result<bool, CoreError> {
        let Some(turn) = self
            .extensions
            .next_turn(thread_id, completed)
            .map_err(|error| CoreError::Execution(error.to_string()))?
        else {
            return Ok(false);
        };
        self.start(&turn.thread_id, &turn.turn_id)?;
        Ok(true)
    }

    fn bind_model_tool_calls(
        &self,
        turn_id: &TurnId,
        calls: &[ToolCall],
        catalog: &crate::ModelToolCatalogSnapshot,
    ) -> Result<Vec<ash_protocol::ThreadItem>, ExecutionFailure> {
        calls
            .iter()
            .map(|call| {
                let caller = ash_protocol::ToolCallCaller::Direct;
                let binding = match self
                    .code_mode
                    .bind_control_call(call, caller.clone())
                    .map_err(ExecutionFailure::service)?
                {
                    Some(binding) => Ok(Some(binding)),
                    None => match catalog.bind_call(call, caller.clone()) {
                        Some(binding) => binding,
                        None => self.tools.bind_call(call, caller),
                    },
                }
                .map_err(ExecutionFailure::service)?
                .ok_or_else(|| {
                    ExecutionFailure::service(CoreError::Execution(format!(
                        "tool service did not freeze a durable binding for {}",
                        call.name
                    )))
                })?;
                Ok(ash_protocol::ThreadItem::ToolCall {
                    item_id: self.threads.next_stream_item_id(),
                    turn_id: turn_id.clone(),
                    tool_call_id: call.id.clone(),
                    name: call.name.clone(),
                    arguments_json: serde_json::to_string(&call.arguments).map_err(|error| {
                        ExecutionFailure::model(CoreError::Context(error.to_string()))
                    })?,
                    binding: Some(binding),
                })
            })
            .collect()
    }

    fn tool_scheduler(&self) -> ToolScheduler {
        ToolScheduler::new(
            self.threads.clone(),
            self.tools.clone(),
            self.policy.clone(),
        )
        .with_thread_updates(self.updates.clone())
        .with_harness_context(self.harness_context.clone())
        .with_hooks(self.hooks.clone())
        .with_code_mode(self.code_mode.clone())
        .with_execution_observer(self.execution_observer.clone())
    }
}

impl TurnExecutionBackend for TurnExecutor {
    fn start(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        TurnExecutor::start(self, thread_id, turn_id)
    }

    fn resume(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        TurnExecutor::resume(self, thread_id, turn_id)
    }

    fn steer(
        &self,
        _: &ThreadId,
        _: &TurnId,
        _: &ash_protocol::CommandId,
        _: &[ash_protocol::UserInput],
    ) -> Result<(), CoreError> {
        // The durable input is already visible to the next local model/tool safe point.
        Ok(())
    }
}

fn is_first_model_invocation(snapshot: &crate::ThreadSnapshot, turn_id: &TurnId) -> bool {
    !snapshot.items.iter().any(|item| {
        item.turn_id() == turn_id
            && matches!(
                item,
                ash_protocol::ThreadItem::AgentMessage { .. }
                    | ash_protocol::ThreadItem::ToolCall { .. }
                    | ash_protocol::ThreadItem::ToolResult { .. }
            )
    })
}

fn current_turn_query(snapshot: &crate::ThreadSnapshot, turn_id: &TurnId) -> Option<String> {
    let query = snapshot
        .items
        .iter()
        .filter_map(|item| match item {
            ash_protocol::ThreadItem::UserMessage {
                turn_id: item_turn,
                text,
                ..
            } if item_turn == turn_id => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!query.trim().is_empty()).then_some(query)
}

fn validate_model_tool_calls(
    calls: &[ToolCall],
    definitions: &[ash_protocol::ToolDefinition],
) -> Result<(), CoreError> {
    let allowed = definitions
        .iter()
        .map(|definition| &definition.name)
        .collect::<BTreeSet<_>>();
    if let Some(call) = calls.iter().find(|call| !allowed.contains(&call.name)) {
        return Err(CoreError::Policy(format!(
            "model requested a Tool outside the current invocation capability scope: {}",
            call.name
        )));
    }
    Ok(())
}

pub(super) fn activated_tool_names(
    tools: &dyn ToolService,
    items: &[ThreadItem],
    turn_id: &TurnId,
) -> Result<BTreeSet<ash_protocol::ToolName>, CoreError> {
    let mut calls = BTreeMap::new();
    for item in items {
        if let ThreadItem::ToolCall {
            turn_id: item_turn_id,
            tool_call_id,
            name,
            arguments_json,
            ..
        } = item
            && item_turn_id == turn_id
        {
            let arguments = serde_json::from_str(arguments_json).map_err(|error| {
                CoreError::Execution(format!(
                    "durable Tool Call arguments could not be reconstructed: {error}"
                ))
            })?;
            calls.insert(
                tool_call_id.clone(),
                ToolCall {
                    id: tool_call_id.clone(),
                    name: name.clone(),
                    arguments,
                },
            );
        }
    }

    let mut activated = BTreeSet::new();
    for item in items {
        if let ThreadItem::ToolResult {
            turn_id: item_turn_id,
            tool_call_id,
            text,
            is_error: false,
            ..
        } = item
            && item_turn_id == turn_id
            && let Some(call) = calls.get(tool_call_id)
        {
            activated.extend(tools.activated_tool_names(call, text)?);
        }
    }
    Ok(activated)
}

struct InvocationStream {
    threads: Arc<ThreadController>,
    updates: Arc<dyn ThreadUpdateSink>,
    session_id: ash_protocol::SessionId,
    thread_id: ThreadId,
    turn_id: TurnId,
    durable_sequence: u64,
    stream_instance_id: StreamInstanceId,
    next_stream_sequence: u64,
    cancellation: CancellationToken,
    text_item_id: Option<ItemId>,
    reasoning_item_id: Option<ItemId>,
    assistant_text: AssistantTextStreamParser,
    text: String,
    reasoning: String,
}

impl InvocationStream {
    #[allow(clippy::too_many_arguments)]
    fn new(
        threads: Arc<ThreadController>,
        updates: Arc<dyn ThreadUpdateSink>,
        session_id: ash_protocol::SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        durable_sequence: u64,
        cancellation: CancellationToken,
    ) -> Self {
        let stream_instance_id = threads.next_stream_instance_id();
        Self {
            threads,
            updates,
            session_id,
            thread_id,
            turn_id,
            durable_sequence,
            stream_instance_id,
            next_stream_sequence: 0,
            cancellation,
            text_item_id: None,
            reasoning_item_id: None,
            assistant_text: AssistantTextStreamParser::new(AssistantTextMode::Message),
            text: String::new(),
            reasoning: String::new(),
        }
    }

    fn text_item_id(&self) -> Option<ItemId> {
        self.text_item_id.clone()
    }

    fn take_reasoning(&mut self) -> Option<(ItemId, String)> {
        self.reasoning_item_id
            .take()
            .map(|item_id| (item_id, std::mem::take(&mut self.reasoning)))
    }

    fn publish(&mut self, update: ThreadUpdate) {
        self.next_stream_sequence = self.next_stream_sequence.saturating_add(1);
        self.updates.publish(ThreadUpdateEnvelope {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            durable_sequence: self.durable_sequence,
            stream_cursor: Some(StreamCursor {
                stream_instance_id: self.stream_instance_id.clone(),
                sequence: self.next_stream_sequence,
            }),
            update,
        });
    }

    fn start_text_item(&mut self) -> ItemId {
        if let Some(item_id) = &self.text_item_id {
            return item_id.clone();
        }
        let item_id = self.threads.next_stream_item_id();
        self.publish(ThreadUpdate::ItemStarted {
            turn_id: self.turn_id.clone(),
            item: ThreadItem::AgentMessage {
                item_id: item_id.clone(),
                turn_id: self.turn_id.clone(),
                text: String::new(),
            },
        });
        self.text_item_id = Some(item_id.clone());
        item_id
    }

    fn start_reasoning_item(&mut self) -> ItemId {
        if let Some(item_id) = &self.reasoning_item_id {
            return item_id.clone();
        }
        let item_id = self.threads.next_stream_item_id();
        self.publish(ThreadUpdate::ItemStarted {
            turn_id: self.turn_id.clone(),
            item: ThreadItem::Reasoning {
                item_id: item_id.clone(),
                turn_id: self.turn_id.clone(),
                text: String::new(),
            },
        });
        self.reasoning_item_id = Some(item_id.clone());
        item_id
    }

    fn publish_text_delta(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        let item_id = self.start_text_item();
        self.text.push_str(&text);
        self.publish(ThreadUpdate::ItemDelta {
            turn_id: self.turn_id.clone(),
            item_id,
            delta: ash_protocol::ItemDelta::AgentMessage { text },
        });
    }

    fn finish_text(&mut self) {
        let parsed = self.assistant_text.finish();
        self.publish_text_delta(parsed.visible_text);
    }
}

impl ModelStreamSink for InvocationStream {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), CoreError> {
        self.cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        match event {
            ModelStreamEvent::TextDelta(text) if !text.is_empty() => {
                let parsed = self.assistant_text.push_str(&text);
                self.publish_text_delta(parsed.visible_text);
            }
            ModelStreamEvent::ReasoningDelta(text) if !text.is_empty() => {
                let item_id = self.start_reasoning_item();
                self.reasoning.push_str(&text);
                self.publish(ThreadUpdate::ItemDelta {
                    turn_id: self.turn_id.clone(),
                    item_id,
                    delta: ash_protocol::ItemDelta::Reasoning { text },
                });
            }
            ModelStreamEvent::TextDelta(_) | ModelStreamEvent::ReasoningDelta(_) => {}
        }
        Ok(())
    }
}

fn final_text(response: &ModelResponse, stream: &InvocationStream) -> String {
    let text = response.text();
    if text.is_empty() {
        stream.text.clone()
    } else {
        strip_citations(&text).0
    }
}

enum ExecutionFailure {
    Cancelled(CoreError),
    Interrupted(CoreError),
    Failed {
        error: CoreError,
        stable: StableTurnError,
    },
}

impl ExecutionFailure {
    fn model(error: CoreError) -> Self {
        Self::Failed {
            error,
            stable: StableTurnError::model_invocation_failed(),
        }
    }

    fn service(error: CoreError) -> Self {
        match error {
            CoreError::ModelFailure(ref stable)
            | CoreError::ModelTransient {
                failure: ref stable,
                ..
            } => Self::Failed {
                stable: stable.clone(),
                error,
            },
            CoreError::Cancelled(_) => Self::Cancelled(error),
            CoreError::PolicyCircuitBreaker(_) => Self::Interrupted(error),
            error @ CoreError::ModelContextOverflow => Self::Failed {
                error,
                stable: StableTurnError::context_overflow(),
            },
            error @ CoreError::ModelAuthFailed => Self::Failed {
                error,
                stable: StableTurnError::provider_auth(),
            },
            error @ CoreError::ModelInvalidRequest => Self::Failed {
                error,
                stable: StableTurnError::invalid_request(),
            },
            error @ CoreError::ModelInvalidResponse => Self::Failed {
                error,
                stable: StableTurnError::invalid_response(),
            },
            error @ CoreError::ModelUsageLimited => Self::Failed {
                error,
                stable: StableTurnError::usage_limited(),
            },
            error @ CoreError::ToolRepetition(_) => Self::Failed {
                error,
                stable: StableTurnError::tool_repetition(),
            },
            _ => Self::model(error),
        }
    }

    fn persistence(error: CoreError) -> Self {
        Self::Failed {
            error,
            stable: StableTurnError::completion_persistence_failed(),
        }
    }
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), ExecutionFailure> {
    cancellation
        .check()
        .map_err(|signal| ExecutionFailure::Cancelled(cancelled_error(&signal)))
}

fn cancelled_error(signal: &Cancellation<CancellationReason>) -> CoreError {
    CoreError::Cancelled(signal.reason().to_string())
}

fn response_failure_message(response: &ash_protocol::ModelResponse) -> String {
    response
        .output
        .iter()
        .find_map(|item| match item {
            ResponseItem::Refusal(message) => Some(format!("model refused the request: {message}")),
            _ => None,
        })
        .unwrap_or_else(|| "model returned no final text or Tool Call".into())
}

fn response_refusal_message(response: &ash_protocol::ModelResponse) -> Option<String> {
    response.output.iter().find_map(|item| match item {
        ResponseItem::Refusal(message) => Some(message.clone()),
        _ => None,
    })
}

fn current_unix_ms() -> Result<u64, CoreError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            CoreError::Execution(format!("system clock precedes Unix epoch: {error}"))
        })?;
    u64::try_from(elapsed.as_millis())
        .map_err(|_| CoreError::Execution("current Unix timestamp overflowed u64".into()))
}

fn wait_for_model_retry(
    cancellation: &CancellationToken,
    attempt: u32,
    retry_after_ms: Option<u64>,
) -> Result<(), ExecutionFailure> {
    let delay_ms = match retry_after_ms {
        Some(value) => value.min(60_000),
        None => {
            let base = 1_000_u64.saturating_mul(2_u64.saturating_pow(attempt));
            let jitter = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.subsec_nanos() as u64 % 51)
                .unwrap_or(25);
            (base.saturating_mul(75 + jitter) / 100).min(30_000)
        }
    };
    let mut remaining = delay_ms;
    while remaining > 0 {
        check_cancellation(cancellation)?;
        let step = remaining.min(100);
        std::thread::sleep(Duration::from_millis(step));
        remaining -= step;
    }
    Ok(())
}

fn retry_invalid_model_response<T>(
    mut operation: impl FnMut() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    match operation() {
        Err(CoreError::ModelInvalidResponse) => operation(),
        result => result,
    }
}

#[cfg(test)]
#[path = "executor_tests.rs"]
mod tests;
