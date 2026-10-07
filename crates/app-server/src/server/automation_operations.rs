use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::automation::AutomationDeleteParams;
use ash_app_server_protocol::protocol::automation::AutomationListResult;
use ash_app_server_protocol::protocol::automation::AutomationRunParams;
use ash_app_server_protocol::protocol::automation::AutomationRunsParams;
use ash_app_server_protocol::protocol::automation::AutomationRunsResult;
use ash_app_server_protocol::protocol::automation::AutomationStopParams;
use ash_app_server_protocol::protocol::automation::AutomationWriteParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_automation::AutomationError;
use ash_automation::AutomationStore;
use ash_automation::AutomationWrite;
use serde_json::Value;
use std::sync::Arc;

impl AppServer {
    pub(crate) fn with_automation_store(mut self, store: Arc<AutomationStore>) -> Self {
        self.automation = Some(store);
        self
    }

    pub(super) fn automation_list(&self) -> Result<Value, RpcError> {
        result(&AutomationListResult {
            automations: self.automation_store()?.list().map_err(error)?,
        })
    }

    pub(super) fn automation_write(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AutomationWriteParams = decode(params)?;
        let automation = self
            .automation_store()?
            .write(
                &AutomationWrite {
                    command_id: params.command_id,
                    id: params.id,
                    expected_revision: params.expected_revision,
                    definition: params.definition,
                    status: params.status,
                },
                ash_automation::now().map_err(error)?,
            )
            .map_err(error)?;
        self.updates.publish_automation_changed();
        result(&automation)
    }

    pub(super) fn automation_delete(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AutomationDeleteParams = decode(params)?;
        self.automation_store()?
            .delete(&params.id, params.expected_revision)
            .map_err(error)?;
        self.updates.publish_automation_changed();
        Ok(Value::Null)
    }

    pub(super) fn automation_run(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AutomationRunParams = decode(params)?;
        let run = self
            .automation_store()?
            .run_now(
                &params.id,
                &params.command_id,
                ash_automation::now().map_err(error)?,
            )
            .map_err(error)?;
        self.updates.publish_automation_changed();
        result(&run)
    }

    pub(super) fn automation_runs(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AutomationRunsParams = decode(params)?;
        result(&AutomationRunsResult {
            runs: self
                .automation_store()?
                .runs(&params.id, params.limit)
                .map_err(error)?,
        })
    }

    pub(super) fn automation_stop(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AutomationStopParams = decode(params)?;
        let run = self
            .automation_store()?
            .stop_run(&params.run_id)
            .map_err(error)?;
        self.updates.publish_automation_changed();
        result(&run)
    }

    fn automation_store(&self) -> Result<&AutomationStore, RpcError> {
        self.automation
            .as_deref()
            .ok_or_else(|| RpcError::new(-32100, AppServerErrorName::AutomationUnavailable))
    }
}

fn error(error: AutomationError) -> RpcError {
    match error {
        AutomationError::Invalid(_) => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        AutomationError::NotFound => RpcError::new(-32101, AppServerErrorName::AutomationNotFound),
        AutomationError::Conflict => RpcError::new(-32102, AppServerErrorName::AutomationConflict),
        AutomationError::Busy => RpcError::new(-32103, AppServerErrorName::AutomationBusy),
        AutomationError::CommandConflict => {
            RpcError::new(-32012, AppServerErrorName::CommandConflict)
        }
        _ => RpcError::new(-32104, AppServerErrorName::AutomationOperationFailed),
    }
}
