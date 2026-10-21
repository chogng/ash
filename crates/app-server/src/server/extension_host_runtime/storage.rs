use super::EditorClientBinding;
use super::private_services::failure;
use ash_async_utils::CancellationToken;
use ash_external_ext::HostErrorCode;
use ash_external_ext::HostEventContext;
use ash_external_ext::HostFailure;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::services::CoreServiceRequest;
use external_ext_protocol::services::CoreServiceResponse;
use std::time::Duration;

impl EditorClientBinding {
    pub(super) fn storage(
        &self,
        context: HostEventContext,
        request: &CoreServiceRequest,
        token: &CancellationToken,
        timeout: Duration,
    ) -> Result<ExtensionClientResult, HostFailure> {
        let access = self.private_access(context, token, timeout)?;
        let store = access
            .runtime
            .storage
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(|| {
                failure(
                    HostErrorCode::OperationNotSupported,
                    "durable extension state is unavailable",
                )
            })?;
        let map_error = |error| match error {
            ash_state::ExtensionStateError::Invalid => {
                failure(HostErrorCode::InvalidRequest, "invalid extension state")
            }
            ash_state::ExtensionStateError::QuotaExceeded => failure(
                HostErrorCode::QuotaExceeded,
                "extension state exceeds quota",
            ),
            ash_state::ExtensionStateError::Retired => {
                access.check().err().unwrap_or_else(unavailable)
            }
            ash_state::ExtensionStateError::Storage(_) => unavailable(),
        };
        let response = match request {
            CoreServiceRequest::StorageGet { key } => {
                let value = store.get(&access.namespace, key).map_err(map_error)?;
                CoreServiceResponse::StorageValue {
                    found: value.is_some(),
                    value: value.unwrap_or(serde_json::Value::Null),
                }
            }
            CoreServiceRequest::StorageSet { key, value } => {
                store
                    .update(&access.namespace, key, Some(value), || {
                        access.check().is_ok()
                    })
                    .map_err(map_error)?;
                CoreServiceResponse::StorageUpdated
            }
            CoreServiceRequest::StorageDelete { key } => {
                store
                    .update(&access.namespace, key, None, || access.check().is_ok())
                    .map_err(map_error)?;
                CoreServiceResponse::StorageUpdated
            }
            CoreServiceRequest::CredentialGet { .. }
            | CoreServiceRequest::SecretLoad { .. }
            | CoreServiceRequest::SecretStore { .. }
            | CoreServiceRequest::SecretDelete { .. }
            | CoreServiceRequest::HttpExecute { .. } => return Err(unavailable()),
        };
        // Never replay a committed write whose reply was lost to cancellation or retirement.
        access.check()?;
        Ok(ExtensionClientResult::CoreService { response })
    }
}
fn unavailable() -> HostFailure {
    failure(HostErrorCode::Internal, "extension state unavailable")
}
