use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::connectors::ConnectorAccountDto;
use ash_app_server_protocol::protocol::connectors::ConnectorAvailableActionDto;
use ash_app_server_protocol::protocol::connectors::ConnectorCommandDispositionDto;
use ash_app_server_protocol::protocol::connectors::ConnectorCommandResultDto;
use ash_app_server_protocol::protocol::connectors::ConnectorConnectionStateDto;
use ash_app_server_protocol::protocol::connectors::ConnectorCredentialCleanupDto;
use ash_app_server_protocol::protocol::connectors::ConnectorCredentialCleanupParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthPollParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthPollResult;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthStartParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthStartResult;
use ash_app_server_protocol::protocol::connectors::ConnectorDisconnectParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDisconnectResultDto;
use ash_app_server_protocol::protocol::connectors::ConnectorDto;
use ash_app_server_protocol::protocol::connectors::ConnectorListResult;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthCancelParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthMethodDto;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthRefreshParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthStartParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthStartResult;
use ash_app_server_protocol::protocol::connectors::ConnectorSecretDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_secrets::SecretValue;
use connectors::ConnectorAccount;
use connectors::ConnectorAccountId;
use connectors::ConnectorApiTokenConnectRequest;
use connectors::ConnectorCommandDisposition;
use connectors::ConnectorCommandId;
use connectors::ConnectorCommandResult;
use connectors::ConnectorConnectionGeneration;
use connectors::ConnectorConnectionState;
use connectors::ConnectorCredentialCleanup;
use connectors::ConnectorCredentialServiceError;
use connectors::ConnectorCredentialServiceErrorKind;
use connectors::ConnectorDeviceOAuthPollResult as RuntimeDeviceOAuthPollResult;
use connectors::ConnectorDeviceOAuthStartRequest;
use connectors::ConnectorId;
use connectors::ConnectorOAuthCompleteRequest;
use connectors::ConnectorOAuthError;
use connectors::ConnectorOAuthErrorKind;
use connectors::ConnectorOAuthFlowId;
use connectors::ConnectorOAuthStartRequest;
use connectors::ConnectorSnapshotGeneration;
use serde_json::Value;

