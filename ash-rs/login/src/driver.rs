use crate::AccountRef;
use crate::AccountSnapshot;
use crate::AccountState;
use crate::BeginLogin;
use crate::BeginLoginRequest;
use crate::CancelLoginOutcome;
use crate::LoginCompletion;
use crate::LoginError;
use crate::LoginId;
use ash_async_utils::CancellationToken;

/// Whether a provider replaces its single account or retains independent account identities.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum AccountMultiplicity {
    Single,
    Multiple,
}

/// Executes provider-owned interactive login operations without exposing credentials.
///
/// Implementations keep provider credentials, OAuth protocol state, callbacks,
/// and persistence private. They may return only redacted account metadata and
/// user-facing browser or device-code instructions.
pub trait InteractiveLoginDriver: Send + Sync {
    /// Returns the stable provider identity owned by this driver.
    fn provider_id(&self) -> &'static str;

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError>;

    fn account_multiplicity(&self) -> AccountMultiplicity {
        AccountMultiplicity::Single
    }

    /// Returns the complete provider catalog; single-account drivers expose zero or one item.
    fn read_accounts(&self) -> Result<Vec<AccountSnapshot>, LoginError> {
        Ok(self.read_account()?.into_iter().collect())
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError>;

    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError>;

    fn logout(&self, account: &AccountRef) -> Result<(), LoginError>;
}

/// Refreshes remote display metadata for an existing provider account.
///
/// Implementations verify the exact account before publishing metadata to their
/// credential owner. LoginService then reads the redacted snapshot and applies
/// its normal revision checks; this port never returns credential material.
pub trait AccountMetadataRefresher: Send + Sync {
    fn provider_id(&self) -> &'static str;

    fn refresh_account(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), LoginError>;
}

/// Receives redacted login lifecycle events from [`crate::LoginService`].
///
/// Product hosts should convert these values to their own notification
/// protocol without adding credential or provider-transport details.
pub trait LoginEvents: Send + Sync {
    fn login_completed(&self, completion: LoginCompletion);

    fn account_updated(&self, state: AccountState);
}
