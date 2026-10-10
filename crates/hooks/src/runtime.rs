use crate::matcher::matches_event;
use crate::outcome::HookDecision;
use crate::policy::execution_authority;
use crate::process::HookProcessExecutor;
use crate::process::LocalHookProcessExecutor;
use crate::protocol::HookInvocation;
use crate::protocol::encode_input;
use crate::records::HookRunLog;
use crate::records::HookRunRecord;
use ash_async_utils::CancellationToken;
use ash_config::HookEnablement;
use ash_config::HooksConfig;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use core_api::ActionPolicyService;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookDecision;
use core_api::BeforeToolHookRequest;
use core_api::CoreError;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookExecutionEvent;
use core_api::HookExecutionObserver;
use core_api::HookService;
use core_api::NoHookExecutionObserver;
use core_api::TurnCompletedHookRequest;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::RwLock;

struct SessionHookBinding {
    config: HooksConfig,
    discovery: Authorization,
    execution: Authorization,
    process: Arc<dyn HookProcessExecutor>,
}

struct ThreadDirHookBinding {
    dir: Dir,
    process: Option<Arc<dyn HookProcessExecutor>>,
}

/// Shared host runtime for declarative Hooks.
///
/// The runtime keeps configuration separate from the current directory executor. A directory
/// without execution permission has no process runner, while a configuration update can
/// replace the immutable Hook snapshot without rebuilding Core's Turn executor.
pub struct DeclarativeHookRuntime {
    config: RwLock<HooksConfig>,
    policy: Arc<dyn ActionPolicyService>,
    process: RwLock<Option<Arc<dyn HookProcessExecutor>>>,
    thread_dir_bindings: RwLock<BTreeMap<ThreadId, ThreadDirHookBinding>>,
    session_bindings: RwLock<BTreeMap<SessionId, Vec<SessionHookBinding>>>,
    execution_observer: RwLock<Arc<dyn HookExecutionObserver>>,
    run_observer: RwLock<Option<Arc<dyn core_api::HookRunObserver>>>,
    runs: HookRunLog,
}

impl DeclarativeHookRuntime {
    /// Runs a host-configured process Hook under the same action policy and directory sandbox.
    /// Output stays bounded; cancellation and timeout terminate the owned process tree.
    pub fn execute_process(
        &self,
        hook: &ash_config::HookConfig,
        dir: Dir,
        timeout: std::time::Duration,
        cancellation: &CancellationToken,
    ) -> Result<ash_tool_executor::CommandOutput, CoreError> {
        if timeout.is_zero() {
            return Err(CoreError::InvalidInput(
                "Workflow Hook timeout must be positive".into(),
            ));
        }
        let authority = execution_authority(hook, &dir, self.policy.as_ref(), cancellation)?;
        LocalHookProcessExecutor::execute_process(dir, hook, authority, timeout, cancellation)
    }

    /// Creates an unbound runtime from an initial declaration snapshot and host policy.
    pub fn new(config: HooksConfig, policy: Arc<dyn ActionPolicyService>) -> Self {
        Self {
            config: RwLock::new(config),
            policy,
            process: RwLock::new(None),
            thread_dir_bindings: RwLock::new(BTreeMap::new()),
            session_bindings: RwLock::new(BTreeMap::new()),
            execution_observer: RwLock::new(Arc::new(NoHookExecutionObserver)),
            run_observer: RwLock::new(None),
            runs: HookRunLog::new(),
        }
    }

    /// Replaces the declaration snapshot used by future Hook invocations.
    pub fn replace_config(&self, config: HooksConfig) {
        *self
            .config
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = config;
    }

