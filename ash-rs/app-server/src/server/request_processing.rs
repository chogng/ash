use super::AppServer;
use super::AppServerError;
use super::AppServerErrorName;
use super::ConnectionState;
use super::JsonRpcFailure;
use super::JsonRpcId;
use super::JsonRpcRequest;
use super::JsonRpcSuccess;
use super::PreparedRequest;
use super::RpcError;
use super::Value;
use super::client_method;
use super::client_method_definition;
use super::error_response;
use super::git_operations;
use super::request_dispatch;
use super::request_dispatch::RequestLane;
use super::request_serialization;
use super::serialize_response;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_app_server_protocol::rpc::JsonRpcVersion;
use ash_async_utils::CancellationToken;
use std::time::Instant;
use std::time::SystemTime;

impl RequestLane {
    fn for_method(method: Option<ClientMethod>) -> Self {
        match method {
            Some(method) if super::github_processor::GitHubRequestProcessor::handles(method) => Self::Network,
            Some(
                ClientMethod::GitHubCancel
                | ClientMethod::ApprovalEnvironmentCancel
                | ClientMethod::AssetImportCancel
                | ClientMethod::DictationModelCancel
                | ClientMethod::GitCheckIgnoreCancel
                | ClientMethod::TestingCancel
                | ClientMethod::LanguageCancel
                | ClientMethod::IssueReporterSearchCancel
                | ClientMethod::ContentSearchCancel
                | ClientMethod::ExtensionHostInvokeCancel
                | ClientMethod::AccountLoginCancel
                | ClientMethod::AutomationStop
                | ClientMethod::QueueCancel
                | ClientMethod::TerminalClose
                | ClientMethod::DebugAdapterClose
                | ClientMethod::AttachmentUploadCancel
                | ClientMethod::DictationStop
                | ClientMethod::ConnectorOAuthCancel
                | ClientMethod::ConnectorDeviceOAuthCancel,
            ) => Self::Control,
            Some(
                ClientMethod::GitHubAccountList
                | ClientMethod::GitHubAccountConnect
                | ClientMethod::IssueList
                | ClientMethod::IssueRead
                | ClientMethod::GitCommand
                | ClientMethod::GitClone
                | ClientMethod::GitFetch
                | ClientMethod::GitPull
                | ClientMethod::GitPush
                | ClientMethod::GitWorktreeCreate
                | ClientMethod::GitWorktreeDelete
                | ClientMethod::NetworkDiagnosticsRun
                | ClientMethod::IssueReporterSearch
                | ClientMethod::IssueReporterSubmit
                | ClientMethod::ProviderProbe
                | ClientMethod::ProviderModelsList
                // Catalog I/O can outlive navigation and must not occupy the workers used by Settings reads.
                | ClientMethod::MarketplaceSearch
                | ClientMethod::MarketplaceGet
                | ClientMethod::FsCopy
                | ClientMethod::FsPasteSystemFiles
                | ClientMethod::GrepIndexRebuild,
            ) => Self::Background,
            _ => Self::Interactive,
        }
    }

    pub(crate) fn for_message(method: &str, params: &serde_json::Value) -> Self {
        let method = super::client_method(method);
        // Inspect only the routing tag; the domain processor remains the typed params owner.
        if method == Some(ClientMethod::SessionRequest)
            && matches!(
                params
                    .pointer("/request/type")
                    .and_then(serde_json::Value::as_str),
                Some("stop" | "interruptTurn" | "resolveInteraction")
            )
        {
            return Self::Control;
        }
        Self::for_method(method)
    }
}

impl AppServer {
    /// Only owned domain handles and request values enter the shared async executor.
    /// Connection state, resource admission and response delivery remain with its dispatcher.
    pub(super) fn prepare_network_request(
        &self,
        prepared: &mut PreparedRequest,
        admission: &request_dispatch::RequestAdmission,
    ) -> request_dispatch::NetworkFuture {
        let processor = self.github_processor().cloned();
        let method = client_method(&prepared.request.method).expect("network method is registered");
        let params = std::mem::take(&mut prepared.request.params);
        let token = prepared.cancellation.clone();
        let run = admission.permit.is_ok() && !token.is_cancelled();
        Box::pin(async move {
            if !run {
                return None;
            }
            Some(match processor {
                Ok(processor) => processor.request(method, &params, &token).await,
                Err(error) => Err(error),
            })
        })
    }

    pub fn handle_json(&self, connection: &mut ConnectionState, raw: &str) -> String {
        self.handle_json_with_delivery(connection, raw, |response| response)
    }

