//! ChatGPT account and profile HTTP contracts.

use serde::Deserialize;
use std::collections::BTreeMap;

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
pub struct AccountsResponse {
    pub accounts: AccountCollection,
    #[serde(default)]
    pub account_ordering: Vec<String>,
    pub default_account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum AccountCollection {
    List(Vec<AccountEntry>),
    Map(BTreeMap<String, AccountEnvelope>),
}

#[derive(Deserialize)]
pub struct AccountEnvelope {
    pub account: AccountEntry,
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
