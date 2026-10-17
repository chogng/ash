use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_async_utils::CancellationToken;
use ash_async_utils::FutureCancellationExt;
use serde_json::Value;
use std::sync::Arc;
use task_delivery::TaskPackage;

/// Adapts task delivery without taking ownership of its provisioning runtime.
pub(super) struct TaskDeliveryRequestProcessor<'a> {
    task_delivery: &'a Option<Arc<task_delivery::Runtime>>,
    updates: &'a super::UpdateBroker,
}
impl<'a> TaskDeliveryRequestProcessor<'a> {
    pub(super) fn new(
        task_delivery: &'a Option<Arc<task_delivery::Runtime>>,
        updates: &'a super::UpdateBroker,
    ) -> Self {
        Self {
            task_delivery,
            updates,
        }
    }
    pub(super) fn task_delivery_request(
        &self,
        method: ClientMethod,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, crate::server::RpcError> {
        use ash_app_server_protocol::protocol::error::AppServerErrorName;
        let service = self.task_delivery.as_ref().ok_or_else(|| {
            crate::server::RpcError::new(-32200, AppServerErrorName::TaskDeliveryUnavailable)
        })?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| {
                crate::server::RpcError::new(-32000, AppServerErrorName::ServerOverloaded)
            })?;
        let output = match method {
            ClientMethod::TaskSnapshotInfo => {
                let _: ash_app_server_protocol::protocol::common::EmptyParams =
                    serde_json::from_value(params.clone()).map_err(|_| {
                        crate::server::RpcError::new(-32602, AppServerErrorName::InvalidParams)
                    })?;
                runtime
                    .block_on(
                        service
                            .snapshot_info()
                            .with_cancellation(cancellation.clone()),
                    )
                    .map_err(|_| {
                        crate::server::RpcError::new(-32800, AppServerErrorName::RequestCancelled)
                    })?
                    .and_then(|value| serde_json::to_value(value).map_err(Into::into))
            }
            ClientMethod::TaskReceive => {
                let package: TaskPackage =
                    serde_json::from_value(params.clone()).map_err(|_| {
                        crate::server::RpcError::new(-32602, AppServerErrorName::InvalidParams)
                    })?;
                // Once provisioning begins, finish durable acceptance even if the sending socket
                // closes. A lost response is resolved by replaying the same immutable package.
                runtime
                    .block_on(service.receive(&package))
                    .and_then(|value| {
                        self.updates.publish_session_changed(&value.session_id);
                        self.updates.publish_queue_changed();
                        serde_json::to_value(value).map_err(Into::into)
                    })
            }
            ClientMethod::TaskRead => {
                let params = serde_json::from_value(params.clone()).map_err(|_| {
                    crate::server::RpcError::new(-32602, AppServerErrorName::InvalidParams)
                })?;
                service
                    .read(&params)
                    .and_then(|value| serde_json::to_value(value).map_err(Into::into))
            }
            _ => unreachable!("task delivery dispatch"),
        };
        output.map_err(|error| {
            let (code, name) = match error {
                task_delivery::Error::Invalid(_) => (-32602, AppServerErrorName::InvalidParams),
                task_delivery::Error::Conflict => {
                    (-32201, AppServerErrorName::TaskDeliveryConflict)
                }
                task_delivery::Error::NotFound => {
                    (-32202, AppServerErrorName::TaskDeliveryNotFound)
                }
                task_delivery::Error::Runtime(_)
                | task_delivery::Error::Storage(_)
                | task_delivery::Error::Encoding(_) => {
                    (-32203, AppServerErrorName::TaskDeliveryOperationFailed)
                }
            };
            crate::server::RpcError::with_details(code, name, error.to_string())
        })
    }
}
