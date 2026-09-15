use super::environment_runtime::EnvRuntime;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::Weak;
use core_api::CoreError;
use ash_core::TurnExecutionBackend;
use ash_core::TurnExecutor;
use ash_protocol::CommandId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::UserInput;

/// Stable backend handle shared by product Turn dispatch and multi-agent tools.
///
/// Composition replaces the target after all builder-only environment mutations finish, while
/// existing consumers retain this handle and therefore observe the canonical router.
pub(crate) struct TurnBackendHandle {
    target: RwLock<Arc<dyn TurnExecutionBackend>>,
}

impl TurnBackendHandle {
    pub(crate) fn new(executor: TurnExecutor) -> Self {
        Self {
            target: RwLock::new(Arc::new(executor)),
        }
    }

    fn replace(&self, target: Arc<dyn TurnExecutionBackend>) {
        *self
            .target
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = target;
    }

    pub(crate) fn install_executor(&self, executor: TurnExecutor) {
        self.replace(Arc::new(executor));
    }

    pub(crate) fn install_current_environment(&self, runtime: &Arc<RwLock<EnvRuntime>>) {
        self.replace(Arc::new(CurrentLocalTurnBackend::new(runtime)));
    }

    #[cfg(test)]
    pub(crate) fn replace_for_test(&self, target: Arc<dyn TurnExecutionBackend>) {
        self.replace(target);
    }

    fn current(&self) -> Arc<dyn TurnExecutionBackend> {
        Arc::clone(
            &self
                .target
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }
}

impl TurnExecutionBackend for TurnBackendHandle {
    fn start(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        self.current().start(thread_id, turn_id)
    }

    fn resume(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        self.current().resume(thread_id, turn_id)
    }

    fn steer(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        command_id: &CommandId,
        input: &[UserInput],
    ) -> Result<(), CoreError> {
        self.current().steer(thread_id, turn_id, command_id, input)
    }
}

/// Delegates to the latest local executor installed for the active environment.
struct CurrentLocalTurnBackend {
    runtime: Weak<RwLock<EnvRuntime>>,
}

impl CurrentLocalTurnBackend {
    fn new(runtime: &Arc<RwLock<EnvRuntime>>) -> Self {
        Self {
            runtime: Arc::downgrade(runtime),
        }
    }

    fn executor(&self) -> Result<ash_core::TurnExecutor, CoreError> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| CoreError::Execution("local Turn runtime is unavailable".into()))?;
        let executor = runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .turn_executor
            .clone();
        Ok(executor)
    }
}

impl TurnExecutionBackend for CurrentLocalTurnBackend {
    fn start(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        self.executor()?.start(thread_id, turn_id)
    }

    fn resume(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError> {
        self.executor()?.resume(thread_id, turn_id)
    }

    fn steer(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        command_id: &CommandId,
        input: &[UserInput],
    ) -> Result<(), CoreError> {
        self.executor()?
            .steer(thread_id, turn_id, command_id, input)
    }
}
