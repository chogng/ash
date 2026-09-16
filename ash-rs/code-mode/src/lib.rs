//! Core-facing Code Mode sessions executed in a shared, isolated Host process.
mod host;
mod session;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

pub use ash_code_mode_protocol::RuntimeError;
pub use ash_code_mode_protocol::ToolInvoker;
pub use ash_code_mode_protocol::limit_output;
pub use session::CodeModeSession;

/// Backend-owned provider. Starts one Host lazily and replaces it only after failure.
#[derive(Clone, Default)]
pub struct CodeModeHost {
    inner: Arc<HostProvider>,
}

#[derive(Default)]
struct HostProvider {
    program: Option<PathBuf>,
    connection: Mutex<Option<Arc<host::Connection>>>,
}

impl CodeModeHost {
    /// Selects an explicit executable for an embedding application.
    pub fn with_program(program: PathBuf) -> Self {
        Self {
            inner: Arc::new(HostProvider {
                program: Some(program),
                connection: Mutex::new(None),
            }),
        }
    }

    fn connection(&self) -> Result<Arc<host::Connection>, RuntimeError> {
        let mut current = self.inner.connection.lock().unwrap();
        if let Some(connection) = current.as_ref()
            && connection.failure().is_none()
        {
            return Ok(Arc::clone(connection));
        }
        let program = match &self.inner.program {
            Some(program) => program.clone(),
            None => host_program()?,
        };
        let connection = Arc::new(host::Connection::spawn(program)?);
        *current = Some(Arc::clone(&connection));
        Ok(connection)
    }
}

fn host_program() -> Result<PathBuf, RuntimeError> {
    const HOST_BIN_ENV: &str = "ASH_CODE_MODE_HOST_BIN";
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
