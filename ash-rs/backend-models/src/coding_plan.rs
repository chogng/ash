//! Shared BigModel and Z.AI Coding Plan HTTP contracts. Reset times are milliseconds.

use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaLimit {
    #[serde(rename = "type")]
    pub kind: String,
    pub percentage: Option<f64>,
    pub unit: Option<u32>,
    pub number: Option<u32>,
    pub next_reset_time: Option<u64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum ResponseCode {
    Number(i64),
    Text(String),
}

/// The business status is independent of the HTTP status and checked by the client.
#[derive(Deserialize)]
pub struct BusinessResponse<T> {
    pub code: Option<ResponseCode>,
    pub data: T,
}

#[derive(Deserialize)]
pub struct Quota {
    pub limits: Vec<QuotaLimit>,
}

#[derive(Deserialize)]
pub struct Customer {
    pub organizations: Vec<Organization>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub organization_id: String,
    pub organization_name: Option<String>,
    pub projects: Vec<Project>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub project_id: String,
    pub project_name: Option<String>,
}

// Credential payloads deliberately omit Debug to prevent accidental secret logging.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub name: Option<String>,
    pub api_key: String,
}

#[derive(Serialize)]
pub struct CreateApiKeyRequest<'a> {
    pub name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeySecret {
    pub secret_key: Option<String>,
}
