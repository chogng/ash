use super::AppServer;
use super::RpcError;
use super::UpdateBroker;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::account::AccountCreditBalanceDto;
use ash_app_server_protocol::protocol::account::AccountDto;
use ash_app_server_protocol::protocol::account::AccountLoginCancelParams;
use ash_app_server_protocol::protocol::account::AccountLoginCancelResult;
use ash_app_server_protocol::protocol::account::AccountLoginCancelStatusDto;
use ash_app_server_protocol::protocol::account::AccountLoginCompleted;
use ash_app_server_protocol::protocol::account::AccountLoginCompletionStatusDto;
use ash_app_server_protocol::protocol::account::AccountLoginFailureDto;
use ash_app_server_protocol::protocol::account::AccountLoginMethodDto;
use ash_app_server_protocol::protocol::account::AccountLoginStartParams;
use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
use ash_app_server_protocol::protocol::account::AccountLogoutParams;
use ash_app_server_protocol::protocol::account::AccountLogoutResult;
use ash_app_server_protocol::protocol::account::AccountLogoutStatusDto;
use ash_app_server_protocol::protocol::account::AccountRateLimitDto;
use ash_app_server_protocol::protocol::account::AccountRateLimitWindowDto;
use ash_app_server_protocol::protocol::account::AccountRateLimitsReadParams;
use ash_app_server_protocol::protocol::account::AccountRateLimitsReadResult;
use ash_app_server_protocol::protocol::account::AccountReadResult;
use ash_app_server_protocol::protocol::account::AccountStatusDto;
use ash_app_server_protocol::protocol::account::AccountUpdated;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_login::AccountSnapshot;
use ash_login::AccountState;
use ash_login::AccountStatus;
use ash_login::BeginLogin;
use ash_login::CancelLoginOutcome;
use ash_login::LoginCompletion;
use ash_login::LoginCompletionOutcome;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_login::LoginEvents;
use ash_login::LoginId;
use ash_login::LoginMethod;
use ash_login::LogoutOutcome;
use serde_json::Value;
use std::sync::Arc;

