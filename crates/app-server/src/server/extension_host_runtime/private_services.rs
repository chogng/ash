use super::EditorClientBinding;
use super::RuntimeInner;
use super::source::EditorExtensionScope;
use ash_async_utils::CancellationToken;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::HostErrorCode;
use ash_external_ext::HostEventContext;
use ash_external_ext::HostFailure;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

/// Admission shared by ordinary state and private secrets. It retains no business values.
pub(super) struct Access<'a> {
    pub runtime: Arc<RuntimeInner>,
    pub namespace: String,
    binding: &'a EditorClientBinding,
    token: &'a CancellationToken,
    authority: Arc<dyn ActivationAuthority>,
    directory: Option<ash_file_access::Authorization>,
    deadline: Instant,
}

impl EditorClientBinding {
    pub(super) fn private_access<'a>(
        &'a self,
        context: HostEventContext,
        token: &'a CancellationToken,
        timeout: Duration,
    ) -> Result<Access<'a>, HostFailure> {
        let deadline = Instant::now() + timeout;
        let runtime = self.runtime.upgrade().ok_or_else(denied)?;
        let (namespace, authority, directory) = {
            let fleet = runtime.state.lock().map_err(|_| denied())?;
            let entry = fleet
                .entry(self.owner, &self.extension_id)
                .ok_or_else(denied)?;
            if !self
                .activation
                .ptr_eq(&Arc::downgrade(&entry.activation_gate))
            {
                return Err(denied());
            }
            let snapshot = entry.supervisor.as_ref().ok_or_else(denied)?.snapshot();
            if !matches!(
                snapshot.status,
                ash_external_ext::ExtensionHostStatus::Ready
                    | ash_external_ext::ExtensionHostStatus::Starting
            ) || snapshot.incarnation != context.incarnation
                || snapshot.activation_generation != context.activation_generation
            {
                return Err(denied());
            }
            // Window instances borrow authenticated template facts. A child cannot choose
            // a profile, namespace, package, grant or replacement activation over the wire.
            let deployment = fleet
                .entries
                .get(&self.extension_id)
                .and_then(|entry| entry.deployment.as_ref())
                .ok_or_else(denied)?;
            let origin = match deployment.scope {
                EditorExtensionScope::Product | EditorExtensionScope::ProductPackage => "product",
                EditorExtensionScope::Workspace | EditorExtensionScope::Profile => "installed",
            };
            let namespace =
                serde_json::to_string(&(origin, &self.extension_id)).map_err(|_| denied())?;
            let directory = (deployment.scope == EditorExtensionScope::Workspace)
                .then(|| fleet.authorization.clone())
                .flatten();
            if deployment.scope == EditorExtensionScope::Workspace && directory.is_none() {
                return Err(denied());
            }
            (namespace, deployment.authority.clone(), directory)
        };
        let access = Access {
            runtime,
            namespace,
            binding: self,
            token,
            authority,
            directory,
            deadline,
        };
        access.check()?;
        Ok(access)
    }
}

impl Access<'_> {
    pub fn check(&self) -> Result<(), HostFailure> {
        if self.token.is_cancelled() {
            return Err(failure(
                HostErrorCode::Cancelled,
                "private service call cancelled",
            ));
        }
        if Instant::now() >= self.deadline {
            return Err(failure(
                HostErrorCode::DeadlineExceeded,
                "private service deadline exceeded",
            ));
        }
        if self.binding.activation.strong_count() == 0
            || !self.authority.authorizes()
            || self
                .directory
                .as_ref()
                .is_some_and(|authorization| authorization.ensure_active().is_err())
        {
            return Err(denied());
        }
        Ok(())
    }
}
fn denied() -> HostFailure {
    failure(
        HostErrorCode::PermissionDenied,
        "private service access is no longer authorized",
    )
}
pub(super) fn failure(code: HostErrorCode, message: &str) -> HostFailure {
    HostFailure {
        code,
        message: message.into(),
    }
}
