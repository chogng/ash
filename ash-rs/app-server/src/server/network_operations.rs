use super::AppServer;
use super::RpcError;
use super::config_operations::config_command_result;
use super::config_operations::config_operation_error;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::account::AccountReadResult;
use ash_app_server_protocol::protocol::account::AccountStatusDto;
use ash_app_server_protocol::protocol::diagnostics::HttpCompatibilityModeDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkCheckDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkCheckOutcomeDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkDiagnosticsRunResult;
use ash_app_server_protocol::protocol::diagnostics::NetworkFailureDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkHttpConfigureParams;
use ash_app_server_protocol::protocol::diagnostics::NetworkPurposeDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkReadResult;
use ash_app_server_protocol::protocol::diagnostics::NetworkRouteDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkTargetDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use ash_async_utils::CancellationToken;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::ResolvedConfigSnapshot;
use ash_config::UserConfigCommand;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpConnectionFailure;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::OutboundProxyRoute;
use ash_model_provider_config::ModelProviderConfig;
use serde_json::Value;
use std::sync::Arc;
use url::Url;

pub(super) struct NetworkDiagnostics {
    pub network: OutboundNetworkSnapshot,
    pub http: Arc<dyn HttpClient>,
    pub services: Vec<(String, String)>,
}

struct Target {
    dto: NetworkTargetDto,
    url: String,
}

impl AppServer {
    pub(crate) fn with_network_diagnostics(
        mut self,
        network: OutboundNetworkSnapshot,
        http: Arc<dyn HttpClient>,
        services: Vec<(String, String)>,
    ) -> Self {
        self.network_diagnostics = Some(NetworkDiagnostics {
            network,
            http,
            services,
        });
        self
    }

    fn network_targets(&self, config: &ResolvedConfigSnapshot) -> Result<Vec<Target>, RpcError> {
        let diagnostics = self.network_diagnostics.as_ref().ok_or_else(unavailable)?;
        let providers: ProviderListResult =
            serde_json::from_value(self.provider_list()?).map_err(|_| unavailable())?;
        let runtime = self.provider_runtime.as_ref().ok_or_else(unavailable)?;
        let mut targets = Vec::new();
        for provider in providers
            .providers
            .into_iter()
            .filter(|entry| entry.configured)
        {
            // These connections delegate their transport to an external runtime.
            if matches!(provider.connection.as_str(), "kimi-desktop" | "kimi-cli") {
                continue;
            }
            let id = ash_protocol::ModelConnectionId::new(&provider.connection)
                .map_err(|_| unavailable())?;
            let settings = config
                .values
                .connections
                .get(&id)
                .cloned()
                .unwrap_or_else(|| ModelProviderConfig::for_connection(id));
            let endpoint = runtime
                .connection_endpoint(&settings)
                .map_err(|_| unavailable())?;
            targets.push(target(
                diagnostics,
                &provider.connection,
                &provider.display_name,
                NetworkPurposeDto::Model,
                &endpoint,
            )?);
            let sign_in = match provider.connection.as_str() {
                "chatgpt-subscription" => Some(ash_chatgpt::sign_in_endpoint()),
                "kimi-subscription" => Some(ash_kimi::sign_in_endpoint()),
                "xai-subscription" => Some(supergrok::sign_in_endpoint()),
                "bigmodel-coding-plan"
                | "zai-coding-plan"
                | "bigmodel-start-plan"
                | "zai-start-plan" => Some(ash_glm::sign_in_endpoint()),
                _ => None,
            };
            if let Some(endpoint) = sign_in {
                targets.push(target(
                    diagnostics,
                    &provider.connection,
                    &provider.display_name,
                    NetworkPurposeDto::SignIn,
                    endpoint,
                )?);
            }
            let usage = match provider.connection.as_str() {
                "chatgpt-subscription" => Some(ash_chatgpt::usage_endpoint()),
                "bigmodel-coding-plan" => {
                    Some(ash_glm::usage_endpoint(ash_glm::GlmProvider::BigModel))
                }
                "zai-coding-plan" => Some(ash_glm::usage_endpoint(ash_glm::GlmProvider::Zai)),
                "bigmodel-start-plan" => Some(ash_glm::usage_endpoint(
                    ash_glm::GlmProvider::BigModelStartPlan,
                )),
                "zai-start-plan" => {
                    Some(ash_glm::usage_endpoint(ash_glm::GlmProvider::ZaiStartPlan))
                }
                _ => None,
            };
            if let Some(endpoint) = usage {
                targets.push(target(
                    diagnostics,
                    &provider.connection,
                    &provider.display_name,
                    NetworkPurposeDto::Usage,
                    endpoint,
                )?);
            }
        }
        for (name, endpoint) in &diagnostics.services {
            targets.push(target(
                diagnostics,
                name,
                name,
                NetworkPurposeDto::Service,
                endpoint,
            )?);
        }
        targets.sort_by(|left, right| left.dto.id.cmp(&right.dto.id));
        targets.dedup_by(|left, right| left.dto.id == right.dto.id);
        Ok(targets)
    }

