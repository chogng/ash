//! Code Mode runtime selection and Core-facing session adapter.

mod host;

use ash_code_mode_protocol::{
    CellId, CodeModeLimits, CodeModeSessionId, ExecuteRequest, StartedCell, WaitOutcome,
    WaitRequest,
};
use ash_code_mode_runtime::CodeModeRuntime as EmbeddedRuntime;
use std::path::PathBuf;
use std::sync::Arc;

pub use ash_code_mode_runtime::{CodeModeStore, RuntimeError, ToolInvoker};

const RUNTIME_ENV: &str = "ASH_CODE_MODE_RUNTIME";
const HOST_BIN_ENV: &str = "ASH_CODE_MODE_HOST_BIN";

/// Core-facing session that uses embedded V8 by default and an isolated Host when explicitly
/// selected for the process.
#[derive(Clone)]
pub struct CodeModeRuntime {
    inner: RuntimeImplementation,
}

#[derive(Clone)]
enum RuntimeImplementation {
    Embedded(EmbeddedRuntime),
    Host(host::HostRuntime),
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
        match selected_host_program()? {
            Some(program) => {
                host::HostRuntime::spawn(program, session_id, limits, invoker, stored_values).map(
                    |runtime| Self {
                        inner: RuntimeImplementation::Host(runtime),
                    },
                )
            }
            None => EmbeddedRuntime::new_with_store(session_id, limits, invoker, stored_values)
                .map(|runtime| Self {
                    inner: RuntimeImplementation::Embedded(runtime),
                }),
        }
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
        host::HostRuntime::spawn(program, session_id, limits, invoker, stored_values).map(
            |runtime| Self {
                inner: RuntimeImplementation::Host(runtime),
            },
        )
    }

    pub fn execute(&self, request: ExecuteRequest) -> Result<StartedCell, RuntimeError> {
        match &self.inner {
            RuntimeImplementation::Embedded(runtime) => runtime.execute(request),
            RuntimeImplementation::Host(runtime) => runtime.execute(request),
        }
    }

    pub fn wait(&self, request: WaitRequest) -> Result<WaitOutcome, RuntimeError> {
        match &self.inner {
            RuntimeImplementation::Embedded(runtime) => runtime.wait(request),
            RuntimeImplementation::Host(runtime) => runtime.wait(request),
        }
    }

    pub fn terminate(&self, cell_id: &CellId) -> Result<WaitOutcome, RuntimeError> {
        match &self.inner {
            RuntimeImplementation::Embedded(runtime) => runtime.terminate(cell_id),
            RuntimeImplementation::Host(runtime) => runtime.terminate(cell_id),
        }
    }

    pub fn has_cell(&self, cell_id: &CellId) -> bool {
        match &self.inner {
            RuntimeImplementation::Embedded(runtime) => runtime.has_cell(cell_id),
            RuntimeImplementation::Host(runtime) => runtime.has_cell(cell_id),
        }
    }

    pub fn close(&self) {
        match &self.inner {
            RuntimeImplementation::Embedded(runtime) => runtime.close(),
            RuntimeImplementation::Host(runtime) => runtime.close(),
        }
    }
}

fn selected_host_program() -> Result<Option<PathBuf>, RuntimeError> {
    let mode = std::env::var(RUNTIME_ENV).unwrap_or_else(|_| "embedded".into());
    match mode.trim().to_ascii_lowercase().as_str() {
        "" | "embedded" => Ok(None),
        "host" => {
            if let Some(program) = std::env::var_os(HOST_BIN_ENV) {
                return Ok(Some(PathBuf::from(program)));
            }
            let file_name = if cfg!(windows) {
                "ash-code-mode-host.exe"
            } else {
                "ash-code-mode-host"
            };
            let program = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.join(file_name)))
                .unwrap_or_else(|| PathBuf::from(file_name));
            Ok(Some(program))
        }
        other => Err(RuntimeError::Initialization(format!(
            "unsupported {RUNTIME_ENV} value `{other}`; expected `embedded` or `host`"
        ))),
    }
}
