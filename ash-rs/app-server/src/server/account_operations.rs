use super::AppServer;
use super::RpcError;
use super::UpdateBroker;
use super::decode;
use super::result;
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
    pub(super) fn account_read(&self) -> Result<Value, RpcError> {
        result(&account_state_dto(
            self.login_service()?.refresh().map_err(login_error)?,
        ))
    }

    pub(super) fn account_login_start(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AccountLoginStartParams = decode(params)?;
        let method = match params.method {
            AccountLoginMethodDto::OpenAiChatGptBrowser => LoginMethod::OpenAiChatGptBrowser,
            AccountLoginMethodDto::OpenAiChatGptDeviceCode => LoginMethod::OpenAiChatGptDeviceCode,
            AccountLoginMethodDto::KimiDeviceCode => LoginMethod::KimiDeviceCode,
        };
        let started = self.login_service()?.begin(method).map_err(login_error)?;
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
        LoginErrorKind::Driver => AppServerErrorName::AccountOperationFailed,
    };
    RpcError::new(-32030, name)
}
