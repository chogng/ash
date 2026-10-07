use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::chatgpt::AccountCollection;
use backend_models::chatgpt::AccountEntry;
use backend_models::chatgpt::AccountProfile;
use backend_models::chatgpt::AccountsResponse;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Accounts {
    pub accounts: Vec<AccountEntry>,
    pub account_ordering: Vec<String>,
    pub default_account_id: Option<String>,
}

impl Client<'_> {
    /// Normalizes both account wire formats without dropping unordered workspace entries.
    pub fn read_accounts(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Accounts, RequestError> {
        let response: AccountsResponse =
            self.http
                .get(self.endpoint(&["accounts", "check"])?, &[], cancellation)?;
        let mut accounts = match response.accounts {
            AccountCollection::List(accounts) => accounts,
            AccountCollection::Map(accounts) => accounts
                .into_iter()
                .map(|(id, entry)| {
                    if id != entry.account.id {
                        return Err(RequestError::InvalidResponse);
                    }
                    Ok(entry.account)
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        let mut seen = std::collections::HashSet::new();
        if accounts
            .iter()
            .any(|account| account.id.trim().is_empty() || !seen.insert(&account.id))
        {
            return Err(RequestError::InvalidResponse);
        }
        accounts.sort_by_key(|account| {
            response
                .account_ordering
                .iter()
                .position(|id| *id == account.id)
                .unwrap_or(usize::MAX)
        });
        Ok(Accounts {
            accounts,
            account_ordering: response.account_ordering,
            default_account_id: response.default_account_id,
        })
    }

    /// Includes both token history and the broader profile statistics from profiles/me.
    pub fn read_account_profile(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<AccountProfile, RequestError> {
        self.http
            .get(self.endpoint(&["profiles", "me"])?, &[], cancellation)
    }
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
