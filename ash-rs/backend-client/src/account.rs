use crate::BackendClient;
use crate::RequestError;
use async_utils::CancellationToken;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Accounts {
    pub accounts: Vec<AccountEntry>,
    pub account_ordering: Vec<String>,
    pub default_account_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct AccountEntry {
    #[serde(alias = "account_id")]
    pub id: String,
    pub plan_type: Option<String>,
    pub workspace_backend_origin: Option<String>,
    pub account_routing_override: Option<String>,
    pub name: Option<String>,
    pub profile_picture_url: Option<String>,
    pub structure: Option<String>,
}

#[derive(Deserialize)]
struct AccountsResponse {
    accounts: AccountCollection,
    #[serde(default)]
    account_ordering: Vec<String>,
    default_account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AccountCollection {
    List(Vec<AccountEntry>),
    Map(BTreeMap<String, AccountEnvelope>),
}

#[derive(Deserialize)]
struct AccountEnvelope {
    account: AccountEntry,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CreditNudge {
    Credits,
    UsageLimit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct AccountProfile {
    pub profile: Option<ProfileIdentity>,
    pub metadata: Option<ProfileMetadata>,
    pub stats: ProfileStats,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ProfileIdentity {
    pub display_name: Option<String>,
    pub username: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ProfileMetadata {
    pub stats_as_of: Option<String>,
    pub stats_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ProfileStats {
    pub lifetime_tokens: Option<i64>,
    pub peak_daily_tokens: Option<i64>,
    pub longest_running_turn_sec: Option<i64>,
    pub current_streak_days: Option<i64>,
    pub longest_streak_days: Option<i64>,
    pub daily_usage_buckets: Option<Vec<TokenUsageBucket>>,
    pub fast_mode_usage_percentage: Option<serde_json::Number>,
    pub most_used_reasoning_effort: Option<String>,
    pub most_used_reasoning_effort_percentage: Option<serde_json::Number>,
    pub unique_skills_used: Option<u64>,
    pub total_skills_used: Option<u64>,
    pub total_threads: Option<u64>,
    pub top_invocations: Option<Vec<ProfileInvocation>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct TokenUsageBucket {
    pub start_date: String,
    pub tokens: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ProfileInvocation {
    #[serde(rename = "type")]
    pub kind: String,
    pub plugin_name: Option<String>,
    pub skill_name: Option<String>,
    pub usage_count: Option<u64>,
}

impl BackendClient<'_> {
    /// Normalizes both account wire formats without dropping unordered workspace entries.
    pub fn read_accounts(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Accounts, RequestError> {
        let response: AccountsResponse =
            self.get(self.endpoint(&["accounts", "check"])?, &[], cancellation)?;
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
        self.get(self.endpoint(&["profiles", "me"])?, &[], cancellation)
    }

    /// Sends an administrator email only when the caller has authorized that action.
    pub fn send_credit_nudge(
        &self,
        credit_type: CreditNudge,
        cancellation: &CancellationToken,
    ) -> Result<(), RequestError> {
        #[derive(Serialize)]
        struct Nudge {
            credit_type: CreditNudge,
        }
        self.post_response(
            self.endpoint(&["accounts", "send_add_credits_nudge_email"])?,
            &Nudge { credit_type },
            cancellation,
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
