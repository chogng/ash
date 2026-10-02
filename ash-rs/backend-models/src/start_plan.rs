//! ZCode Start Plan contracts. Billing times are Unix seconds and token units are absolute.

use serde::Deserialize;

#[derive(Deserialize)]
pub struct Response<T> {
    pub code: i64,
    pub data: T,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Balance {
    pub server_time: u64,
    pub plans: Vec<Plan>,
    pub balances: Vec<Bucket>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Plan {
    pub user_plan_id: String,
    pub name: String,
    pub status: String,
    pub starts_at: u64,
    pub ends_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Bucket {
    pub bucket_id: String,
    pub user_plan_id: String,
    pub show_name: String,
    pub capabilities: Vec<String>,
    pub total_units: u64,
    pub used_units: u64,
    pub available_units: u64,
    pub period_start: u64,
    pub period_end: u64,
    pub expires_at: u64,
}

#[derive(Deserialize)]
pub struct ClientConfigs {
    pub configs: Configs,
}

#[derive(Deserialize)]
pub struct Configs {
    pub captcha: Captcha,
}

#[derive(Deserialize)]
pub struct Captcha {
    pub enabled: bool,
    #[serde(default)]
    pub skip_model_request: bool,
}
