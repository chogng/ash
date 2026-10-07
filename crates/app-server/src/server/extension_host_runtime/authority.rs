use std::num::NonZeroU64;
use std::sync::Arc;

use ash_editor_extension_host::ActivationAuthority;
use ash_editor_extension_host::ActivationLease;
use ash_editor_extension_host::ExtensionActivationSpec;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::ExtensionLaunchCommand;
use ash_file_access::Authorization;

use super::source::EditorExtensionDeployment;

pub(super) struct PreparedExtension {
    pub(super) command: ExtensionLaunchCommand,
    pub(super) activation: ExtensionActivationSpec,
}

pub(super) fn prepare_extension(
    authorization: &Authorization,
    deployment: &EditorExtensionDeployment,
    activation_generation: NonZeroU64,
) -> Result<PreparedExtension, ExtensionHostError> {
    authorization
        .ensure_active()
        .map_err(|_| ExtensionHostError::AuthorityDenied)?;
    if !deployment.authority.authorizes() {
        return Err(ExtensionHostError::AuthorityDenied);
    }
    let authority: Arc<dyn ActivationAuthority> = Arc::new(DirActivationAuthority {
        source: Arc::clone(&deployment.authority),
        authorization: authorization.clone(),
    });
    Ok(PreparedExtension {
        command: deployment.command.clone(),
        activation: ExtensionActivationSpec::new(
            deployment.params.clone(),
            activation_generation,
            authority,
        ),
    })
}

struct DirActivationAuthority {
    source: Arc<dyn ActivationAuthority>,
    authorization: Authorization,
}

impl ActivationAuthority for DirActivationAuthority {
    fn authorizes(&self) -> bool {
        self.authorization.ensure_active().is_ok() && self.source.authorizes()
    }

    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorization.ensure_active().ok()?;
        let source = self.source.acquire()?;
        if self.authorization.ensure_active().is_err() {
            drop(source);
            return None;
        }
        Some(Box::new(DirActivationLease {
            _source: source,
            _authorization: self.authorization.clone(),
        }))
    }
}

struct DirActivationLease {
    _source: Box<dyn ActivationLease>,
    _authorization: Authorization,
}

impl ActivationLease for DirActivationLease {}