impl AppServer {
    pub(super) fn account_rate_limits_read(
        &self,
        params: &Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: AccountRateLimitsReadParams = decode(params)?;
        if params.account_id.trim().is_empty() {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params.provider == xai::XAI_PROVIDER_ID {
            let subscription = self
                .xai
                .as_ref()
                .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))?
                .read_subscription(&params.account_id, cancellation)
                .map_err(xai_error)?;
            return result(&xai_usage(params, subscription));
        }
        if params.provider != ash_chatgpt::OPENAI_CHATGPT_PROVIDER_ID {
            return Err(RpcError::new(
                -32030,
                AppServerErrorName::AccountRateLimitsUnavailable,
            ));
        }
        let usage = self
            .chatgpt
            .as_ref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))?
            .read_rate_limits(&params.account_id, cancellation)
            .map_err(usage_error)?;
        result(&AccountRateLimitsReadResult {
            provider: params.provider,
            account_id: params.account_id,
            plan: Some(usage.plan),
            xai: None,
            limits: usage
                .limits
                .into_iter()
                .map(|limit| AccountRateLimitDto {
                    id: limit.id,
                    name: limit.name,
                    model: limit.model,
                    allowed: limit.allowed,
                    limit_reached: limit.limit_reached,
                    primary: limit.primary.map(window_dto),
                    secondary: limit.secondary.map(window_dto),
                })
                .collect(),
            credits: usage.credits.map(|credits| AccountCreditBalanceDto {
                has_credits: credits.has_credits,
                unlimited: credits.unlimited,
                balance: credits.balance,
            }),
        })
    }

    pub(super) fn account_read(
        &self,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let login = self.login_service()?;
        let state = login.refresh().map_err(login_error)?;
        if let Some(auth) = &self.xai {
            if let Some(account) = state.accounts.iter().find(|account| {
                account.account.provider == xai::XAI_PROVIDER_ID
                    && account.status == AccountStatus::Ready
            }) {
                auth.refresh_account(&account.account.account_id, cancellation)
                    .map_err(xai_error)?;
            }
        }
        result(&account_state_dto(login.refresh().map_err(login_error)?))
    }

    pub(super) fn account_login_start(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AccountLoginStartParams = decode(params)?;
        let method = match params.method {
            AccountLoginMethodDto::OpenAiChatGptBrowser => LoginMethod::OpenAiChatGptBrowser,
            AccountLoginMethodDto::OpenAiChatGptDeviceCode => LoginMethod::OpenAiChatGptDeviceCode,
            AccountLoginMethodDto::KimiDeviceCode => LoginMethod::KimiDeviceCode,
            AccountLoginMethodDto::XaiDeviceCode => LoginMethod::XaiDeviceCode,
        };
        let login = self.login_service()?;
        if method == LoginMethod::XaiDeviceCode {
            let store = self
                .config
                .as_ref()
                .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
            let snapshot = store
                .read_snapshot()
                .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
            let provider =
                ash_protocol::ProviderId::new(xai::XAI_PROVIDER_ID).expect("constant provider ID");
            if !snapshot.values.providers.contains_key(&provider) {
                store
                    .apply(ash_config::ConfigCommandRequest {
                        command_id: ash_protocol::CommandId::new(format!(
                            "configure-xai-subscription-{}",
                            snapshot.revision.get()
                        ))
                        .expect("generated command ID"),
                        expected_revision: snapshot.revision,
                        command: ash_config::UserConfigCommand::ConfigureProvider {
                            provider: provider.clone(),
                            config: ash_model_provider_config::ModelProviderConfig::new(provider),
                        },
                    })
                    .map_err(super::config_operations::config_operation_error)?;
            }
        }
        let started = login.begin(method).map_err(login_error)?;
        result(&match started {
            BeginLogin::Connected { login_id, .. } => AccountLoginStartResult::Connected {
                login_id: login_id.to_string(),
            },
            BeginLogin::Browser {
                login_id,
                authorization_url,
            } => AccountLoginStartResult::Browser {
                login_id: login_id.to_string(),
                authorization_url,
            },
            BeginLogin::DeviceCode {
                login_id,
                verification_url,
                user_code,
            } => AccountLoginStartResult::DeviceCode {
                login_id: login_id.to_string(),
                verification_url,
                user_code,
            },
        })
    }

    pub(super) fn account_login_cancel(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AccountLoginCancelParams = decode(params)?;
        let login_id = LoginId::new(params.login_id).map_err(login_error)?;
        let status = match self
            .login_service()?
            .cancel(&login_id)
            .map_err(login_error)?
        {
            CancelLoginOutcome::Cancelled => AccountLoginCancelStatusDto::Cancelled,
            CancelLoginOutcome::NotFound => AccountLoginCancelStatusDto::NotFound,
        };
        result(&AccountLoginCancelResult { status })
    }

    pub(super) fn account_logout(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AccountLogoutParams = decode(params)?;
        let status = match self
            .login_service()?
            .logout_provider(&params.provider)
            .map_err(login_error)?
        {
            LogoutOutcome::LoggedOut => AccountLogoutStatusDto::LoggedOut,
            LogoutOutcome::AlreadyLoggedOut => AccountLogoutStatusDto::AlreadyLoggedOut,
        };
        result(&AccountLogoutResult { status })
    }

    fn login_service(&self) -> Result<&ash_login::LoginService, RpcError> {
        self.login
            .as_deref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))
    }
}

fn window_dto(window: ash_chatgpt::RateLimitWindow) -> AccountRateLimitWindowDto {
    AccountRateLimitWindowDto {
        used_percent: window.used_percent,
        window_seconds: window.window_seconds,
        resets_at: window.resets_at,
    }
}

