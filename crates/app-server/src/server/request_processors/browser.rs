use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use crate::browser_favicons::BrowserFavicons;
use ash_app_server_protocol::protocol::browser::BrowserFaviconCancelParams;
use ash_app_server_protocol::protocol::browser::BrowserFaviconReadParams;
use ash_app_server_protocol::protocol::browser::BrowserFaviconReadResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_async_utils::CancellationToken;
use ash_http_client::OutboundNetworkPolicy;
use serde_json::Value;
use std::sync::Arc;
use std::sync::OnceLock;

#[derive(Debug)]
struct BrowserTcpAuthorization(ash_http_client::NetworkPermit);

impl network_proxy::TcpAuthorization for BrowserTcpAuthorization {
    fn check(&self) -> std::io::Result<()> {
        self.0
            .check()
            .map_err(|_| std::io::ErrorKind::PermissionDenied.into())
    }

    fn revoked(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(self.0.revoked())
    }
}

/// Browser ownership and network authorization use the same host and call policy as tools.
pub(super) struct BrowserRequestProcessor<'a> {
    browser_host: &'a Arc<super::BrowserHost>,
    calls: &'a Arc<super::call_runtime::Calls>,
    local_env_host: &'a Option<super::LocalEnvHost>,
    cancellations: &'a super::RequestCancellationRegistry,
    scheduler: &'a super::RequestScheduler,
}
impl<'a> BrowserRequestProcessor<'a> {
    pub(super) fn new(
        browser_host: &'a Arc<super::BrowserHost>,
        calls: &'a Arc<super::call_runtime::Calls>,
        local_env_host: &'a Option<super::LocalEnvHost>,
        cancellations: &'a super::RequestCancellationRegistry,
        scheduler: &'a super::RequestScheduler,
    ) -> Self {
        Self {
            browser_host,
            calls,
            local_env_host,
            cancellations,
            scheduler,
        }
    }

    pub(super) fn read_favicon(
        authority: super::ConnectionAuthority,
        favicons: &OnceLock<Option<BrowserFavicons>>,
        policy: OutboundNetworkPolicy,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if authority != super::ConnectionAuthority::ProductHost {
            return Err(RpcError::new(-32000, AppServerErrorName::ResourceNotOwner));
        }
        let params: BrowserFaviconReadParams = decode(params)?;
        let data_url = favicons
            .get_or_init(|| BrowserFavicons::new(policy).ok())
            .as_ref()
            .and_then(|favicons| favicons.read(&params.url, cancellation))
            .map(|data_url| data_url.to_string());
        result(&BrowserFaviconReadResult { data_url })
    }

