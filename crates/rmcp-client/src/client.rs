use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequest, CallToolRequestParams, CallToolResult, ClientInfo, ClientRequest,
    ElicitationCapability, FormElicitationCapability, Implementation, ListToolsRequest,
    ListToolsResult, PaginatedRequestParams, ServerInfo, ServerResult,
};
use rmcp::service::{
    ClientServiceExt, PeerRequestOptions, RequestHandle, RoleClient, RunningService, ServiceError,
};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{IntoTransport, StreamableHttpClientTransport};

use crate::error::RmcpClientError;
use crate::handler::{ClientRuntimeHandler, McpClientHost, NoopMcpClientHost};
use crate::transport::{HttpAuthorization, StdioServerCommand, StreamableHttpServer};

/// Deadlines applied independently to initialize, normal requests, and shutdown.
#[derive(Clone, Copy, Debug)]
pub struct RmcpTimeouts {
    pub initialize: Duration,
    pub request: Duration,
    pub shutdown: Duration,
}

impl Default for RmcpTimeouts {
    fn default() -> Self {
        Self {
            initialize: Duration::from_secs(10),
            request: Duration::from_secs(60),
            shutdown: Duration::from_secs(5),
        }
    }
}

/// Client identity, host callbacks, and operation deadlines for a new MCP session.
#[derive(Clone)]
pub struct RmcpClientOptions {
    client_info: ClientInfo,
    host: Arc<dyn McpClientHost>,
    timeouts: RmcpTimeouts,
}

impl std::fmt::Debug for RmcpClientOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RmcpClientOptions")
            .field("client_info", &self.client_info)
            .field("host", &"<dyn McpClientHost>")
            .field("timeouts", &self.timeouts)
            .finish()
    }
}

impl RmcpClientOptions {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        let mut client_info = ClientInfo::default();
        client_info.client_info = Implementation::new(name, version);
        Self {
            client_info,
            host: Arc::new(NoopMcpClientHost),
            timeouts: RmcpTimeouts::default(),
        }
    }

    pub fn with_client_info(mut self, client_info: ClientInfo) -> Self {
        self.client_info = client_info;
        self
    }

    pub fn with_host(mut self, host: Arc<dyn McpClientHost>) -> Self {
        self.host = host;
        self
    }

    /// Advertises validated form elicitation when the installed host can durably route it.
    pub fn with_form_elicitation(mut self) -> Self {
        self.client_info.capabilities.elicitation = Some(
            ElicitationCapability::new()
                .with_form(FormElicitationCapability::new().with_schema_validation(false)),
        );
        self
    }

    pub fn with_timeouts(mut self, timeouts: RmcpTimeouts) -> Self {
        self.timeouts = timeouts;
        self
    }
}

/// One initialized, isolated MCP client session.
///
/// The client exposes RMCP wire models intentionally. Product catalog projection, approval,
/// durable tool results, credential persistence, and reconnect policy belong to higher layers.
pub struct RmcpClient {
    service: RunningService<RoleClient, ClientRuntimeHandler>,
    server_info: Arc<ServerInfo>,
    timeouts: RmcpTimeouts,
}

impl RmcpClient {
    /// Initialize a client over a caller-provided RMCP transport.
    ///
    /// This is the integration point for sandboxed or remote process launchers and custom HTTP
    /// stacks. Convenience constructors below only cover direct local stdio and reqwest HTTP.
    pub async fn connect<T, E, A>(
        transport: T,
        options: RmcpClientOptions,
    ) -> Result<Self, RmcpClientError>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: Error + Send + Sync + 'static,
    {
        let RmcpClientOptions {
            client_info,
            host,
            timeouts,
        } = options;
        let handler = ClientRuntimeHandler::new(client_info, host);
        let initialize =
            handler.serve_with_lifecycle(transport, rmcp::service::ClientLifecycleMode::Initialize);
        let service = tokio::time::timeout(timeouts.initialize, initialize)
            .await
            .map_err(|_| RmcpClientError::InitializeTimeout(timeouts.initialize))?
            .map_err(|error| RmcpClientError::Initialize(Box::new(error)))?;
        let server_info = service
            .peer()
            .peer_info()
            .ok_or(RmcpClientError::MissingServerInfo)?;
        Ok(Self {
            service,
            server_info,
            timeouts,
        })
    }

    /// Spawn a local child process and initialize an MCP session over stdio.
    pub async fn connect_stdio(
        command: StdioServerCommand,
        options: RmcpClientOptions,
    ) -> Result<Self, RmcpClientError> {
        let transport = TokioChildProcess::new(command.into_command())
            .map_err(RmcpClientError::TransportStart)?;
        Self::connect(transport, options).await
    }