    pub(crate) fn handle_json_with_delivery<R>(
        &self,
        connection: &mut ConnectionState,
        raw: &str,
        deliver: impl FnOnce(String) -> R,
    ) -> R {
        let prepared = match self.prepare_request(connection, raw) {
            Ok(prepared) => prepared,
            Err(response) => return deliver(response),
        };
        let _inline_admission = if connection.is_initialized() {
            match request_dispatch::inline_admission(
                &prepared.request.method,
                &prepared.request.params,
                raw.len(),
            ) {
                Ok(admission) => Some(admission),
                Err(()) => {
                    self.request_cancellations.finish(
                        connection.connection_id,
                        prepared.request.id.as_u64().expect("validated request ID"),
                    );
                    return deliver(serialize_response(error_response(
                        prepared.request.id,
                        -32000,
                        AppServerErrorName::ServerOverloaded,
                    )));
                }
            }
        } else {
            None
        };
        let permit = match prepared.scope.clone() {
            Some(scope) => self
                .request_scheduler
                .acquire_with_cancellation(connection.connection_id, scope, &prepared.cancellation)
                .map(Some),
            None => Ok(None),
        };
        self.execute_request(
            connection,
            prepared,
            request_dispatch::RequestAdmission {
                permit,
                ready_at: Instant::now(),
            },
            deliver,
        )
    }

    pub(super) fn prepare_request(
        &self,
        connection: &ConnectionState,
        raw: &str,
    ) -> Result<PreparedRequest, String> {
        let received_at = Instant::now();
        let received_time = SystemTime::now();
        let raw_request: Value = match serde_json::from_str(raw) {
            Ok(request) => request,
            Err(_) => {
                return Err(serialize_response(error_response(
                    JsonRpcId::Null(()),
                    -32700,
                    AppServerErrorName::ParseError,
                )));
            }
        };
        let request = match serde_json::from_value::<JsonRpcRequest<Value>>(raw_request) {
            Ok(request)
                if request.jsonrpc == JsonRpcVersion::V2
                    && request.id.as_u64().is_some_and(|request_id| request_id > 0) =>
            {
                request
            }
            _ => {
                return Err(serialize_response(error_response(
                    JsonRpcId::Null(()),
                    -32600,
                    AppServerErrorName::InvalidRequest,
                )));
            }
        };
        let request_id = request.id.as_u64().expect("validated request ID");
        if connection.is_closed()
            || self
                .request_scheduler
                .is_connection_cancelled(connection.connection_id)
        {
            return Err(serialize_response(error_response(
                request.id,
                -32800,
                AppServerErrorName::RequestCancelled,
            )));
        }
        if !connection.record_request_id(request_id) {
            return Err(serialize_response(error_response(
                request.id,
                -32600,
                AppServerErrorName::InvalidRequest,
            )));
        }
        let operation_id = match client_method_definition(&request.method)
            .map(|definition| definition.cancellation_operation_id(&request.params))
            .transpose()
        {
            Ok(operation_id) => operation_id.flatten(),
            Err(_) => {
                return Err(serialize_response(error_response(
                    request.id,
                    -32602,
                    AppServerErrorName::InvalidParams,
                )));
            }
        };
        let serialization_scope = if client_method(&request.method)
            != Some(ClientMethod::Initialize)
            && !connection.is_initialized()
        {
            None
        } else {
            match client_method_definition(&request.method)
                .map(|definition| definition.serialization_scope(&request.params))
                .transpose()
            {
                Ok(scope) => scope.flatten(),
                Err(_) => {
                    return Err(serialize_response(error_response(
                        request.id,
                        -32602,
                        AppServerErrorName::InvalidParams,
                    )));
                }
            }
        };
        let serialization_scope = serialization_scope.map(|scope| {
            use ash_app_server_protocol::protocol::registry::ClientRequestSerializationScope as Declared;
            use request_serialization::RequestSerializationScope as Resolved;
            Ok(match scope {
                Declared::HostedAccount { account_id, access } => Resolved::HostedAccount { account_id, access },
                Declared::Global { access } => Resolved::Global { access },
                Declared::HostedRepository { host, owner, name, access } => Resolved::HostedRepository { host, owner, name, access },
                Declared::Session { session_id, access } => Resolved::Session { session_id, access },
                Declared::ConnectionResource { namespace, resource_id, access } => Resolved::ConnectionResource { namespace, resource_id, access },
                Declared::Repository { repository_id, access } => Resolved::Repository {
                    common_dir: self.git_runtime_service()?.common_dir_for(repository_id.as_deref()).map_err(git_operations::git_error)?,
                    access,
                },
            })
        }).transpose().map_err(|error: RpcError| serialize_response(error_response(request.id.clone(), error.code, error.message)))?;
        let cancellation = match self.request_cancellations.start(
            connection.connection_id,
            request_id,
            operation_id,
        ) {
            Ok(cancellation) => cancellation,
            Err(_) => {
                return Err(serialize_response(error_response(
                    request.id,
                    -32602,
                    AppServerErrorName::InvalidParams,
                )));
            }
        };
        Ok(PreparedRequest {
            request,
            cancellation,
            scope: serialization_scope,
            received_at,
            received_time,
        })
    }

