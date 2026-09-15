use crate::{
    PreparedCommand, SandboxCommand, SandboxError, SandboxKind, SandboxPolicy,
    SandboxProcessDenial, SandboxProcessExitStatus, SandboxScope,
};
use ash_file_access::Dir;
use std::sync::Arc;

/// Converts a validated command and policy into a platform-enforced launch command.
///
/// Implementations must fail closed when the requested restrictions cannot be enforced. They
/// receive a command whose working directory has already been canonicalized inside `dir`.
pub trait SandboxBackend: Send + Sync + 'static {
    fn kind(&self) -> SandboxKind;

    /// Whether HTTP and SOCKS must share the one endpoint allowed by this backend.
    fn requires_shared_network_proxy(&self) -> bool {
        false
    }

    /// Classifies a non-successful prepared process result as sandbox enforcement or an ordinary
    /// command failure.
    ///
    /// Implementations must return `Some` only for backend-specific evidence they recognize.
    /// Generic non-zero exits are not sandbox denials.
    fn classify_denial(
        &self,
        exit_status: SandboxProcessExitStatus,
        stdout: &str,
        stderr: &str,
    ) -> Option<SandboxProcessDenial> {
        let _ = (exit_status, stdout, stderr);
        None
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        dir: &Dir,
    ) -> Result<PreparedCommand, SandboxError>;

    /// Prepares a command whose exact directory visibility may span several roots.
    ///
    /// Backends that do not implement multi-root isolation accept only the single-directory
    /// shape. Any richer scope fails closed instead of silently exposing sibling directories.
    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        if !scope.is_single_unhidden() {
            return Err(SandboxError::UnsupportedPolicy(
                "the backend cannot enforce this multi-directory visibility scope".into(),
            ));
        }
        self.prepare(command, policy, scope.command_dir())
    }
}

/// Validates command paths and delegates platform-specific sandbox construction.
pub struct SandboxManager<B> {
    dir: Dir,
    backend: Arc<B>,
}

impl<B: SandboxBackend> SandboxManager<B> {
    pub fn new(dir: Dir, backend: B) -> Self {
        Self {
            dir,
            backend: Arc::new(backend),
        }
    }

    pub fn backend_kind(&self) -> SandboxKind {
        self.backend.kind()
    }

    pub fn dir(&self) -> &Dir {
        &self.dir
    }

    pub fn requires_shared_network_proxy(&self) -> bool {
        self.backend.requires_shared_network_proxy()
    }

    pub fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare_in_dir(command, policy, &self.dir)
    }

    pub fn prepare_in_dir(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        dir: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare_scoped(command, policy, &SandboxScope::single(dir.clone()))
    }

    pub fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        let working_directory = scope
            .command_dir()
            .resolve_existing(command.working_directory())?;
        let command = command.with_working_directory(working_directory);
        self.backend
            .prepare_scoped(&command, policy, scope)
            .map(|prepared| prepared.with_default_backend(self.backend.clone()))
            .map_err(|error| match error {
                SandboxError::UnsupportedPolicy(message) => SandboxError::BackendUnavailable {
                    backend: self.backend.kind(),
                    message,
                },
                error => error,
            })
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
