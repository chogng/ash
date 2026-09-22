use crate::XaiError;
use crate::XaiErrorKind;
use crate::XaiOAuth;
use ash_async_utils::CancellationToken;
use backend_client::RequestError;
use backend_client::xai::Account;
use backend_client::xai::Billing;
use backend_client::xai::CatalogModel;
use backend_client::xai::Client;
use backend_client::xai::Settings;
use std::sync::atomic::Ordering;

/// Account-scoped subscription data; no credentials or model-generation state.
#[derive(Clone, Debug, PartialEq)]
pub struct Subscription {
    pub account: Account,
    pub settings: Settings,
    pub billing: Option<Billing>,
}

impl XaiOAuth {
    pub fn models(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<CatalogModel>, XaiError> {
        self.read_backend(account_id, cancellation, |client| {
            client.read_models(cancellation)
        })
    }

    /// Refreshes display metadata without replacing the local login identity or rotated tokens.
    pub fn refresh_account(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Account, XaiError> {
        let generation = {
            let _lock = self.lock_credentials()?;
            self.check_account(account_id, cancellation)?;
            self.account_reads.fetch_add(1, Ordering::Relaxed) + 1
        };
        let account = self.read_backend(account_id, cancellation, |client| {
            client.read_account(cancellation)
        })?;
        let _lock = self.lock_credentials()?;
        check_cancelled(cancellation)?;
        let mut credential = self.load_credential()?.ok_or_else(account_changed)?;
        if self.account_reads.load(Ordering::Relaxed) != generation
            || credential.account_id != account_id
            || credential.profile.as_ref().is_some_and(|previous| {
                previous.user_id != account.user_id
                    || previous.principal_id != account.principal_id
                    || previous.team_id != account.team_id
            })
        {
            return Err(account_changed());
        }
        credential.profile = Some(account.clone());
        self.store_credential(&credential)?;
        self.publish_account_update(&credential);
        Ok(account)
    }

    pub fn read_subscription(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Subscription, XaiError> {
        let account = self.refresh_account(account_id, cancellation)?;
        let settings = self.read_backend(account_id, cancellation, |client| {
            client.read_settings(cancellation)
        })?;
        let billing = self.read_backend(account_id, cancellation, |client| {
            client.read_billing(cancellation)
        })?;
        self.check_account(account_id, cancellation)?;
        Ok(Subscription {
            account,
            settings,
            billing,
        })
    }

    fn check_account(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), XaiError> {
        check_cancelled(cancellation)?;
        if account_id.trim().is_empty() || self.account_id()?.as_deref() != Some(account_id) {
            return Err(account_changed());
        }
        Ok(())
    }

    fn read_backend<T>(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
        read: impl Fn(&Client<'_>) -> Result<T, RequestError>,
    ) -> Result<T, XaiError> {
        self.check_account(account_id, cancellation)?;
        let target = self.api_target()?;
        self.check_account(account_id, cancellation)?;
        if target.account_id != account_id {
            return Err(account_changed());
        }
        let result =
            read(&Client::new(self.client.as_ref(), &target.target).map_err(backend_error)?);
        self.check_account(account_id, cancellation)?;
        let result = match result {
            Err(RequestError::HttpStatus(401)) => {
                let renewed = self.recover_unauthorized(&target)?;
                self.check_account(account_id, cancellation)?;
                let Some(renewed) = renewed else {
                    self.note_rejected(&target);
                    return Err(backend_error(RequestError::HttpStatus(401)));
                };
                let result = read(
                    &Client::new(self.client.as_ref(), &renewed.target).map_err(backend_error)?,
                );
                self.check_account(account_id, cancellation)?;
                if matches!(result, Err(RequestError::HttpStatus(401))) {
                    self.note_rejected(&renewed);
                }
                result
            }
            result => result,
        };
        result.map_err(backend_error)
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), XaiError> {
    if cancellation.is_cancelled() {
        Err(backend_error(RequestError::Cancelled))
    } else {
        Ok(())
    }
}

fn account_changed() -> XaiError {
    XaiError::with_kind(
        XaiErrorKind::AccountChanged,
        "xAI account changed; retry with the current account",
    )
}

fn backend_error(error: RequestError) -> XaiError {
    let (kind, message) = match error {
        RequestError::Cancelled => (XaiErrorKind::Cancelled, "xAI request cancelled".into()),
        RequestError::HttpStatus(401) => (
            XaiErrorKind::Authentication,
            "xAI sign-in has expired; sign in again".into(),
        ),
        RequestError::HttpStatus(403) => (
            XaiErrorKind::Permission,
            "xAI subscription does not allow this request".into(),
        ),
        RequestError::HttpStatus(426) => (
            XaiErrorKind::UpgradeRequired,
            "xAI requires a newer Ash client".into(),
        ),
        RequestError::HttpStatus(429) => (
            XaiErrorKind::RateLimited,
            "xAI request rate limit reached".into(),
        ),
        RequestError::InvalidResponse => (
            XaiErrorKind::InvalidResponse,
            "xAI returned invalid account data".into(),
        ),
        error => (XaiErrorKind::Unavailable, error.to_string()),
    };
    XaiError::with_kind(kind, message)
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