    /// Initialize an MCP session over Streamable HTTP using RMCP's reqwest transport.
    pub async fn connect_streamable_http(
        server: StreamableHttpServer,
        options: RmcpClientOptions,
    ) -> Result<Self, RmcpClientError> {
        let (uri, authorization) = server.into_parts();
        let mut transport_config = StreamableHttpClientTransportConfig::with_uri(uri);
        if let HttpAuthorization::Bearer(token) = authorization {
            transport_config = transport_config.auth_header(token.into_inner());
        }
        // Preserve the SDK's OS trust, no redirects, and disabled idle pooling.
        let client = ash_http_client::ReqwestHttpClient::sdk_client_builder()
            .map_err(|error| RmcpClientError::TransportStart(std::io::Error::other(error)))?
            .pool_max_idle_per_host(0)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| RmcpClientError::TransportStart(std::io::Error::other(error)))?;
        let transport = StreamableHttpClientTransport::with_client(client, transport_config);
        Self::connect(transport, options).await
    }

    pub fn server_info(&self) -> &ServerInfo {
        &self.server_info
    }

    pub fn is_closed(&self) -> bool {
        self.service.is_closed() || self.service.peer().is_transport_closed()
    }

    pub async fn list_tools(&self) -> Result<ListToolsResult, RmcpClientError> {
        self.list_tools_page(None).await
    }

    pub async fn list_tools_after(
        &self,
        cursor: impl Into<String>,
    ) -> Result<ListToolsResult, RmcpClientError> {
        let mut params = PaginatedRequestParams::default();
        params.cursor = Some(cursor.into());
        self.list_tools_page(Some(params)).await
    }

    async fn list_tools_page(
        &self,
        params: Option<PaginatedRequestParams>,
    ) -> Result<ListToolsResult, RmcpClientError> {
        let request = match params {
            Some(params) => ListToolsRequest::with_param(params),
            None => ListToolsRequest::default(),
        };
        match self
            .send_request("tools/list", ClientRequest::ListToolsRequest(request))
            .await?
        {
            ServerResult::ListToolsResult(result) => Ok(result),
            _ => Err(RmcpClientError::Request {
                operation: "tools/list",
                source: ServiceError::UnexpectedResponse,
            }),
        }
    }

    pub async fn call_tool(
        &self,
        request: CallToolRequestParams,
    ) -> Result<CallToolResult, RmcpClientError> {
        self.call_tool_with_cancellation(request, std::future::pending())
            .await
    }

    /// Call a tool and send protocol cancellation when the supplied future resolves.
    pub async fn call_tool_with_cancellation<F>(
        &self,
        request: CallToolRequestParams,
        cancellation: F,
    ) -> Result<CallToolResult, RmcpClientError>
    where
        F: Future<Output = String>,
    {
        match self
            .send_request_with_cancellation(
                "tools/call",
                ClientRequest::CallToolRequest(CallToolRequest::new(request)),
                cancellation,
            )
            .await?
        {
            ServerResult::CallToolResult(result) => Ok(result),
            _ => Err(RmcpClientError::Request {
                operation: "tools/call",
                source: ServiceError::UnexpectedResponse,
            }),
        }
    }

    /// Cancel the session and wait up to the configured shutdown deadline for transport cleanup.
    pub async fn shutdown(mut self) -> Result<(), RmcpClientError> {
        match self
            .service
            .close_with_timeout(self.timeouts.shutdown)
            .await
            .map_err(RmcpClientError::Shutdown)?
        {
            Some(_) => Ok(()),
            None => Err(RmcpClientError::ShutdownTimeout(self.timeouts.shutdown)),
        }
    }

    async fn send_request(
        &self,
        operation: &'static str,
        request: ClientRequest,
    ) -> Result<ServerResult, RmcpClientError> {
        self.send_request_with_cancellation(operation, request, std::future::pending())
            .await
    }

    async fn send_request_with_cancellation<F>(
        &self,
        operation: &'static str,
        request: ClientRequest,
        cancellation: F,
    ) -> Result<ServerResult, RmcpClientError>
    where
        F: Future<Output = String>,
    {
        let handle = self
            .service
            .peer()
            .send_request_with_option(request, PeerRequestOptions::no_options())
            .await
            .map_err(|source| RmcpClientError::Request { operation, source })?;
        self.await_request(operation, handle, cancellation).await
    }

    async fn await_request<F>(
        &self,
        operation: &'static str,
        mut handle: RequestHandle<RoleClient>,
        cancellation: F,
    ) -> Result<ServerResult, RmcpClientError>
    where
        F: Future<Output = String>,
    {
        tokio::pin!(cancellation);
        let timeout = tokio::time::sleep(self.timeouts.request);
        tokio::pin!(timeout);
        tokio::select! {
            biased;
            response = &mut handle.rx => {
                response
                    .map_err(|_| RmcpClientError::Request {
                        operation,
                        source: ServiceError::TransportClosed,
                    })?
                    .map_err(|source| RmcpClientError::Request { operation, source })
            }
            reason = &mut cancellation => {
                let _ = handle.cancel(Some(reason.clone())).await;
                Err(RmcpClientError::Cancelled { operation, reason })
            }
            () = &mut timeout => {
                let _ = handle
                    .cancel(Some(RequestHandle::<RoleClient>::REQUEST_TIMEOUT_REASON.into()))
                    .await;
                Err(RmcpClientError::RequestTimeout {
                    operation,
                    duration: self.timeouts.request,
                })
            }
        }
    }
}
