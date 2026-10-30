//! Private native-host credentials channel. These frames are never renderer JSON-RPC.

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Deserialize, JsonSchema, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(tag = "kind", rename_all = "camelCase")]
pub enum HostCredentialRequest {
    Authorize { request_id: String, context: String },
    Recover { request_id: String },
    Release { request_id: String },
}

#[derive(Deserialize, JsonSchema, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(tag = "kind", rename_all = "camelCase")]
pub enum HostCredentialResponse {
    Ready {
        #[ts(type = "1")]
        version: u32,
        context: String,
    },
    Changed {
        context: String,
    },
    Authorized {
        headers: BTreeMap<String, String>,
    },
    Recovered {
        headers: Option<BTreeMap<String, String>>,
    },
    Released,
    Failure {
        reason: HostCredentialFailure,
    },
}

#[derive(Clone, Copy, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum HostCredentialFailure {
    Unavailable,
    AccountChanged,
    InvalidRequest,
}
