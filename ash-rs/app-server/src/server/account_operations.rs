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
        if params.provider == supergrok::SUPERGROK_SUBSCRIPTION_PROVIDER_ID {
            let subscription = self
                .supergrok
                .as_ref()
                .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))?
                .read_subscription(&params.account_id, cancellation)
                .map_err(supergrok_error)?;
            return result(&xai_usage(params, subscription));
        }
        if params.provider == ash_kimi::KIMI_PROVIDER_ID {
            let (account, usage) = self
                .kimi
                .as_ref()
                .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))?
                .read_subscription(&params.account_id, cancellation)
                .map_err(kimi_error)?;
            return result(&kimi_usage(params, account, usage));
        }
        if let Some(account) = self.glm_accounts.get(&params.provider) {
            if account.is_start_plan() {
                let usage = account
                    .read_start_plan(&params.account_id, cancellation)
                    .map_err(glm_usage_error)?;
                return result(&start_plan_usage(params, usage)?);
            }
            let usage = account
                .read_usage(&params.account_id, cancellation)
                .map_err(glm_usage_error)?;
            return result(&glm_usage(params, usage));
        }
        if params.provider != ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID {
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

    pub(super) fn account_read(&self) -> Result<Value, RpcError> {
        let login = self.login_service()?;
        result(&account_state_dto(login.refresh().map_err(login_error)?))
    }

    pub(super) fn account_login_start(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AccountLoginStartParams = decode(params)?;
        let method = match params.method {
            AccountLoginMethodDto::OpenAiChatGptBrowser => LoginMethod::OpenAiChatGptBrowser,
            AccountLoginMethodDto::OpenAiChatGptDeviceCode => LoginMethod::OpenAiChatGptDeviceCode,
            AccountLoginMethodDto::KimiDeviceCode => LoginMethod::KimiDeviceCode,
            AccountLoginMethodDto::XaiDeviceCode => LoginMethod::XaiDeviceCode,
            AccountLoginMethodDto::BigModelBrowser => LoginMethod::BigModelBrowser,
            AccountLoginMethodDto::ZaiBrowser => LoginMethod::ZaiBrowser,
            AccountLoginMethodDto::BigModelStartPlanBrowser => {
                LoginMethod::BigModelStartPlanBrowser
            }
            AccountLoginMethodDto::ZaiStartPlanBrowser => LoginMethod::ZaiStartPlanBrowser,
            AccountLoginMethodDto::GitHubBrowser => LoginMethod::GitHubBrowser,
        };
        let login = self.login_service()?;
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
        let outcome = if let Some(account_id) = params.account_id {
            self.login_service()?
                .logout_account(&ash_login::AccountRef {
                    provider: params.provider,
                    account_id,
                })
        } else {
            self.login_service()?.logout_provider(&params.provider)
        }
        .map_err(login_error)?;
        let status = match outcome {
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
        resets_at: Some(window.resets_at),
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
        revision: state.revision.to_string(),
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
        credential_revision: account.credential_revision.to_string(),
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

fn supergrok_error(error: supergrok::SuperGrokError) -> RpcError {
    let name = match error.kind() {
        supergrok::SuperGrokErrorKind::Cancelled => AppServerErrorName::RequestCancelled,
        supergrok::SuperGrokErrorKind::AccountChanged => AppServerErrorName::AccountChanged,
        supergrok::SuperGrokErrorKind::Authentication => {
            AppServerErrorName::AccountAuthenticationRequired
        }
        _ => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(
        if error.kind() == supergrok::SuperGrokErrorKind::Cancelled {
            -32800
        } else {
            -32030
        },
        name,
    )
}

fn kimi_error(error: ash_kimi::KimiError) -> RpcError {
    use ash_kimi::KimiErrorKind;
    let name = match error.kind() {
        KimiErrorKind::Cancelled => AppServerErrorName::RequestCancelled,
        KimiErrorKind::Authentication => AppServerErrorName::AccountAuthenticationRequired,
        KimiErrorKind::AccountChanged => AppServerErrorName::AccountChanged,
        KimiErrorKind::Unavailable => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(
        if error.kind() == KimiErrorKind::Cancelled {
            -32800
        } else {
            -32030
        },
        name,
    )
}

fn glm_usage_error(error: ash_glm::GlmUsageError) -> RpcError {
    let name = match error {
        ash_glm::GlmUsageError::Unavailable => AppServerErrorName::AccountUnavailable,
        ash_glm::GlmUsageError::AccountChanged => AppServerErrorName::AccountChanged,
        ash_glm::GlmUsageError::AuthenticationRequired => {
            AppServerErrorName::AccountAuthenticationRequired
        }
        ash_glm::GlmUsageError::Cancelled => AppServerErrorName::RequestCancelled,
        ash_glm::GlmUsageError::RequestFailed => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(
        if error == ash_glm::GlmUsageError::Cancelled {
            -32800
        } else {
            -32030
        },
        name,
    )
}

fn glm_usage(
    params: AccountRateLimitsReadParams,
    limits: Vec<ash_glm::QuotaLimit>,
) -> AccountRateLimitsReadResult {
    let limits = limits
        .into_iter()
        .enumerate()
        .filter_map(|(index, limit)| {
            let (name, seconds) = match (limit.kind.as_str(), limit.unit, limit.number) {
                ("TOKENS_LIMIT" | "CREDIT_LIMIT", Some(3), Some(5)) => ("5-hour limit", 18_000),
                ("TOKENS_LIMIT" | "CREDIT_LIMIT", Some(6), Some(1)) => ("Weekly limit", 604_800),
                ("TOKENS_LIMIT" | "CREDIT_LIMIT", _, _) => ("Coding Plan limit", 0),
                ("TIME_LIMIT", _, _) => ("MCP limit", 0),
                _ => return None,
            };
            let percent = limit
                .percentage
                .filter(|value| value.is_finite() && *value >= 0.0)?;
            let used_percent = percent.ceil() as u32;
            Some(AccountRateLimitDto {
                id: format!("glm-{index}"),
                name: Some(name.into()),
                model: None,
                allowed: None,
                limit_reached: Some(percent >= 100.0),
                primary: Some(AccountRateLimitWindowDto {
                    used_percent,
                    window_seconds: seconds,
                    // The monitor reports epoch milliseconds; unknown units remain unknown.
                    resets_at: limit
                        .next_reset_time
                        .filter(|time| *time >= 1_000_000_000_000)
                        .map(|time| time / 1000),
                }),
                secondary: None,
            })
        })
        .collect();
    AccountRateLimitsReadResult {
        provider: params.provider,
        account_id: params.account_id,
        plan: None,
        limits,
        credits: None,
        xai: None,
    }
}

fn kimi_usage(
    params: AccountRateLimitsReadParams,
    account: ash_kimi::Account,
    usage: ash_kimi::Usage,
) -> AccountRateLimitsReadResult {
    let windows = usage.usages;
    let limits = [
        ("five-hour", "5-hour limit", 18_000, windows.limit_5h),
        ("weekly", "Weekly limit", 604_800, windows.limit_7d),
        ("monthly", "Monthly limit", 0, windows.limit_month_total),
    ]
    .into_iter()
    .filter_map(|(id, name, seconds, window)| {
        window.map(|window| {
            let used_percent = (window.used_ratio * 100.0).ceil() as u32;
            let resets_at = window
                .reset_time
                .and_then(|time| u64::try_from(time.timestamp()).ok());
            AccountRateLimitDto {
                id: id.into(),
                name: Some(name.into()),
                model: None,
                allowed: None,
                limit_reached: Some(window.used_ratio >= 1.0),
                primary: Some(AccountRateLimitWindowDto {
                    used_percent,
                    window_seconds: seconds,
                    resets_at,
                }),
                secondary: None,
            }
        })
    })
    .collect();
    AccountRateLimitsReadResult {
        provider: params.provider,
        account_id: params.account_id,
        plan: account
            .user_level_name
            .filter(|plan| !plan.trim().is_empty()),
        limits,
        credits: None,
        xai: None,
    }
}

fn xai_usage(
    params: AccountRateLimitsReadParams,
    subscription: supergrok::Subscription,
) -> AccountRateLimitsReadResult {
    use ash_app_server_protocol::protocol::account::AccountXaiUsageDto;
    let billing = subscription.billing.as_ref();
    let period = billing.and_then(|billing| billing.current_period.as_ref());
    let plan = subscription.plan().map(str::to_owned);
    AccountRateLimitsReadResult {
        provider: params.provider,
        account_id: params.account_id,
        plan,
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

fn start_plan_usage(
    params: AccountRateLimitsReadParams,
    usage: ash_glm::StartPlanUsage,
) -> Result<AccountRateLimitsReadResult, RpcError> {
    let limits = usage
        .limits
        .into_iter()
        .map(|limit| {
            let window_seconds = u32::try_from(limit.period_end - limit.period_start)
                .map_err(|_| RpcError::new(-32030, AppServerErrorName::AccountOperationFailed))?;
            let primary = if limit.total_units == 0 {
                None
            } else {
                let percent =
                    (u128::from(limit.used_units) * 100).div_ceil(u128::from(limit.total_units));
                Some(AccountRateLimitWindowDto {
                    used_percent: u32::try_from(percent).map_err(|_| {
                        RpcError::new(-32030, AppServerErrorName::AccountOperationFailed)
                    })?,
                    window_seconds,
                    resets_at: Some(limit.period_end),
                })
            };
            Ok(AccountRateLimitDto {
                id: limit.id,
                name: Some(limit.name),
                model: (limit.models.len() == 1).then(|| limit.models[0].clone()),
                allowed: Some(limit.available_units > 0),
                limit_reached: Some(limit.available_units == 0),
                primary,
                secondary: None,
            })
        })
        .collect::<Result<_, RpcError>>()?;
    Ok(AccountRateLimitsReadResult {
        provider: params.provider,
        account_id: params.account_id,
        plan: (!usage.plans.is_empty()).then(|| usage.plans.join(", ")),
        limits,
        credits: None,
        xai: None,
    })
}