    pub(super) fn network_http_configure(&self, value: &Value) -> Result<Value, RpcError> {
        let params: NetworkHttpConfigureParams = decode(value)?;
        let diagnostics = self.network_diagnostics.as_ref().ok_or_else(unavailable)?;
        let mode = match params.http_mode {
            HttpCompatibilityModeDto::Http2 => ash_config::HttpCompatibilityMode::Http2,
            HttpCompatibilityModeDto::Http1 => ash_config::HttpCompatibilityMode::Http1,
        };
        let store = self.config.as_ref().ok_or_else(unavailable)?;
        let outcome = store
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::SetHttpCompatibilityMode { mode },
            })
            .map_err(config_operation_error)?;
        // Read the authority after persistence: an idempotent replay must not reapply an older mode.
        let current = store.read_snapshot().map_err(|_| unavailable())?;
        diagnostics.network.set_http_compatibility_mode(
            http_transport_mode(current.values.network.http_mode),
            current.revision.get(),
        );
        result(&config_command_result(outcome))
    }

    pub(super) fn network_read(&self) -> Result<Value, RpcError> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(unavailable)?
            .read_snapshot()
            .map_err(|_| unavailable())?;
        result(&NetworkReadResult {
            revision: config.revision.get(),
            http_mode: http_mode_dto(config.values.network.http_mode),
            targets: self
                .network_targets(&config)?
                .into_iter()
                .map(|target| target.dto)
                .collect(),
        })
    }

    pub(super) fn network_diagnostics_run(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let diagnostics = self.network_diagnostics.as_ref().ok_or_else(unavailable)?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(unavailable)?
            .read_snapshot()
            .map_err(|_| unavailable())?;
        let targets = self.network_targets(&config)?;
        let mut checks = Vec::new();
        for target in &targets {
            check_cancelled(cancellation)?;
            // A bounded, unauthenticated GET tests the actual HTTP route without
            // spending model tokens. Only status is retained; no response data is returned.
            let request = HttpRequest::new(HttpMethod::Get, &target.url, Vec::new(), Vec::new())
                .map_err(|_| unavailable())?;
            let outcome = match diagnostics
                .http
                .execute_with_cancellation(&request, cancellation)
            {
                Ok(response) => NetworkCheckOutcomeDto::Reachable {
                    http_status: response.status(),
                },
                Err(error) => NetworkCheckOutcomeDto::Failed {
                    failure: http_failure(error),
                },
            };
            checks.push(NetworkCheckDto {
                connection: target.dto.connection.clone(),
                target_id: Some(target.dto.id.clone()),
                outcome,
            });
        }
        let accounts: AccountReadResult =
            serde_json::from_value(self.account_read()?).map_err(|_| unavailable())?;
        for account in accounts
            .accounts
            .into_iter()
            .filter(|account| account.status == AccountStatusDto::Ready)
        {
            if !targets
                .iter()
                .any(|target| target.dto.connection == account.provider)
            {
                continue;
            }
            check_cancelled(cancellation)?;
            let params =
                serde_json::json!({"provider":account.provider,"accountId":account.account_id});
            let outcome = match self.account_rate_limits_read(&params, cancellation) {
                Ok(_) => NetworkCheckOutcomeDto::AccountAvailable,
                Err(error) => NetworkCheckOutcomeDto::Failed {
                    failure: account_failure(error),
                },
            };
            checks.push(NetworkCheckDto {
                connection: account.provider,
                target_id: None,
                outcome,
            });
        }
        check_cancelled(cancellation)?;
        result(&NetworkDiagnosticsRunResult {
            network: NetworkReadResult {
                revision: config.revision.get(),
                http_mode: http_mode_dto(config.values.network.http_mode),
                targets: targets.into_iter().map(|target| target.dto).collect(),
            },
            checks,
        })
    }
}

