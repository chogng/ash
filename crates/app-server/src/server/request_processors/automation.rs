use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::automation::AutomationDeleteParams;
use ash_app_server_protocol::protocol::automation::AutomationListResult;
use ash_app_server_protocol::protocol::automation::AutomationPreviewParams;
use ash_app_server_protocol::protocol::automation::AutomationPreviewResult;
use ash_app_server_protocol::protocol::automation::AutomationRunParams;
use ash_app_server_protocol::protocol::automation::AutomationRunReadParams;
use ash_app_server_protocol::protocol::automation::AutomationRunsParams;
use ash_app_server_protocol::protocol::automation::AutomationRunsResult;
use ash_app_server_protocol::protocol::automation::AutomationStopParams;
use ash_app_server_protocol::protocol::automation::AutomationWriteParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_automation::AutomationError;
use ash_automation::AutomationScope;
use ash_automation::AutomationStore;
use ash_automation::AutomationWrite;
use serde_json::Value;
use std::sync::Arc;

/// Owns automation RPCs and the profile store shared with queue execution.
pub(super) struct AutomationRequestProcessor {
    store: Option<Arc<AutomationStore>>,
    updates: Arc<super::update_broker::UpdateBroker>,
}

impl AutomationRequestProcessor {
    pub(super) fn new(updates: Arc<super::update_broker::UpdateBroker>) -> Self {
        Self {
            store: None,
            updates,
        }
    }
    pub(super) fn with_store(mut self, store: Arc<AutomationStore>) -> Self {
        self.store = Some(store);
        self
    }
    pub(super) fn store(&self) -> Option<&AutomationStore> {
        self.store.as_deref()
    }
    pub(super) fn is_available(&self) -> bool {
        self.store.is_some()
    }

    pub(super) fn automation_list(&self, scope: AutomationScope) -> Result<Value, RpcError> {
        let mut automations = self.automation_store()?.list().map_err(error)?;
        automations.retain(|plan| scope.allows(&plan.definition.session));
        result(&AutomationListResult { automations })
    }

    pub(super) fn automation_preview(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AutomationPreviewParams = decode(params)?;
        self.automation_store()?;
        result(&AutomationPreviewResult {
            occurrences: ash_automation::preview_occurrences(
                &params.schedule,
                ash_automation::now().map_err(error)?,
            )
            .map_err(error)?,
        })
    }

    pub(super) fn automation_write(
        &self,
        params: AutomationWriteParams,
        scope: AutomationScope,
    ) -> Result<Value, RpcError> {
        if !scope.allows(&params.definition.session) {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let store = self.automation_store()?;
        check_plan_access(store, &params.id, scope)?;
        let automation = store
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

    pub(super) fn automation_delete(
        &self,
        params: &Value,
        scope: AutomationScope,
    ) -> Result<Value, RpcError> {
        let params: AutomationDeleteParams = decode(params)?;
        let store = self.automation_store()?;
        if !check_plan_access(store, &params.id, scope)? {
            // A missing ID could be created after this lookup. Only delete a plan we authorized.
            return Ok(Value::Null);
        }
        store
            .delete(&params.id, params.expected_revision)
            .map_err(error)?;
        self.updates.publish_automation_changed();
        Ok(Value::Null)
    }

    pub(super) fn automation_run(
        &self,
        params: &Value,
        scope: AutomationScope,
    ) -> Result<Value, RpcError> {
        let params: AutomationRunParams = decode(params)?;
        let run = self
            .automation_store()?
            .run_now_scoped(
                &params.id,
                &params.command_id,
                ash_automation::now().map_err(error)?,
                scope,
            )
            .map_err(error)?;
        self.updates.publish_automation_changed();
        result(&run)
    }

    pub(super) fn automation_run_read(
        &self,
        params: &Value,
        scope: AutomationScope,
    ) -> Result<Value, RpcError> {
        let params: AutomationRunReadParams = decode(params)?;
        result(&read_scoped_run(
            self.automation_store()?,
            &params.run_id,
            scope,
        )?)
    }

    pub(super) fn automation_runs(
        &self,
        params: &Value,
        scope: AutomationScope,
    ) -> Result<Value, RpcError> {
        let params: AutomationRunsParams = decode(params)?;
        let store = self.automation_store()?;
        check_plan_access(store, &params.id, scope)?;
        let mut runs = store.runs(&params.id, params.limit).map_err(error)?;
        // History outlives its plan. Use each run's captured definition for visibility.
        runs.retain(|run| scope.allows(&run.definition.session));
        result(&AutomationRunsResult { runs })
    }

    pub(super) fn automation_stop(
        &self,
        params: &Value,
        scope: AutomationScope,
    ) -> Result<Value, RpcError> {
        let params: AutomationStopParams = decode(params)?;
        let store = self.automation_store()?;
        read_scoped_run(store, &params.run_id, scope)?;
        let run = store.stop_run(&params.run_id).map_err(error)?;
        self.updates.publish_automation_changed();
        result(&run)
    }

    fn automation_store(&self) -> Result<&AutomationStore, RpcError> {
        self.store()
            .ok_or_else(|| RpcError::new(-32100, AppServerErrorName::AutomationUnavailable))
    }
}

fn check_plan_access(
    store: &AutomationStore,
    id: &str,
    scope: AutomationScope,
) -> Result<bool, RpcError> {
    let plan = store.get(id).map_err(error)?;
    match plan {
        Some(plan) if scope.allows(&plan.definition.session) => Ok(true),
        Some(_) => Err(error(AutomationError::NotFound)),
        None => Ok(false),
    }
}

fn read_scoped_run(
    store: &AutomationStore,
    id: &str,
    scope: AutomationScope,
) -> Result<ash_protocol::AutomationRun, RpcError> {
    let run = store.get_run(id).map_err(error)?;
    if !scope.allows(&run.definition.session) {
        return Err(error(AutomationError::NotFound));
    }
    Ok(run)
}

pub(super) fn error(error: AutomationError) -> RpcError {
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