fn usage_error(error: ash_chatgpt::ChatGptUsageError) -> RpcError {
    use ash_chatgpt::ChatGptUsageError;
    let code = match error {
        ChatGptUsageError::InvalidAccount => -32602,
        ChatGptUsageError::Cancelled => -32800,
        _ => -32030,
    };
    let name = match error {
        ChatGptUsageError::InvalidAccount => AppServerErrorName::InvalidParams,
        ChatGptUsageError::AccountUnavailable => AppServerErrorName::AccountUnavailable,
        ChatGptUsageError::AccountChanged => AppServerErrorName::AccountChanged,
        ChatGptUsageError::AuthenticationRequired => {
            AppServerErrorName::AccountAuthenticationRequired
        }
        ChatGptUsageError::Cancelled => AppServerErrorName::RequestCancelled,
        ChatGptUsageError::RequestFailed => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(code, name)
}

pub(super) struct AppServerLoginEvents {
    updates: Arc<UpdateBroker>,
}

impl AppServerLoginEvents {
    pub(super) fn new(updates: Arc<UpdateBroker>) -> Self {
        Self { updates }
    }
}

impl LoginEvents for AppServerLoginEvents {
    fn login_completed(&self, completion: LoginCompletion) {
        let status = match completion.outcome {
            LoginCompletionOutcome::Succeeded { .. } => AccountLoginCompletionStatusDto::Succeeded,
            LoginCompletionOutcome::Failed { failure } => AccountLoginCompletionStatusDto::Failed {
                failure: AccountLoginFailureDto {
                    code: failure.code,
                    message: failure.message,
                },
            },
        };
        self.updates
            .publish_account_login_completed(AccountLoginCompleted {
                login_id: completion.login_id.to_string(),
                status,
                account: account_state_dto(completion.account_state),
            });
    }

    fn account_updated(&self, state: AccountState) {
        self.updates.publish_account_updated(AccountUpdated {
            account: account_state_dto(state),
        });
    }
}

fn account_state_dto(state: AccountState) -> AccountReadResult {
    AccountReadResult {
        revision: state.revision,
        accounts: state.accounts.into_iter().map(account_dto).collect(),
    }
}

fn account_dto(account: AccountSnapshot) -> AccountDto {
    AccountDto {
        provider: account.account.provider,
        account_id: account.account.account_id,
        email: account.email,
        display_name: account.display_name,
        organization: account.organization,
        plan: account.plan,
        status: match account.status {
            AccountStatus::Ready => AccountStatusDto::Ready,
            AccountStatus::ReauthenticationRequired => AccountStatusDto::ReauthenticationRequired,
            AccountStatus::Unavailable => AccountStatusDto::Unavailable,
        },
        credential_revision: account.credential_revision,
    }
}

fn login_error(error: LoginError) -> RpcError {
    let name = match error.kind() {
        LoginErrorKind::InvalidInput => AppServerErrorName::InvalidParams,
        LoginErrorKind::Unavailable => AppServerErrorName::AccountUnavailable,
        LoginErrorKind::NotFound => AppServerErrorName::AccountLoginNotFound,
        LoginErrorKind::Conflict => AppServerErrorName::AccountLoginConflict,
        LoginErrorKind::ExternalLoginRequired => AppServerErrorName::AccountExternalLoginRequired,
        LoginErrorKind::Driver => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(-32030, name)
}

fn xai_error(error: xai::XaiError) -> RpcError {
    let name = match error.kind() {
        xai::XaiErrorKind::Cancelled => AppServerErrorName::RequestCancelled,
        xai::XaiErrorKind::AccountChanged => AppServerErrorName::AccountChanged,
        xai::XaiErrorKind::Authentication => AppServerErrorName::AccountAuthenticationRequired,
        _ => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(
        if error.kind() == xai::XaiErrorKind::Cancelled {
            -32800
        } else {
            -32030
        },
        name,
    )
}

fn xai_usage(
    params: AccountRateLimitsReadParams,
    subscription: xai::Subscription,
) -> AccountRateLimitsReadResult {
    use ash_app_server_protocol::protocol::account::AccountXaiUsageDto;
    let billing = subscription.billing.as_ref();
    let period = billing.and_then(|billing| billing.current_period.as_ref());
    AccountRateLimitsReadResult {
        provider: params.provider,
        account_id: params.account_id,
        plan: subscription.account.subscription_tier,
        limits: Vec::new(),
        credits: None,
        xai: Some(AccountXaiUsageDto {
            allowed: subscription.settings.allow_access,
            message: subscription.settings.gate_message,
            used_percent: billing.and_then(|billing| billing.credit_usage_percent),
            period_type: period.and_then(|period| period.period_type.clone()),
            period_start: period.and_then(|period| period.start.clone()),
            period_end: period.and_then(|period| period.end.clone()),
            prepaid_cents: billing
                .and_then(|billing| billing.prepaid_balance.as_ref())
                .map(|value| value.val.to_string()),
            on_demand_enabled: subscription.settings.on_demand_enabled,
            on_demand_used_cents: billing
                .and_then(|billing| billing.on_demand_used.as_ref())
                .map(|value| value.val.to_string()),
            on_demand_cap_cents: billing
                .and_then(|billing| billing.on_demand_cap.as_ref())
                .map(|value| value.val.to_string()),
            unified_billing: billing.and_then(|billing| billing.is_unified_billing_user),
        }),
    }
}
