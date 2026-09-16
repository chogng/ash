use super::super::tool_execution::ToolExecutionContext;
use super::catalog::control_definition;
use super::catalog::control_definitions;
use super::catalog::is_control_name;
use super::catalog::optional_u64;
use super::catalog::parse_exec_source;
use super::catalog::projected_tools;
use super::catalog::required_string;
use super::invoker::BrokerToolInvoker;
use super::response::cancellation_aware_terminate_or_wait;
use super::response::observe_runtime;
use super::response::runtime_error;
use super::response::runtime_wait_output;
use crate::ActionPolicyService;
use crate::CoreError;
use crate::HookService;
use crate::ThreadController;
use crate::ThreadUpdateSink;
use crate::ToolExecutionOutput;
use crate::ToolService;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionSource;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_code_mode::CodeModeRuntime;
use ash_code_mode::CodeModeStore;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::ExecuteRequest;
use ash_protocol::ThreadId;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallBinding;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use ash_protocol::ToolMode;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

/// Reserved model-facing Code Mode control tool name.
pub const EXEC_TOOL_NAME: &str = "exec";
/// Reserved model-facing Code Mode control tool name.
pub const WAIT_TOOL_NAME: &str = "wait";

/// Core-owned broker that connects Code Mode cells to the ordinary durable Tool scheduler.
#[derive(Clone)]
pub struct CodeModeBroker {
    inner: Arc<CodeModeBrokerInner>,
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
}

pub(super) struct CodeModeBrokerInner {
    pub(super) threads: Arc<ThreadController>,
    pub(super) runtimes: Mutex<BTreeMap<RuntimeKey, CodeModeRuntime>>,
    pub(super) session_stores: Mutex<BTreeMap<(String, String), CodeModeStore>>,
    pub(super) cell_calls: Mutex<BTreeMap<(RuntimeKey, String), CellCall>>,
}

#[derive(Clone)]
pub(super) struct CellCall {
    pub(super) parent: ToolCallId,
    pub(super) catalog: crate::ModelToolCatalogSnapshot,
    pub(super) tools: Arc<dyn ToolService>,
    pub(super) policy: Arc<dyn ActionPolicyService>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct RuntimeKey {
    pub(super) session_id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: String,
}

impl RuntimeKey {
    pub(super) fn new(
        session_id: impl Into<String>,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
        }
    }

    pub(super) fn session_id(&self) -> Result<CodeModeSessionId, CoreError> {
        CodeModeSessionId::new(format!(
            "code-mode-{}-{}-{}",
            self.session_id, self.thread_id, self.turn_id
        ))
        .map_err(|error| CoreError::Execution(error.to_string()))
    }

    pub(super) fn thread_id(&self) -> Result<ThreadId, CoreError> {
        ThreadId::new(self.thread_id.clone())
            .map_err(|error| CoreError::Execution(error.to_string()))
    }

    pub(super) fn turn_id(&self) -> Result<TurnId, CoreError> {
        TurnId::new(self.turn_id.clone()).map_err(|error| CoreError::Execution(error.to_string()))
    }
}

