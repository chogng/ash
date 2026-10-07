use crate::PreparedCommand;
use crate::SandboxBackend;
use crate::SandboxCommand;
use crate::SandboxError;
use crate::SandboxKind;
use crate::SandboxPolicy;
use crate::SandboxScope;
use ash_file_access::Dir;
use std::sync::Arc;

/// Selects an implementation before execution. Each registered implementation
/// must enforce the requested isolation model; registration never changes it.
pub struct SandboxBackends {
    backends: Vec<(&'static str, Arc<dyn SandboxBackend>)>,
}

impl SandboxBackends {
    /// Registers implementations in preference order. Only UnsupportedPolicy
    /// permits considering the next candidate; operational failures stop selection.
    pub fn new(backends: Vec<(&'static str, Arc<dyn SandboxBackend>)>) -> Self {
        Self { backends }
    }
}

impl SandboxBackend for SandboxBackends {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn requires_shared_network_proxy(&self) -> bool {
        self.backends
            .iter()
            .any(|(_, backend)| backend.requires_shared_network_proxy())
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        dir: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare_scoped(command, policy, &SandboxScope::single(dir.clone()))
    }

    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        if !policy.requires_platform_sandbox() && scope.is_single_unhidden() {
            return Ok(PreparedCommand::unrestricted(command));
        }
        let mut unsupported = Vec::new();
        for (name, backend) in &self.backends {
            match backend.prepare_scoped(command, policy, scope) {
                Ok(prepared) => {
                    if prepared.kind() != SandboxKind::Restricted {
                        return Err(SandboxError::InvalidScope(format!(
                            "{name} did not prepare restricted execution"
                        )));
                    }
                    return Ok(prepared.with_default_backend(Arc::clone(backend)));
                }
                Err(SandboxError::UnsupportedPolicy(reason)) => {
                    unsupported.push(format!("{name}: {reason}"))
                }
                Err(error) => return Err(error),
            }
        }
        Err(SandboxError::BackendUnavailable {
            backend: SandboxKind::Restricted,
            message: if unsupported.is_empty() {
                "no sandbox implementation is registered".into()
            } else {
                unsupported.join("; ")
            },
        })
    }
}

#[cfg(test)]
#[path = "backends_tests.rs"]
mod tests;