    /// Binds process execution to an explicitly authorized directory.
    pub fn bind_dir(&self, dir: Dir) -> Result<(), HookDirBindingError> {
        let has_enabled_hooks = self
            .config
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .hooks
            .values()
            .any(|hook| hook.enablement == HookEnablement::Enabled);
        if !has_enabled_hooks {
            self.unbind_dir();
            return Ok(());
        }
        let process = LocalHookProcessExecutor::new(dir);
        *self
            .process
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::new(process));
        Ok(())
    }

    /// Removes the active directory executor so future Hook invocations cannot spawn processes.
    pub fn unbind_dir(&self) {
        *self
            .process
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// Binds Hook execution for one Thread to its managed directory.
    pub fn bind_thread_dir(
        &self,
        thread_id: ThreadId,
        dir: Dir,
    ) -> Result<(), HookDirBindingError> {
        let process = if has_enabled_hooks(
            &self
                .config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        ) {
            Some(Arc::new(LocalHookProcessExecutor::new(dir.clone()))
                as Arc<dyn HookProcessExecutor>)
        } else {
            None
        };
        self.thread_dir_bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thread_id, ThreadDirHookBinding { dir, process });
        Ok(())
    }

    pub fn unbind_thread_dir(&self, thread_id: &ThreadId) {
        self.thread_dir_bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(thread_id);
    }

    pub fn set_execution_observer(&self, observer: Arc<dyn HookExecutionObserver>) {
        *self
            .execution_observer
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = observer;
    }

    /// Installs the host's history sink independently of the process-write observer.
    pub fn set_run_observer(&self, observer: Arc<dyn core_api::HookRunObserver>) {
        *self
            .run_observer
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(observer);
    }

    /// Replaces session-dir Hook bindings for one Session.
    pub fn replace_session_dirs(
        &self,
        session_id: SessionId,
        workspaces: Vec<(HooksConfig, Authorization, Authorization)>,
    ) -> Result<(), HookDirBindingError> {
        let mut bindings = Vec::new();
        for (config, discovery, execution) in workspaces {
            discovery
                .ensure_active()
                .map_err(|error| HookDirBindingError {
                    message: error.to_string(),
                })?;
            execution
                .ensure_active()
                .map_err(|error| HookDirBindingError {
                    message: error.to_string(),
                })?;
            let process = Arc::new(LocalHookProcessExecutor::new(execution.dir().clone()));
            bindings.push(SessionHookBinding {
                config,
                discovery,
                execution,
                process,
            });
        }
        let mut sessions = self
            .session_bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if bindings.is_empty() {
            sessions.remove(&session_id);
        } else {
            sessions.insert(session_id, bindings);
        }
        Ok(())
    }

    pub fn remove_session(&self, session_id: &SessionId) {
        self.session_bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    /// Returns the bounded, non-durable projection of recent Hook invocations.
    pub fn recent_runs(&self) -> Vec<HookRunRecord> {
        self.runs.snapshot()
    }

    #[cfg(test)]
    pub(crate) fn with_process(
        config: HooksConfig,
        policy: Arc<dyn ActionPolicyService>,
        process: Arc<dyn HookProcessExecutor>,
    ) -> Self {
        Self {
            config: RwLock::new(config),
            policy,
            process: RwLock::new(Some(process)),
            thread_dir_bindings: RwLock::new(BTreeMap::new()),
            session_bindings: RwLock::new(BTreeMap::new()),
            execution_observer: RwLock::new(Arc::new(NoHookExecutionObserver)),
            run_observer: RwLock::new(None),
            runs: HookRunLog::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn bind_thread_process(
        &self,
        thread_id: ThreadId,
        process: Arc<dyn HookProcessExecutor>,
    ) {
        self.thread_dir_bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                thread_id,
                ThreadDirHookBinding {
                    dir: process.dir().clone(),
                    process: Some(process),
                },
            );
    }

    fn run_event(
        &self,
        invocation: &HookInvocation<'_>,
        cancellation: &CancellationToken,
    ) -> Result<HookDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let config = self
            .config
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let process = invocation
            .thread_id()
            .map(|thread_id| self.thread_process(thread_id, &config))
            .transpose()?
            .flatten()
            .or_else(|| {
                self.process
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            });
        if let Some(process) = process {
            let decision = self.run_config(&config, process.as_ref(), invocation, cancellation)?;
            if matches!(decision, HookDecision::Deny { .. }) {
                return Ok(decision);
            }
        }
        let sessions = self
            .session_bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(bindings) = invocation.session_id().and_then(|id| sessions.get(id)) {
            for binding in bindings {
                if binding.discovery.ensure_active().is_err()
                    || binding.execution.ensure_active().is_err()
                {
                    continue;
                }
                let decision = self.run_config(
                    &binding.config,
                    binding.process.as_ref(),
                    invocation,
                    cancellation,
                )?;
                if matches!(decision, HookDecision::Deny { .. }) {
                    return Ok(decision);
                }
            }
        }
        Ok(HookDecision::Continue)
    }

    fn run_config(
        &self,
        config: &HooksConfig,
        process: &dyn HookProcessExecutor,
        invocation: &HookInvocation<'_>,
        cancellation: &CancellationToken,
    ) -> Result<HookDecision, CoreError> {
        for hook in config.hooks.values() {
            cancellation
                .check()
                .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
            if hook.enablement != HookEnablement::Enabled || !matches_event(hook, invocation) {
                continue;
            }
            let started = self.runs.start(hook, invocation);
            let scope = invocation.scope();
            let run_observer = self
                .run_observer
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let ash_config::HookAction::Process { program, args } = &hook.action;
            let mut evidence = core_api::HookRunEvidence {
                program: program.clone(),
                arguments: args.clone(),
                directory: process.dir().canonical_path().to_path_buf(),
                input: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                stdout_truncated: false,
                stderr_truncated: false,
            };
            let result = (|| {
                if let Some(observer) = &run_observer {
                    observer.updated(&scope, &started.record, None)?;
                }
                let authority =
                    execution_authority(hook, process.dir(), self.policy.as_ref(), cancellation)?;
                let input = encode_input(hook, invocation, process.dir().canonical_path())?;
                evidence.input = String::from_utf8_lossy(&input).into_owned();
                let observer = self
                    .execution_observer
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                let event = match (
                    invocation.session_id(),
                    invocation.thread_id(),
                    invocation.turn_id(),
                ) {
                    (Some(session_id), Some(thread_id), Some(turn_id)) => {
                        Some(HookExecutionEvent {
                            session_id: session_id.clone(),
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                            hook_id: hook.id.to_string(),
                            dir: process.dir().canonical_path().to_path_buf(),
                        })
                    }
                    _ => None,
                };
                if let Some(event) = &event {
                    observer.will_execute(event)?;
                }
                let result = process.execute(hook, input, authority, cancellation, &mut evidence);
                if let Some(event) = &event {
                    observer.did_finish(event);
                }
                let decision = result?;
                if matches!(
                    invocation,
                    HookInvocation::AfterTool(_) | HookInvocation::TurnCompleted(_)
                ) {
                    require_observational_result(decision.clone(), "observational")?;
                }
                Ok(decision)
            })();
            let completed = self.runs.finish(started, &result);
            if let Some(observer) = &run_observer {
                observer.updated(&scope, &completed, Some(&evidence))?;
            }
            let decision = result?;
            if matches!(decision, HookDecision::Deny { .. }) {
                return Ok(decision);
            }
        }
        Ok(HookDecision::Continue)
    }

    fn thread_process(
        &self,
        thread_id: &ThreadId,
        config: &HooksConfig,
    ) -> Result<Option<Arc<dyn HookProcessExecutor>>, CoreError> {
        let mut bindings = self
            .thread_dir_bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(binding) = bindings.get_mut(thread_id) else {
            return Ok(None);
        };
        if binding.process.is_none() && has_enabled_hooks(config) {
            binding.process = Some(Arc::new(LocalHookProcessExecutor::new(binding.dir.clone())));
        }
        Ok(binding.process.clone())
    }
}

