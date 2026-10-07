use std::sync::Arc;

use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::registry::ServerNotificationMethod;
use ash_app_server_protocol::protocol::testing::TestingDebugLaunch;
use ash_app_server_protocol::protocol::testing::TestingDiscoverParams;
use ash_app_server_protocol::protocol::testing::TestingItem;
use ash_app_server_protocol::protocol::testing::TestingOperationKind;
use ash_app_server_protocol::protocol::testing::TestingOperationParams;
use ash_app_server_protocol::protocol::testing::TestingOperationStatus;
use ash_app_server_protocol::protocol::testing::TestingPrepareDebugParams;
use ash_app_server_protocol::protocol::testing::TestingResult;
use ash_app_server_protocol::protocol::testing::TestingRunParams;
use ash_app_server_protocol::protocol::testing::TestingSnapshot;
use ash_app_server_protocol::protocol::testing::TestingSource;
use ash_app_server_protocol::protocol::testing::TestingState;
use ash_app_server_protocol::protocol::testing::TestingTargetKind;
use ash_app_server_protocol::protocol::testing::TestingUpdate;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use serde_json::Value;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use super::update_broker::notification;

impl AppServer {
    pub(super) fn testing_prepare_debug(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TestingPrepareDebugParams = decode(params)?;
        self.testing
            .prepare_debug(
                connection.connection_id,
                params.operation_id,
                &params.catalog_id,
                &params.test_id,
                self.testing_authorization(params.dir_id.as_deref(), Permission::ExecuteCommands)?,
                update_sink(connection),
            )
            .map_err(testing_error)?;
        result(&())
    }
    pub(super) fn testing_discover(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TestingDiscoverParams = decode(params)?;
        self.testing
            .discover(
                connection.connection_id,
                params.operation_id,
                self.testing_authorization(params.dir_id.as_deref(), Permission::ReadFiles)?,
                self.testing_authorization(params.dir_id.as_deref(), Permission::ExecuteCommands)?,
                update_sink(connection),
            )
            .map_err(testing_error)?;
        result(&())
    }

    pub(super) fn testing_run(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TestingRunParams = decode(params)?;
        self.testing
            .run(
                connection.connection_id,
                params.operation_id,
                &params.catalog_id,
                &params.test_ids,
                self.testing_authorization(params.dir_id.as_deref(), Permission::ExecuteCommands)?,
                update_sink(connection),
            )
            .map_err(testing_error)?;
        result(&())
    }

    pub(super) fn testing_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TestingOperationParams = decode(params)?;
        result(&snapshot(
            self.testing
                .read(connection.connection_id, &params.operation_id)
                .map_err(testing_error)?,
        ))
    }

    pub(super) fn testing_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TestingOperationParams = decode(params)?;
        result(&snapshot(
            self.testing
                .cancel(connection.connection_id, &params.operation_id)
                .map_err(testing_error)?,
        ))
    }

    pub(super) fn testing_release(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TestingOperationParams = decode(params)?;
        self.testing
            .release(connection.connection_id, &params.operation_id)
            .map_err(testing_error)?;
        result(&())
    }

    fn testing_authorization(
        &self,
        dir_id: Option<&str>,
        permission: Permission,
    ) -> Result<Authorization, RpcError> {
        let runtime = self.env_runtime.read().expect("environment runtime mutex");
        let grant = match dir_id {
            Some(id) => runtime.dirs.get(id),
            None => runtime.selected_grant.as_ref(),
        }
        .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        grant
            .authorize(permission)
            .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))
    }
}

fn update_sink(connection: &ConnectionState) -> Arc<dyn Fn(testing::Update) + Send + Sync> {
    let notifications = connection.outbound_notifications.clone();
    Arc::new(move |update| {
        notifications.push(notification(
            ServerNotificationMethod::TestingUpdated,
            &TestingUpdate {
                operation_id: update.operation_id,
                sequence: update.sequence,
                status: status(update.status),
                tests: update
                    .tests
                    .map(|tests| tests.into_iter().map(item).collect()),
                result: update.result.map(test_result),
                error: update.error,
                launch: update.launch.map(debug_launch),
            },
        ));
    })
}

fn snapshot(value: testing::Snapshot) -> TestingSnapshot {
    TestingSnapshot {
        operation_id: value.operation_id,
        kind: match value.kind {
            testing::OperationKind::Discovery => TestingOperationKind::Discovery,
            testing::OperationKind::Run => TestingOperationKind::Run,
            testing::OperationKind::Debug => TestingOperationKind::Debug,
        },
        status: status(value.status),
        tests: value.tests.into_iter().map(item).collect(),
        results: value.results.into_iter().map(test_result).collect(),
        error: value.error,
        sequence: value.sequence,
        launch: value.launch.map(debug_launch),
    }
}

fn status(value: testing::OperationStatus) -> TestingOperationStatus {
    match value {
        testing::OperationStatus::Running => TestingOperationStatus::Running,
        testing::OperationStatus::Completed => TestingOperationStatus::Completed,
        testing::OperationStatus::Cancelled => TestingOperationStatus::Cancelled,
        testing::OperationStatus::Failed => TestingOperationStatus::Failed,
    }
}

fn item(value: testing::TestItem) -> TestingItem {
    TestingItem {
        id: value.id,
        package: value.package,
        target: value.target,
        target_kind: match value.target_kind {
            testing::TargetKind::Library => TestingTargetKind::Library,
            testing::TargetKind::Binary => TestingTargetKind::Binary,
            testing::TargetKind::Integration => TestingTargetKind::Integration,
            testing::TargetKind::Documentation => TestingTargetKind::Documentation,
        },
        name: value.name,
        source: value.source.map(|source| TestingSource {
            path: source.path,
            line: source.line,
        }),
        debuggable: value.debuggable,
    }
}

fn debug_launch(value: testing::DebugLaunch) -> TestingDebugLaunch {
    TestingDebugLaunch {
        test_id: value.test_id,
        program: value.program,
        arguments: value.arguments,
        directory: value.directory,
        adapter_program: value.adapter_program,
    }
}

fn test_result(value: testing::TestResult) -> TestingResult {
    TestingResult {
        test_id: value.test_id,
        state: match value.state {
            testing::TestState::Running => TestingState::Running,
            testing::TestState::Passed => TestingState::Passed,
            testing::TestState::Failed => TestingState::Failed,
            testing::TestState::Skipped => TestingState::Skipped,
            testing::TestState::Errored => TestingState::Errored,
            testing::TestState::Cancelled => TestingState::Cancelled,
        },
        duration_ms: value.duration_ms,
        output: value.output,
        output_truncated: value.output_truncated,
        failure_path: value.failure_path,
        failure_line: value.failure_line,
    }
}

fn testing_error(error: testing::TestingError) -> RpcError {
    match error {
        testing::TestingError::InvalidInput => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        testing::TestingError::NotFound => {
            RpcError::new(-32101, AppServerErrorName::TestingNotFound)
        }
        testing::TestingError::Busy => RpcError::new(-32103, AppServerErrorName::TestingBusy),
        testing::TestingError::PermissionRequired => {
            RpcError::new(-32043, AppServerErrorName::PermissionRequired)
        }
        testing::TestingError::Cancelled => {
            RpcError::new(-32800, AppServerErrorName::RequestCancelled)
        }
        testing::TestingError::Failed(_) => {
            RpcError::new(-32104, AppServerErrorName::TestingOperationFailed)
        }
    }
}