fn target(
    network: &NetworkDiagnostics,
    connection: &str,
    display_name: &str,
    purpose: NetworkPurposeDto,
    endpoint: &str,
) -> Result<Target, RpcError> {
    let url = Url::parse(endpoint).map_err(|_| unavailable())?;
    let host = url.host_str().ok_or_else(unavailable)?.to_owned();
    let port = url.port_or_known_default().ok_or_else(unavailable)?;
    let route = match network.network.proxy_route(endpoint) {
        Ok(OutboundProxyRoute::Direct) => NetworkRouteDto::Direct,
        Ok(OutboundProxyRoute::Proxy(proxy)) => {
            let proxy = Url::parse(proxy.url()).map_err(|_| unavailable())?;
            NetworkRouteDto::Proxy {
                host: proxy.host_str().ok_or_else(unavailable)?.into(),
                port: proxy.port_or_known_default().ok_or_else(unavailable)?,
            }
        }
        Err(HttpClientError::InvalidRequest(_)) => NetworkRouteDto::Blocked,
        Err(_) => return Err(unavailable()),
    };
    // Never probe a configured path/query that could perform an operation or contain a secret.
    // Preserve scheme/host/port so proxy bypass selection stays identical to product requests.
    let origin = format!("{}/", url.origin().ascii_serialization());
    Ok(Target {
        dto: NetworkTargetDto {
            id: format!("{connection}:{purpose:?}:{host}:{port}"),
            connection: connection.into(),
            display_name: display_name.into(),
            host,
            port,
            purpose,
            route,
        },
        url: origin,
    })
}

fn http_failure(error: HttpClientError) -> NetworkFailureDto {
    match error {
        HttpClientError::Connection(failure) => match failure {
            HttpConnectionFailure::Dns => NetworkFailureDto::Dns,
            HttpConnectionFailure::Proxy => NetworkFailureDto::Proxy,
            HttpConnectionFailure::Tls => NetworkFailureDto::Tls,
            HttpConnectionFailure::CertificateConfiguration => {
                NetworkFailureDto::CertificateConfiguration
            }
            HttpConnectionFailure::Connect => NetworkFailureDto::Connect,
            HttpConnectionFailure::Timeout => NetworkFailureDto::Timeout,
        },
        HttpClientError::InvalidConfiguration(_) => NetworkFailureDto::Configuration,
        HttpClientError::InvalidRequest(_) => NetworkFailureDto::Policy,
        HttpClientError::Transport(_) => NetworkFailureDto::Request,
    }
}

fn account_failure(error: RpcError) -> NetworkFailureDto {
    match error.message {
        AppServerErrorName::AccountChanged => NetworkFailureDto::AccountChanged,
        AppServerErrorName::AccountAuthenticationRequired => NetworkFailureDto::Authentication,
        _ => NetworkFailureDto::AccountOperation,
    }
}

fn unavailable() -> RpcError {
    RpcError::new(-32603, AppServerErrorName::InternalError)
}
fn check_cancelled(token: &CancellationToken) -> Result<(), RpcError> {
    if token.is_cancelled() {
        Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled))
    } else {
        Ok(())
    }
}

fn http_mode_dto(mode: ash_config::HttpCompatibilityMode) -> HttpCompatibilityModeDto {
    match mode {
        ash_config::HttpCompatibilityMode::Http2 => HttpCompatibilityModeDto::Http2,
        ash_config::HttpCompatibilityMode::Http1 => HttpCompatibilityModeDto::Http1,
    }
}

pub(crate) fn http_transport_mode(
    mode: ash_config::HttpCompatibilityMode,
) -> ash_http_client::HttpCompatibilityMode {
    match mode {
        ash_config::HttpCompatibilityMode::Http2 => ash_http_client::HttpCompatibilityMode::Http2,
        ash_config::HttpCompatibilityMode::Http1 => ash_http_client::HttpCompatibilityMode::Http1,
    }
}