    pub(super) fn cancel_favicon(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        if connection.authority != super::ConnectionAuthority::ProductHost {
            return Err(RpcError::new(-32000, AppServerErrorName::ResourceNotOwner));
        }
        let params: BrowserFaviconCancelParams = decode(params)?;
        if !(1..=128).contains(&params.operation_id.chars().count()) {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        self.cancellations
            .cancel_operation(connection.connection_id, params.operation_id);
        self.scheduler.cancel_waiting_requests();
        result(&())
    }
    pub(super) fn tcp(
        &self,
        connection: &ConnectionState,
        method: ash_app_server_protocol::protocol::registry::ClientMethod,
        params: &Value,
    ) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::browser as wire;
        use ash_app_server_protocol::protocol::registry::ClientMethod;
        use base64::Engine;
        if !matches!(
            connection.authority,
            super::ConnectionAuthority::ProductHost
                | super::ConnectionAuthority::RemoteHost
                | super::ConnectionAuthority::Browser
        ) {
            return Err(RpcError::new(-32000, AppServerErrorName::ResourceNotOwner));
        }
        let failed = |_| RpcError::new(-32000, AppServerErrorName::CoreOperationFailed);
        match method {
            ClientMethod::BrowserTcpOpen => {
                let params: wire::BrowserTcpOpenParams = decode(params)?;
                if params.stream.execution_target.is_some() || params.host.len() > 253 {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                let destination = network_proxy::NetworkRequest::new(
                    network_proxy::NetworkProtocol::Socks5Tcp,
                    &params.host,
                    params.port,
                )
                .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
                let permit = self
                    .calls
                    .network_policy()
                    .acquire(&format!("https://{}/", destination.authority()))
                    .map_err(|_| RpcError::new(-32000, AppServerErrorName::ResourceNotOwner))?;
                super::request_dispatch::runtime()
                    .map_err(failed)?
                    .block_on(connection.tcp_streams.open(
                        params.stream.stream_id,
                        &destination,
                        Arc::new(BrowserTcpAuthorization(permit)),
                    ))
                    .map_err(failed)?;
                result(&())
            }
            ClientMethod::BrowserTcpRead => {
                let params: wire::BrowserTcpParams = decode(params)?;
                if params.execution_target.is_some() {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                let (bytes, eof) = connection
                    .tcp_streams
                    .read(&params.stream_id)
                    .map_err(failed)?;
                result(&wire::BrowserTcpReadResult {
                    data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    eof,
                })
            }
            ClientMethod::BrowserTcpWrite => {
                let params: wire::BrowserTcpWriteParams = decode(params)?;
                if params.stream.execution_target.is_some() {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                if params.data_base64.len() > network_proxy::TCP_CHUNK_BYTES.div_ceil(3) * 4 {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(params.data_base64)
                    .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
                let written = if params.eof {
                    if !bytes.is_empty() {
                        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                    }
                    connection
                        .tcp_streams
                        .end(&params.stream.stream_id)
                        .map_err(failed)?;
                    0
                } else {
                    connection
                        .tcp_streams
                        .write(&params.stream.stream_id, &bytes)
                        .map_err(failed)?
                };
                result(&wire::BrowserTcpWriteResult { written })
            }
            ClientMethod::BrowserTcpClose => {
                let params: wire::BrowserTcpParams = decode(params)?;
                if params.execution_target.is_some() {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                connection.tcp_streams.close(&params.stream_id);
                result(&())
            }
            _ => Err(RpcError::new(-32601, AppServerErrorName::MethodNotFound)),
        }
    }
    pub(super) fn configure(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::browser::BrowserConfigureParams =
            decode(params)?;
        self.browser_host
            .configure(connection.connection_id, &params)
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ResourceNotOwner))?;
        self.synchronize_tool_availability()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        result(&())
    }
    pub(super) fn authorize_network(
        &self,
        connection: &ConnectionState,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::browser::BrowserNetworkAuthorizeParams =
            decode(params)?;
        let policy = self.calls.network_policy();
        let allowed = !params.network_token.is_empty()
            && params.network_token.len() <= 256
            && !params.url.is_empty()
            && params.url.len() <= 8192
            && !params.method.is_empty()
            && params.method.len() <= 32
            && cancellation.check().is_ok()
            && policy.check_url(&params.url).is_ok()
            && self
                .browser_host
                .authorize_network(connection.connection_id, &params)
            && policy.check_url(&params.url).is_ok()
            && cancellation.check().is_ok();
        result(
            &ash_app_server_protocol::protocol::browser::BrowserNetworkAuthorizeResult { allowed },
        )
    }
    pub(super) fn set_sharing(
        &self,
        connection: &ConnectionState,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if !connection.supports_directory_grants_host() {
            return Err(RpcError::new(-32000, AppServerErrorName::ResourceNotOwner));
        }
        let params: ash_app_server_protocol::protocol::browser::BrowserSharingSetParams =
            decode(params)?;
        if params.target_id.is_empty()
            || params.target_id.len() > 256
            || params.thread_ids.len() > 32
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        self.browser_host
            .set_sharing(connection.connection_id, &params, cancellation)
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ResourceNotOwner))?;
        result(&())
    }
    pub(super) fn synchronize_tool_availability(&self) -> Result<(), String> {
        let Some(host) = &self.local_env_host else {
            return Ok(());
        };
        loop {
            let (revision, available) = self.browser_host.owner_availability();
            host.replace_browser_host_available(available)
                .map_err(|error| error.to_string())?;
            if self.browser_host.owner_availability().0 == revision {
                return Ok(());
            }
        }
    }
}