impl CodeModeBroker {
    pub(crate) fn new(
        threads: Arc<ThreadController>,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        Self {
            tools,
            policy,
            inner: Arc::new(CodeModeBrokerInner {
                threads,
                runtimes: Mutex::new(BTreeMap::new()),
                session_stores: Mutex::new(BTreeMap::new()),
                cell_calls: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    /// Rebinds future execution services while retaining live cells and their frozen invokers.
    pub(crate) fn with_tool_service(
        &self,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            tools,
            policy,
        }
    }

    /// Closes the process-local runtime owned by one terminal Turn and drops its cell bindings.
    /// Cells are intentionally scoped to that Turn in the first Core integration, so a later
    /// Turn cannot accidentally resume a cell with the wrong durable parent or tool authority.
    pub(crate) fn close_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<(), CoreError> {
        let snapshot = self.inner.threads.read_thread(thread_id)?;
        let key = RuntimeKey::new(snapshot.session_id.to_string(), thread_id, turn_id);
        let runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode runtime registry was poisoned".into()))?
            .remove(&key);
        if let Some(runtime) = runtime {
            runtime.close();
        }
        self.inner
            .cell_calls
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode cell registry was poisoned".into()))?
            .retain(|(runtime_key, _), _| runtime_key != &key);
        Ok(())
    }

    pub(crate) fn close_session(&self, session_id: &ash_protocol::SessionId) {
        let session_id = session_id.as_str();
        let removed = {
            let mut runtimes = self
                .inner
                .runtimes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let keys = runtimes
                .keys()
                .filter(|key| key.session_id == session_id)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| runtimes.remove(&key))
                .collect::<Vec<_>>()
        };
        for runtime in removed {
            runtime.close();
        }
        self.inner
            .cell_calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(key, _), _| key.session_id != session_id);
        self.inner
            .session_stores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(session, _), _| session != session_id);
    }

    pub(crate) fn augment_catalog(
        &self,
        catalog: crate::ModelToolCatalogSnapshot,
        mode: ToolMode,
    ) -> Result<crate::ModelToolCatalogSnapshot, CoreError> {
        if !mode.requires_code_mode() {
            return Ok(catalog);
        }
        let definitions = control_definitions();
        if catalog
            .definitions()
            .iter()
            .any(|definition| is_control_name(&definition.name))
        {
            return Err(CoreError::Policy(
                "ordinary Tool catalog conflicts with the reserved Code Mode control tool name"
                    .into(),
            ));
        }
        if mode == ToolMode::CodeModeOnly {
            return Ok(crate::ModelToolCatalogSnapshot::new(definitions));
        }
        Ok(catalog.with_additional_definitions(definitions))
    }

    pub(crate) fn bind_control_call(
        &self,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        let Some(definition) = control_definition(&call.name) else {
            return Ok(None);
        };
        if !matches!(caller, ToolCallCaller::Direct) {
            return Err(CoreError::Policy(
                "Code Mode control tools may only be called directly by the model".into(),
            ));
        }
        let definition_digest = ActionDigest::from_canonical_bytes(
            serde_json::to_vec(&definition)
                .map_err(|error| CoreError::Execution(error.to_string()))?,
        );
        Ok(Some(ToolCallBinding {
            registry_incarnation: None,
            registry_generation: 0,
            definition_digest: format!("sha256:{}", definition_digest.as_str()),
            source_chain: vec![ash_protocol::ToolSourceProvenance::System {
                id: "code-mode".into(),
            }],
            caller,
        }))
    }

    pub(crate) fn owns_control_binding(
        &self,
        call: &ToolCall,
        binding: Option<&ToolCallBinding>,
    ) -> bool {
        let Some(binding) = binding else {
            return false;
        };
        self.bind_control_call(call, ToolCallCaller::Direct)
            .ok()
            .flatten()
            .is_some_and(|expected| &expected == binding)
    }

    pub(crate) fn validate_control_binding(
        &self,
        call: &ToolCall,
        binding: Option<&ToolCallBinding>,
    ) -> Result<(), CoreError> {
        let expected = self
            .bind_control_call(call, ToolCallCaller::Direct)?
            .ok_or_else(|| {
                CoreError::Execution(format!("not a Code Mode control tool: {}", call.name))
            })?;
        if Some(&expected) != binding {
            return Err(CoreError::Execution(format!(
                "Code Mode control binding is unavailable or no longer matches {}",
                call.name
            )));
        }
        Ok(())
    }

