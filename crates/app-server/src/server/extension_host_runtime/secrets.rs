use super::EditorClientBinding;
use super::private_services::failure;
use ash_async_utils::CancellationToken;
use ash_external_ext::HostErrorCode;
use ash_external_ext::HostEventContext;
use ash_external_ext::HostFailure;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretKey;
use ash_secrets::SecretValue;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::services::CoreServiceRequest;
use external_ext_protocol::services::CoreServiceResponse;
use sha2::Digest;
use sha2::Sha256;
use std::time::Duration;

impl EditorClientBinding {
    pub(super) fn secrets(
        &self,
        context: HostEventContext,
        request: &CoreServiceRequest,
        token: &CancellationToken,
        timeout: Duration,
    ) -> Result<ExtensionClientResult, HostFailure> {
        let access = self.private_access(context, token, timeout)?;
        let store = access
            .runtime
            .secrets
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(|| {
                failure(
                    HostErrorCode::OperationNotSupported,
                    "extension secrets unavailable",
                )
            })?;
        let key = match request {
            CoreServiceRequest::SecretLoad { key }
            | CoreServiceRequest::SecretStore { key, .. }
            | CoreServiceRequest::SecretDelete { key } => private_key(&access.namespace, key)?,
            CoreServiceRequest::StorageGet { .. }
            | CoreServiceRequest::StorageSet { .. }
            | CoreServiceRequest::StorageDelete { .. }
            | CoreServiceRequest::CredentialGet { .. }
            | CoreServiceRequest::HttpExecute { .. } => return Err(unavailable()),
        };
        access.check()?;
        let response = match request {
            CoreServiceRequest::SecretLoad { .. } => {
                let value = store.load(&key).map_err(|_| unavailable())?;
                access.check()?;
                if value
                    .as_ref()
                    .is_some_and(|value| value.expose().len() > 65536)
                {
                    return Err(unavailable());
                }
                CoreServiceResponse::SecretLoaded {
                    value: value.map(|value| value.expose().to_vec()),
                }
            }
            CoreServiceRequest::SecretStore { value, .. } => {
                if value.len() > 65536 {
                    return Err(failure(
                        HostErrorCode::QuotaExceeded,
                        "extension secret exceeds quota",
                    ));
                }
                store
                    .store(&key, &SecretValue::new(value.clone()))
                    .map_err(|_| unavailable())?;
                CoreServiceResponse::SecretStored
            }
            CoreServiceRequest::SecretDelete { .. } => CoreServiceResponse::SecretDeleted {
                deleted: store.delete(&key).map_err(|_| unavailable())?
                    == DeleteSecretOutcome::Deleted,
            },
            CoreServiceRequest::StorageGet { .. }
            | CoreServiceRequest::StorageSet { .. }
            | CoreServiceRequest::StorageDelete { .. }
            | CoreServiceRequest::CredentialGet { .. }
            | CoreServiceRequest::HttpExecute { .. } => return Err(unavailable()),
        };
        access.check()?;
        Ok(ExtensionClientResult::CoreService { response })
    }
}
fn private_key(namespace: &str, key: &str) -> Result<SecretKey, HostFailure> {
    if key.is_empty() || key.len() > 256 || key.chars().any(char::is_control) {
        return Err(failure(
            HostErrorCode::InvalidRequest,
            "invalid extension secret key",
        ));
    }
    // Stable, disjoint from product credentials; author keys cannot select another namespace.
    SecretKey::new(format!(
        "ash.extensions.v1.{:x}.{:x}",
        Sha256::digest(namespace),
        Sha256::digest(key)
    ))
    .map_err(|_| unavailable())
}
fn unavailable() -> HostFailure {
    failure(
        HostErrorCode::Internal,
        "extension secret storage unavailable",
    )
}