impl AppServer {
    pub(super) fn connector_list(&self) -> Result<Value, RpcError> {
        let service = self.connector_service()?;
        let snapshot = service.authority().snapshot();
        let connectors = snapshot
            .entries()
            .iter()
            .map(|entry| {
                connector_dto(
                    entry,
                    service,
                    self.connector_oauth.as_deref(),
                    self.connector_device_oauth.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        result(&ConnectorListResult {
            generation: snapshot.generation().get(),
            connectors,
        })
    }

    pub(super) fn connector_oauth_start(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorOAuthStartParams = decode(params)?;
        let oauth = self.connector_oauth_service()?;
        let authorization = oauth
            .start(ConnectorOAuthStartRequest {
                command_id: ConnectorCommandId::new(params.command_id)
                    .map_err(|_| invalid_params())?,
                expected_generation: ConnectorSnapshotGeneration::new(params.expected_generation),
                connector_id: ConnectorId::new(params.connector_id)
                    .map_err(|_| invalid_params())?,
                connection_generation: ConnectorConnectionGeneration::new(
                    params.connection_generation,
                ),
                redirect_uri: params.redirect_uri,
            })
            .map_err(connector_oauth_error)?;
        result(&ConnectorOAuthStartResult {
            flow_id: authorization.flow_id.as_str().to_owned(),
            authorization_url: authorization.authorization_url,
        })
    }

    pub(super) fn connector_oauth_complete(&self, params: Value) -> Result<Value, RpcError> {
        let Value::Object(mut params) = params else {
            return Err(invalid_params());
        };
        let state: ConnectorSecretDto =
            serde_json::from_value(params.remove("state").ok_or_else(invalid_params)?)
                .map_err(|_| invalid_params())?;
        let authorization_code: ConnectorSecretDto = serde_json::from_value(
            params
                .remove("authorizationCode")
                .ok_or_else(invalid_params)?,
        )
        .map_err(|_| invalid_params())?;
        let params: ConnectorOAuthCompleteMetadata =
            serde_json::from_value(Value::Object(params)).map_err(|_| invalid_params())?;
        let oauth = self.connector_oauth_service()?;
        let outcome = oauth
            .complete(ConnectorOAuthCompleteRequest {
                flow_id: ConnectorOAuthFlowId::new(params.flow_id).map_err(|_| invalid_params())?,
                state: SecretValue::new(state.into_bytes()),
                authorization_code: SecretValue::new(authorization_code.into_bytes()),
            })
            .map_err(connector_oauth_error)?;
        result(&command_result_dto(outcome))
    }

    pub(super) fn connector_oauth_cancel(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorOAuthCancelParams = decode(params)?;
        let result_value = self
            .connector_oauth_service()?
            .cancel(&ConnectorOAuthFlowId::new(params.flow_id).map_err(|_| invalid_params())?)
            .map_err(connector_oauth_error)?;
        result(&command_result_dto(result_value))
    }

    pub(super) fn connector_device_oauth_start(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorDeviceOAuthStartParams = decode(params)?;
        let authorization = self
            .connector_device_oauth_service()?
            .start(ConnectorDeviceOAuthStartRequest {
                command_id: ConnectorCommandId::new(params.command_id)
                    .map_err(|_| invalid_params())?,
                expected_generation: ConnectorSnapshotGeneration::new(params.expected_generation),
                connector_id: ConnectorId::new(params.connector_id)
                    .map_err(|_| invalid_params())?,
                connection_generation: ConnectorConnectionGeneration::new(
                    params.connection_generation,
                ),
            })
            .map_err(connector_oauth_error)?;
        result(&ConnectorDeviceOAuthStartResult {
            flow_id: authorization.flow_id.as_str().to_owned(),
            user_code: authorization.user_code,
            verification_uri: authorization.verification_uri,
            expires_in_seconds: authorization.expires_in_seconds,
            poll_interval_seconds: authorization.poll_interval_seconds,
        })
    }

    pub(super) fn connector_device_oauth_poll(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorDeviceOAuthPollParams = decode(params)?;
        let outcome = self
            .connector_device_oauth_service()?
            .poll(&ConnectorOAuthFlowId::new(params.flow_id).map_err(|_| invalid_params())?)
            .map_err(connector_oauth_error)?;
        result(&match outcome {
            RuntimeDeviceOAuthPollResult::Pending {
                retry_after_seconds,
            } => ConnectorDeviceOAuthPollResult::Pending {
                retry_after_seconds,
            },
            RuntimeDeviceOAuthPollResult::Connected(command) => {
                ConnectorDeviceOAuthPollResult::Connected {
                    command: command_result_dto(command),
                }
            }
        })
    }

    pub(super) fn connector_device_oauth_cancel(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorOAuthCancelParams = decode(params)?;
        let outcome = self
            .connector_device_oauth_service()?
            .cancel(&ConnectorOAuthFlowId::new(params.flow_id).map_err(|_| invalid_params())?)
            .map_err(connector_oauth_error)?;
        result(&command_result_dto(outcome))
    }

    pub(super) fn connector_oauth_refresh(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorOAuthRefreshParams = decode(params)?;
        let connector_id = ConnectorId::new(params.connector_id).map_err(|_| invalid_params())?;
        if self
            .connector_oauth
            .as_deref()
            .is_some_and(|oauth| oauth.supports(&connector_id))
        {
            self.connector_oauth_service()?
                .refresh(&connector_id)
                .map_err(connector_oauth_error)?;
        } else {
            self.connector_device_oauth_service()?
                .refresh(&connector_id)
                .map_err(connector_oauth_error)?;
        }
        result(&())
    }

    pub(super) fn connector_oauth_revoke(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorDisconnectParams = decode(params)?;
        let connector_id = ConnectorId::new(params.connector_id).map_err(|_| invalid_params())?;
        let command_id =
            ConnectorCommandId::new(params.command_id).map_err(|_| invalid_params())?;
        let expected_generation = ConnectorSnapshotGeneration::new(params.expected_generation);
        let outcome = if self
            .connector_oauth
            .as_deref()
            .is_some_and(|oauth| oauth.supports(&connector_id))
        {
            self.connector_oauth_service()?.revoke_and_disconnect(
                command_id,
                expected_generation,
                connector_id,
            )
        } else {
            self.connector_device_oauth_service()?
                .revoke_and_disconnect(command_id, expected_generation, connector_id)
        }
        .map_err(connector_oauth_error)?;
        result(&ConnectorDisconnectResultDto {
            command: command_result_dto(outcome.command),
            credential_cleanup: credential_cleanup_dto(outcome.credential_cleanup),
        })
    }

    pub(super) fn connector_api_token_connect(&self, params: Value) -> Result<Value, RpcError> {
        let Value::Object(mut params) = params else {
            return Err(invalid_params());
        };
        let api_token: ConnectorSecretDto =
            serde_json::from_value(params.remove("apiToken").ok_or_else(invalid_params)?)
                .map_err(|_| invalid_params())?;
        let params: ConnectorApiTokenConnectMetadata =
            serde_json::from_value(Value::Object(params)).map_err(|_| invalid_params())?;
        let service = self.connector_service()?;
        let outcome = service
            .connect_api_token(ConnectorApiTokenConnectRequest {
                command_id: ConnectorCommandId::new(params.command_id)
                    .map_err(|_| invalid_params())?,
                expected_generation: ConnectorSnapshotGeneration::new(params.expected_generation),
                connector_id: ConnectorId::new(params.connector_id)
                    .map_err(|_| invalid_params())?,
                connection_generation: ConnectorConnectionGeneration::new(
                    params.connection_generation,
                ),
                account_id: ConnectorAccountId::new(params.account_id)
                    .map_err(|_| invalid_params())?,
                account_display_name: params.account_display_name,
                token: SecretValue::new(api_token.into_bytes()),
            })
            .map_err(connector_error)?;
        result(&command_result_dto(outcome))
    }

    pub(super) fn connector_disconnect(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ConnectorDisconnectParams = decode(params)?;
        let service = self.connector_service()?;
        let outcome = service
            .disconnect(
                ConnectorCommandId::new(params.command_id).map_err(|_| invalid_params())?,
                ConnectorSnapshotGeneration::new(params.expected_generation),
                ConnectorId::new(params.connector_id).map_err(|_| invalid_params())?,
            )
            .map_err(connector_error)?;
        result(&ConnectorDisconnectResultDto {
            command: command_result_dto(outcome.command),
            credential_cleanup: credential_cleanup_dto(outcome.credential_cleanup),
        })
    }

    pub(super) fn connector_credential_cleanup_retry(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ConnectorCredentialCleanupParams = decode(params)?;
        let connector_id = ConnectorId::new(params.connector_id).map_err(|_| invalid_params())?;
        result(&credential_cleanup_dto(
            self.connector_service()?
                .retry_credential_cleanup(&connector_id),
        ))
    }

    fn connector_service(&self) -> Result<&connectors::ConnectorCredentialService, RpcError> {
        self.connectors
            .as_deref()
            .ok_or_else(|| RpcError::new(-32034, AppServerErrorName::ConnectorsUnavailable))
    }

    fn connector_oauth_service(&self) -> Result<&connectors::ConnectorOAuthService, RpcError> {
        self.connector_oauth
            .as_deref()
            .ok_or_else(|| RpcError::new(-32037, AppServerErrorName::ConnectorOAuthUnavailable))
    }

    fn connector_device_oauth_service(
        &self,
    ) -> Result<&connectors::ConnectorDeviceOAuthService, RpcError> {
        self.connector_device_oauth
            .as_deref()
            .ok_or_else(|| RpcError::new(-32037, AppServerErrorName::ConnectorOAuthUnavailable))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorApiTokenConnectMetadata {
    command_id: String,
    expected_generation: u64,
    connector_id: String,
    connection_generation: u64,
    account_id: String,
    account_display_name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorOAuthCompleteMetadata {
    flow_id: String,
}

fn connector_dto(
    entry: &connectors::ConnectorEntry,
    service: &connectors::ConnectorCredentialService,
    oauth: Option<&connectors::ConnectorOAuthService>,
    device_oauth: Option<&connectors::ConnectorDeviceOAuthService>,
) -> ConnectorDto {
    let browser_oauth_supported =
        oauth.is_some_and(|oauth| oauth.supports(entry.definition().id()));
    let device_oauth_supported =
        device_oauth.is_some_and(|oauth| oauth.supports(entry.definition().id()));
    let oauth_supported = browser_oauth_supported || device_oauth_supported;
    let oauth_refresh_supported = browser_oauth_supported;
    let oauth_revoke_supported = browser_oauth_supported
        || device_oauth.is_some_and(|oauth| oauth.supports_remote_revoke(entry.definition().id()));
    let connect_action = if oauth_supported {
        ConnectorAvailableActionDto::ConnectOAuth
    } else {
        ConnectorAvailableActionDto::ConnectApiToken
    };
    let reauthorize_action = if oauth_supported {
        ConnectorAvailableActionDto::ReauthorizeOAuth
    } else {
        ConnectorAvailableActionDto::ReauthorizeApiToken
    };
    let (state, available_actions) = match entry.connection().state() {
        ConnectorConnectionState::Disconnected => (
            ConnectorConnectionStateDto::Disconnected,
            vec![connect_action],
        ),
        ConnectorConnectionState::Connecting => (
            ConnectorConnectionStateDto::Connecting,
            vec![ConnectorAvailableActionDto::Disconnect],
        ),
        ConnectorConnectionState::Connected(account) => (
            ConnectorConnectionStateDto::Connected {
                account: account_dto(account),
            },
            oauth_connected_actions(OAuthLifecycleSupport {
                refresh: oauth_refresh_supported,
                remote_revoke: oauth_revoke_supported,
            }),
        ),
        ConnectorConnectionState::Unavailable { reason } => (
            ConnectorConnectionStateDto::Unavailable {
                reason: reason.clone(),
            },
            vec![connect_action, ConnectorAvailableActionDto::Disconnect],
        ),
        ConnectorConnectionState::ReauthorizationRequired {
            account,
            previous_definition,
        } => (
            ConnectorConnectionStateDto::ReauthorizationRequired {
                account: account_dto(account),
                previous_definition: previous_definition.as_str().to_string(),
            },
            vec![reauthorize_action, ConnectorAvailableActionDto::Disconnect],
        ),
    };
    ConnectorDto {
        id: entry.definition().id().as_str().to_string(),
        display_name: entry.definition().display_name().to_string(),
        description: entry.definition().description().to_string(),
        runtime_server_id: entry
            .definition()
            .runtime_binding()
            .mcp_server_id()
            .to_string(),
        definition_digest: entry.definition().digest().as_str().to_string(),
        connection_generation: entry.connection().generation().get(),
        state,
        available_actions,
        oauth_methods: [
            browser_oauth_supported.then_some(ConnectorOAuthMethodDto::Browser),
            device_oauth_supported.then_some(ConnectorOAuthMethodDto::Device),
        ]
        .into_iter()
        .flatten()
        .collect(),
        credential_cleanup_pending: service
            .authority()
            .credential_cleanup_pending(entry.definition().id()),
    }
}

struct OAuthLifecycleSupport {
    refresh: bool,
    remote_revoke: bool,
}

fn oauth_connected_actions(support: OAuthLifecycleSupport) -> Vec<ConnectorAvailableActionDto> {
    let mut actions = Vec::new();
    if support.refresh {
        actions.push(ConnectorAvailableActionDto::RefreshOAuth);
    }
    if support.remote_revoke {
        actions.push(ConnectorAvailableActionDto::RevokeOAuth);
    } else {
        actions.push(ConnectorAvailableActionDto::Disconnect);
    }
    actions
}

fn credential_cleanup_dto(cleanup: ConnectorCredentialCleanup) -> ConnectorCredentialCleanupDto {
    match cleanup {
        ConnectorCredentialCleanup::Deleted => ConnectorCredentialCleanupDto::Deleted,
        ConnectorCredentialCleanup::AlreadyAbsent => ConnectorCredentialCleanupDto::AlreadyAbsent,
        ConnectorCredentialCleanup::RetryRequired => ConnectorCredentialCleanupDto::RetryRequired,
    }
}

fn account_dto(account: &ConnectorAccount) -> ConnectorAccountDto {
    ConnectorAccountDto {
        id: account.account_id().as_str().to_string(),
        display_name: account.display_name().to_string(),
    }
}

fn command_result_dto(result: ConnectorCommandResult) -> ConnectorCommandResultDto {
    ConnectorCommandResultDto {
        generation: result.generation.get(),
        disposition: match result.disposition {
            ConnectorCommandDisposition::Updated => ConnectorCommandDispositionDto::Updated,
            ConnectorCommandDisposition::Replayed => ConnectorCommandDispositionDto::Replayed,
        },
    }
}

fn connector_error(error: ConnectorCredentialServiceError) -> RpcError {
    match error.kind() {
        ConnectorCredentialServiceErrorKind::CommandConflict => {
            RpcError::new(-32004, AppServerErrorName::CommandConflict)
        }
        ConnectorCredentialServiceErrorKind::GenerationConflict => {
            RpcError::new(-32035, AppServerErrorName::ConnectorGenerationConflict)
        }
        ConnectorCredentialServiceErrorKind::Authority
        | ConnectorCredentialServiceErrorKind::SecretStore
        | ConnectorCredentialServiceErrorKind::InvalidValue => {
            RpcError::new(-32036, AppServerErrorName::ConnectorOperationFailed)
        }
    }
}

fn connector_oauth_error(error: ConnectorOAuthError) -> RpcError {
    match error.kind() {
        ConnectorOAuthErrorKind::ProviderUnavailable => {
            RpcError::new(-32037, AppServerErrorName::ConnectorOAuthUnavailable)
        }
        ConnectorOAuthErrorKind::StateMismatch | ConnectorOAuthErrorKind::InvalidRequest => {
            RpcError::new(-32038, AppServerErrorName::ConnectorOAuthInvalidCallback)
        }
        ConnectorOAuthErrorKind::Expired => {
            RpcError::new(-32039, AppServerErrorName::ConnectorOAuthExpired)
        }
        ConnectorOAuthErrorKind::ProviderFailure | ConnectorOAuthErrorKind::Credential => {
            RpcError::new(-32036, AppServerErrorName::ConnectorOperationFailed)
        }
    }
}

fn invalid_params() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

#[cfg(test)]
#[path = "connector_operations_tests.rs"]
mod tests;