    pub(crate) fn prepare_control(
        &self,
        call: &ToolCall,
    ) -> Result<ash_action_policy::ActionReviewRequest, CoreError> {
        if !is_control_name(&call.name) {
            return Err(CoreError::Policy(format!(
                "not a Code Mode control tool: {}",
                call.name
            )));
        }
        let digest = ActionDigest::from_canonical_bytes(
            serde_json::to_vec(call).map_err(|error| CoreError::Execution(error.to_string()))?,
        );
        Ok(ash_action_policy::ActionReviewRequest::new(
            ResolvedAction::new(
                digest,
                ActionKind::SystemOperation,
                format!("execute Code Mode {} control request", call.name),
                CapabilitySet::new([Capability::new(
                    CapabilityKind::SystemConfiguration,
                    "code-mode",
                )]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "code-mode"),
            SandboxCompatibility::NotApplicable {
                reason: "Code Mode control execution is isolated by the runtime; nested ordinary tools are reviewed separately".into(),
            },
            ActionPolicyRevision::new(self.policy.revision()),
        ))
    }

    pub(crate) fn execute(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        updates: Arc<dyn ThreadUpdateSink>,
        hooks: Arc<dyn HookService>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match call.name.as_str() {
            EXEC_TOOL_NAME => self.execute_cell(context, call, updates, hooks),
            WAIT_TOOL_NAME => self.wait_cell(context, call),
            _ => Err(CoreError::InvalidInput(format!(
                "not a Code Mode control tool: {}",
                call.name
            ))),
        }
    }

    fn execute_cell(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        updates: Arc<dyn ThreadUpdateSink>,
        hooks: Arc<dyn HookService>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let source = required_string(&call.arguments, &["source", "code"], "source")?;
        let parsed_source = parse_exec_source(&source)?;
        let yield_time_ms = optional_u64(&call.arguments, &["yieldTimeMs", "yield_time_ms"])?
            .or(parsed_source.yield_time_ms)
            .unwrap_or(ash_code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS);
        let max_output_tokens =
            optional_u64(&call.arguments, &["maxOutputTokens", "max_output_tokens"])?
                .or(parsed_source.max_output_tokens.map(u64::from))
                .map(|value| {
                    u32::try_from(value)
                        .map_err(|_| CoreError::InvalidInput("maxOutputTokens is too large".into()))
                })
                .transpose()?;
        let thread_id = context.thread_id().clone();
        let turn_id = context.turn_id().clone();
        let snapshot = self.inner.threads.read_thread(&thread_id)?;
        let key = RuntimeKey::new(snapshot.session_id.to_string(), &thread_id, &turn_id);
        let activated = super::super::executor::activated_tool_names(
            self.tools.as_ref(),
            &snapshot.items,
            &turn_id,
        )?;
        // CodeModeOnly hides ordinary tools from the model, but those same tools must remain
        // available through the JavaScript projection. Keep the runtime catalog independent from
        // the model-facing mode filter while retaining the exact activated registry snapshot.
        let frozen_catalog = self.tools.code_mode_catalog_snapshot(&activated)?;
        let frozen_catalog = match snapshot.agent_configuration() {
            Some(seed) => frozen_catalog.restrict_to_names(&seed.capability_scope.tools),
            None => frozen_catalog,
        };
        let frozen_catalog = match snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == context.turn_id())
            .and_then(|turn| turn.tool_profile.as_ref())
        {
            Some(profile) if profile.id == crate::tool_profile::SELECTED_CODING_TOOL_PROFILE_ID => {
                frozen_catalog.restrict_to_names(&profile.tool_names)
            }
            _ => frozen_catalog,
        };
        let frozen_definitions = frozen_catalog.definitions().to_vec();
        let projected = projected_tools(&frozen_definitions)?;
        let runtime = self.runtime_for(&key, context.cancellation(), updates, hooks)?;
        let started = runtime
            .execute(ExecuteRequest {
                session_id: key.session_id()?,
                tool_call_id: call.id.to_string(),
                source: parsed_source.source,
                enabled_tools: projected,
                yield_time_ms,
                max_output_tokens,
            })
            .map_err(runtime_error)?;
        self.inner
            .cell_calls
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode cell registry was poisoned".into()))?
            .insert(
                (key.clone(), started.cell_id.to_string()),
                CellCall {
                    parent: call.id.clone(),
                    catalog: frozen_catalog,
                    tools: Arc::clone(&self.tools),
                    policy: Arc::clone(&self.policy),
                },
            );
        let outcome = observe_runtime(
            &runtime,
            started.cell_id.clone(),
            yield_time_ms,
            max_output_tokens,
            context.cancellation(),
        )?;
        self.release_finished_cell(&key, &runtime, &started.cell_id);
        runtime_wait_output(outcome)
    }

