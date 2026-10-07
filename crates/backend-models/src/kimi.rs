//! Kimi Code account and usage HTTP contracts; used_ratio is a fraction.

use chrono::DateTime;
use chrono::FixedOffset;
use serde::Deserialize;

/// The account fields displayed by the official Kimi Code client.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct Account {
    pub user_id: String,
    pub nickname: Option<String>,
    pub email: Option<String>,
    pub user_level_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct QuotaWindow {
    pub used_ratio: f64,
    pub reset_time: Option<DateTime<FixedOffset>>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct QuotaWindows {
    pub limit_5h: Option<QuotaWindow>,
    pub limit_7d: Option<QuotaWindow>,
    pub limit_month_total: Option<QuotaWindow>,
    pub limit_month_code: Option<QuotaWindow>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Usage {
    pub usages: QuotaWindows,
}