fn has_enabled_hooks(config: &HooksConfig) -> bool {
    config
        .hooks
        .values()
        .any(|hook| hook.enablement == HookEnablement::Enabled)
}

impl HookService for DeclarativeHookRuntime {
    fn has_enabled_event(&self, event: ash_protocol::HookEvent) -> bool {
        let config = self
            .config
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if config
            .hooks
            .values()
            .any(|hook| hook.enablement == HookEnablement::Enabled && hook.event == event)
        {
            return true;
        }
        self.session_bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .flatten()
            .any(|binding| {
                binding
                    .config
                    .hooks
                    .values()
                    .any(|hook| hook.enablement == HookEnablement::Enabled && hook.event == event)
            })
    }

    fn event(
        &self,
        request: &HookEventRequest,
        cancellation: &CancellationToken,
    ) -> Result<HookEventDecision, CoreError> {
        match self.run_event(&HookInvocation::Event(request), cancellation)? {
            HookDecision::Continue => Ok(HookEventDecision::Continue),
            HookDecision::Deny { reason } => Ok(HookEventDecision::Deny { reason }),
        }
    }

    fn before_tool(
        &self,
        request: &BeforeToolHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<BeforeToolHookDecision, CoreError> {
        match self.run_event(&HookInvocation::BeforeTool(request), cancellation)? {
            HookDecision::Continue => Ok(BeforeToolHookDecision::Continue),
            HookDecision::Deny { reason } => Ok(BeforeToolHookDecision::Deny { reason }),
        }
    }

    fn after_tool(
        &self,
        request: &AfterToolHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError> {
        require_observational_result(
            self.run_event(&HookInvocation::AfterTool(request), cancellation)?,
            "afterTool",
        )
    }

    fn turn_completed(
        &self,
        request: &TurnCompletedHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError> {
        require_observational_result(
            self.run_event(&HookInvocation::TurnCompleted(request), cancellation)?,
            "turnCompleted",
        )
    }
}

fn require_observational_result(decision: HookDecision, event_name: &str) -> Result<(), CoreError> {
    match decision {
        HookDecision::Continue => Ok(()),
        HookDecision::Deny { .. } => Err(CoreError::Execution(format!(
            "{event_name} Hook cannot deny an operation that has already completed"
        ))),
    }
}

/// Failure to construct the sandboxed process executor for a authorized directory.
#[derive(Debug)]
pub struct HookDirBindingError {
    message: String,
}

impl std::fmt::Display for HookDirBindingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "could not bind declarative Hooks to the directory: {}",
            self.message
        )
    }
}

impl std::error::Error for HookDirBindingError {}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