    fn wait_cell(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let cell_id = required_string(&call.arguments, &["cellId", "cell_id"], "cellId").and_then(
            |value| CellId::new(value).map_err(|error| CoreError::InvalidInput(error.to_string())),
        )?;
        let yield_time_ms = optional_u64(&call.arguments, &["yieldTimeMs", "yield_time_ms"])?
            .unwrap_or(ash_code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS);
        let max_output_tokens =
            optional_u64(&call.arguments, &["maxOutputTokens", "max_output_tokens"])?
                .map(|value| {
                    u32::try_from(value)
                        .map_err(|_| CoreError::InvalidInput("maxOutputTokens is too large".into()))
                })
                .transpose()?;
        let terminate = call
            .arguments
            .get("terminate")
            .or_else(|| call.arguments.get("terminateCell"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let snapshot = self.inner.threads.read_thread(context.thread_id())?;
        let key = RuntimeKey::new(
            snapshot.session_id.to_string(),
            context.thread_id(),
            context.turn_id(),
        );
        let runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode runtime registry was poisoned".into()))?
            .get(&key)
            .cloned();
        let Some(runtime) = runtime else {
            return Ok(ToolExecutionOutput::Failure(
                "Code Mode cell is unavailable; a process restart never replays a cell".into(),
            ));
        };
        let outcome = if terminate {
            cancellation_aware_terminate_or_wait(
                &runtime,
                cell_id.clone(),
                yield_time_ms,
                max_output_tokens,
                context.cancellation(),
            )?
        } else {
            observe_runtime(
                &runtime,
                cell_id.clone(),
                yield_time_ms,
                max_output_tokens,
                context.cancellation(),
            )?
        };
        self.release_finished_cell(&key, &runtime, &cell_id);
        runtime_wait_output(outcome)
    }

    fn release_finished_cell(&self, key: &RuntimeKey, runtime: &CodeModeRuntime, cell_id: &CellId) {
        if !runtime.has_cell(cell_id) {
            self.inner
                .cell_calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&(key.clone(), cell_id.to_string()));
        }
    }

    fn runtime_for(
        &self,
        key: &RuntimeKey,
        cancellation: &CancellationToken,
        updates: Arc<dyn ThreadUpdateSink>,
        hooks: Arc<dyn HookService>,
    ) -> Result<CodeModeRuntime, CoreError> {
        let mut runtimes =
            self.inner.runtimes.lock().map_err(|_| {
                CoreError::Execution("Code Mode runtime registry was poisoned".into())
            })?;
        if let Some(runtime) = runtimes.get(key) {
            return Ok(runtime.clone());
        }
        let invoker = Arc::new(BrokerToolInvoker::new(
            Arc::downgrade(&self.inner),
            key.clone(),
            cancellation,
            updates,
            hooks,
            self.inner.threads.next_stream_instance_id(),
        ));
        let session_store = self
            .inner
            .session_stores
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode session store was poisoned".into()))?
            .entry((key.session_id.clone(), key.thread_id.clone()))
            .or_default()
            .clone();
        let runtime = CodeModeRuntime::new_with_store(
            key.session_id()?,
            CodeModeLimits::default(),
            invoker,
            session_store,
        )
        .map_err(runtime_error)?;
        runtimes.insert(key.clone(), runtime.clone());
        Ok(runtime)
    }
}
