//! Public authentication capability contract for either extension runtime.

use crate::AccountRef;
use crate::AccountSnapshot;
use crate::BeginLogin;
use crate::BeginLoginRequest;
use crate::CancelLoginOutcome;
use crate::CompleteLogin;
use crate::LoginError;
use crate::LoginId;
use serde::Deserialize;
use serde::Serialize;

/// Closed calls to one selected provider. The host supplies the provider identity.
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "operation",
    content = "params",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum AuthenticationRequest {
    ReadAccounts,
    Begin(BeginLoginRequest),
    Cancel(LoginId),
    Logout(AccountRef),
    PollCompletion(LoginId),
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "operation",
    content = "result",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum AuthenticationResponse {
    Accounts(Vec<AccountSnapshot>),
    Begun(BeginLogin),
    Cancelled(CancelLoginOutcome),
    LoggedOut,
    Completion(Option<CompleteLogin>),
}

/// Provider callbacks do not require a provider-owned login control plane.
/// The host owns revisions and client routing; the provider owns credentials.
pub trait AuthenticationEvents: Send + Sync {
    fn complete(&self, completion: CompleteLogin) -> Result<(), LoginError>;
    fn update_account(&self, account: AccountSnapshot) -> Result<(), LoginError>;
}

impl AuthenticationEvents for crate::LoginService {
    fn complete(&self, completion: CompleteLogin) -> Result<(), LoginError> {
        self.complete(completion)
    }
    fn update_account(&self, account: AccountSnapshot) -> Result<(), LoginError> {
        self.update_account(account).map(|_| ())
    }
}
