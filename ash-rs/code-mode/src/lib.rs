//! Core-facing Code Mode sessions executed in an isolated Host process.

mod host;

use ash_code_mode_protocol::{
    CellId, CodeModeLimits, CodeModeSessionId, ExecuteRequest, StartedCell, WaitOutcome,
    WaitRequest,
};
use std::path::PathBuf;
use std::sync::Arc;

pub use ash_code_mode_session::limit_output;
pub use ash_code_mode_session::{CodeModeStore, RuntimeError, ToolInvoker};

const HOST_BIN_ENV: &str = "ASH_CODE_MODE_HOST_BIN";

/// Core-facing session backed by an isolated Code Mode Host.
#[derive(Clone)]
pub struct CodeModeRuntime {
    inner: host::HostRuntime,
}

impl CodeModeRuntime {
    pub fn new(
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        invoker: Arc<dyn ToolInvoker>,
    ) -> Result<Self, RuntimeError> {
        Self::new_with_store(session_id, limits, invoker, CodeModeStore::new())
    }

    pub fn new_with_store(
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        invoker: Arc<dyn ToolInvoker>,
        stored_values: CodeModeStore,
    ) -> Result<Self, RuntimeError> {
        Self::new_host(host_program()?, session_id, limits, invoker, stored_values)
    }

    /// Starts one explicitly selected isolated Host. This is also useful for embedders that do
    /// not use process environment configuration.
    pub fn new_host(
        program: PathBuf,
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        invoker: Arc<dyn ToolInvoker>,
        stored_values: CodeModeStore,
    ) -> Result<Self, RuntimeError> {
        host::HostRuntime::spawn(program, session_id, limits, invoker, stored_values)
            .map(|runtime| Self { inner: runtime })
    }

    pub fn execute(&self, request: ExecuteRequest) -> Result<StartedCell, RuntimeError> {
        self.inner.execute(request)
    }

    pub fn wait(&self, request: WaitRequest) -> Result<WaitOutcome, RuntimeError> {
        self.inner.wait(request)
    }

    pub fn terminate(&self, cell_id: &CellId) -> Result<WaitOutcome, RuntimeError> {
        self.inner.terminate(cell_id)
    }

    pub fn has_cell(&self, cell_id: &CellId) -> bool {
        self.inner.has_cell(cell_id)
    }

    pub fn close(&self) {
        self.inner.close()
    }
}

fn host_program() -> Result<PathBuf, RuntimeError> {
    if let Some(program) = std::env::var_os(HOST_BIN_ENV) {
        if program.is_empty() {
            return Err(RuntimeError::Initialization(format!(
                "{HOST_BIN_ENV} is empty"
            )));
        }
        return Ok(PathBuf::from(program));
    }
    let executable =
        std::env::current_exe().map_err(|error| RuntimeError::Initialization(error.to_string()))?;
    let directory = executable.parent().ok_or_else(|| {
        RuntimeError::Initialization("Current executable has no parent directory".into())
    })?;
    Ok(directory.join(format!(
        "ash-code-mode-host{}",
        std::env::consts::EXE_SUFFIX
    )))
}
