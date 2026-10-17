use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_async_utils::CancellationToken;
use serde_json::Value;
use std::sync::Arc;

/// Browser ownership and network authorization use the same host and call policy as tools.
pub(super) struct BrowserRequestProcessor<'a> {
    browser_host: &'a Arc<super::BrowserHost>,
    calls: &'a Arc<super::call_runtime::Calls>,
    local_env_host: &'a Option<super::LocalEnvHost>,
}
impl<'a> BrowserRequestProcessor<'a> {
    pub(super) fn new(
        browser_host: &'a Arc<super::BrowserHost>,
        calls: &'a Arc<super::call_runtime::Calls>,
        local_env_host: &'a Option<super::LocalEnvHost>,
    ) -> Self {
        Self {
            browser_host,
            calls,
            local_env_host,
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
