use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use serde::Deserialize;
use serde::Serialize;

/// Account metadata from `/user?include=subscription`, including live subscription state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub user_id: String,
    pub email: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub profile_image_asset_id: Option<String>,
    pub principal_type: Option<String>,
    pub principal_id: Option<String>,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub team_role: Option<String>,
    pub organization_id: Option<String>,
    pub organization_name: Option<String>,
    pub organization_role: Option<String>,
    pub user_blocked_reason: Option<String>,
    pub team_blocked_reasons: Option<Vec<String>>,
    pub coding_data_retention_opt_out: Option<bool>,
    pub subscription_tier: Option<String>,
}

/// Account access and billing settings, without Grok application feature switches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct Settings {
    pub subscription_tier: Option<String>,
    pub subscription_tier_display: Option<String>,
    pub allow_access: Option<bool>,
    pub gate_message: Option<String>,
    pub on_demand_enabled: Option<bool>,
}

impl Client<'_> {
    pub fn read_account(&self, cancellation: &CancellationToken) -> Result<Account, RequestError> {
        let mut url = self.http.endpoint(["user"])?;
        url.query_pairs_mut().append_pair("include", "subscription");
        let account: Account = self.http.get(
            url,
            &[
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Cache-Control", "no-store"),
            ],
            cancellation,
        )?;
        if account.user_id.trim().is_empty() {
            return Err(RequestError::InvalidResponse);
        }
        Ok(account)
    }

    pub fn read_settings(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Settings, RequestError> {
        self.http.get(
            self.http.endpoint(["settings"])?,
            &[
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Cache-Control", "no-store"),
            ],
            cancellation,
        )
    }
}