    pub(super) fn execute_request<R>(
        &self,
        connection: &mut ConnectionState,
        prepared: PreparedRequest,
        admission: request_dispatch::RequestAdmission,
        deliver: impl FnOnce(String) -> R,
    ) -> R {
        let mut dispatch_connection = connection.clone();
        self.execute_request_with(
            connection,
            prepared,
            admission,
            Instant::now(),
            |request, cancellation| {
                if cancellation.is_cancelled() {
                    None
                } else {
                    Some(self.dispatch(&mut dispatch_connection, request, cancellation))
                }
            },
            deliver,
        )
    }

    // Network operations return to their connection's completion worker. Notification and
    // telemetry guards are thread-local and must never live across an async suspension.
    pub(super) fn execute_request_with<R>(
        &self,
        connection: &mut ConnectionState,
        prepared: PreparedRequest,
        admission: request_dispatch::RequestAdmission,
        execution_started: Instant,
        dispatch: impl FnOnce(
            &mut JsonRpcRequest<Value>,
            &CancellationToken,
        ) -> Option<Result<Value, RpcError>>,
        deliver: impl FnOnce(String) -> R,
    ) -> R {
        let PreparedRequest {
            mut request,
            cancellation,
            received_at,
            received_time,
            scope,
        } = prepared;
        let request_id = request.id.as_u64().expect("validated request ID");
        let initializing = client_method(&request.method) == Some(ClientMethod::Initialize);
        let request_span = self
            .telemetry
            .start_at(diagnostics::Activity::Rpc, received_time);
        request_span.record_duration(
            "rpc.resource_wait_ms",
            admission.ready_at.duration_since(received_at),
        );
        request_span.record_duration(
            "rpc.execution_queue_wait_ms",
            execution_started.duration_since(admission.ready_at),
        );
        let _permit = match admission.permit {
            Ok(permit) => permit,
            Err(_) => {
                self.request_cancellations
                    .finish(connection.connection_id, request_id);
                let delivered = deliver(serialize_response(error_response(
                    request.id,
                    -32800,
                    AppServerErrorName::RequestCancelled,
                )));
                request_span.finish(diagnostics::Outcome::Cancelled);
                return delivered;
            }
        };
        let session_id = match &scope {
            Some(request_serialization::RequestSerializationScope::Session {
                session_id,
                access: ash_app_server_protocol::protocol::registry::SerializationAccess::Exclusive,
            }) => Some(session_id.as_str()),
            _ => None,
        };
        // Turn producers can publish from another thread before their start response. Delay only
        // that Session's events, while unrelated background events and host calls keep flowing.
        let notifications = connection
            .outbound_notifications
            .defer_causal_notifications(session_id);
        let dispatch_result = dispatch(&mut request, &cancellation);
        // A started remote write owns its outcome. Cancellation cannot erase an
        // acknowledged effect or turn an uncertain submission into a safe retry.
        let preserves_outcome = client_method_definition(&request.method).is_some_and(|definition| {
            matches!(definition.cancellation, ash_app_server_protocol::protocol::registry::CancellationDefinition::OperationIdPreserveOutcome(_))
        });
        let cancelled =
            cancellation.is_cancelled() && (dispatch_result.is_none() || !preserves_outcome);
        let (response, outcome) = if cancelled {
            (
                serialize_response(error_response(
                    request.id,
                    -32800,
                    AppServerErrorName::RequestCancelled,
                )),
                diagnostics::Outcome::Cancelled,
            )
        } else {
            match dispatch_result.expect("uncancelled request must have a dispatch result") {
                Ok(result) => (
                    serde_json::to_string(&JsonRpcSuccess::new(request.id, result))
                        .expect("JSON-RPC success response must serialize"),
                    diagnostics::Outcome::Succeeded,
                ),
                Err(error) => {
                    let mut failure = AppServerError::new(error.code, error.message);
                    if let Some(detail) = error.detail {
                        failure.message.push_str(&format!(": {detail}"));
                    }
                    (
                        serde_json::to_string(&JsonRpcFailure::new(request.id, failure))
                            .expect("JSON-RPC error response must serialize"),
                        if error.message == AppServerErrorName::RequestCancelled {
                            diagnostics::Outcome::Cancelled
                        } else {
                            diagnostics::Outcome::Failed
                        },
                    )
                }
            }
        };
        self.request_cancellations
            .finish(connection.connection_id, request_id);
        // State is committed before delivery. A slow connection's output queue must not retain
        // resource admission shared with other connections.
        drop(_permit);
        request_span.record_duration("rpc.execution_ms", execution_started.elapsed());
        let outbound_started = Instant::now();
        let delivered = deliver(response);
        if initializing && outcome == diagnostics::Outcome::Succeeded {
            connection.outbound_notifications.initialized();
        }
        drop(notifications);
        request_span.record_duration("rpc.outbound_queue_wait_ms", outbound_started.elapsed());
        request_span.finish(outcome);
        delivered
    }
}
