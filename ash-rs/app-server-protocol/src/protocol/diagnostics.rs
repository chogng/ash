use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackPrepareParams {
    pub endpoint: String,
}

/// Invoked only after the user reviews and authorizes the prepared content and destination.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackUploadParams {
    #[schemars(length(min = 1))]
    pub operation_id: String,
    #[schemars(length(min = 64, max = 64))]
    pub digest: String,
}

/// A configured service dependency. Paths, query strings and credentials never leave the server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkTargetDto {
    pub id: String,
    pub connection: String,
    pub display_name: String,
    pub host: String,
    pub port: u16,
    pub purpose: NetworkPurposeDto,
    pub route: NetworkRouteDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NetworkPurposeDto {
    Model,
    SignIn,
    Usage,
    Service,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum NetworkRouteDto {
    Direct,
    Proxy { host: String, port: u16 },
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkReadResult {
    pub targets: Vec<NetworkTargetDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NetworkFailureDto {
    Dns,
    Proxy,
    Tls,
    CertificateConfiguration,
    Connect,
    Timeout,
    Policy,
    Configuration,
    Request,
    Authentication,
    AccountChanged,
    AccountOperation,
}

/// HTTP reachability and authenticated account results are separate evidence.
/// An HTTP response (including 401/404) proves reachability, not account eligibility.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum NetworkCheckOutcomeDto {
    Reachable {
        #[serde(rename = "httpStatus")]
        http_status: u16,
    },
    AccountAvailable,
    Failed {
        failure: NetworkFailureDto,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkCheckDto {
    pub connection: String,
    pub target_id: Option<String>,
    pub outcome: NetworkCheckOutcomeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkDiagnosticsRunResult {
    pub network: NetworkReadResult,
    pub checks: Vec<NetworkCheckDto>,
}
