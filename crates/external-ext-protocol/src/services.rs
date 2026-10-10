//! Profile-scoped services granted by a product host, independent of editor windows.

use serde::Deserialize;
use serde::Serialize;

/// Closed service calls; the host binds namespace and network authority at activation.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(
    tag = "service",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoreServiceRequest {
    SecretLoad {
        key: String,
    },
    SecretStore {
        key: String,
        value: Vec<u8>,
    },
    SecretDelete {
        key: String,
    },
    HttpExecute {
        method: CoreHttpMethod,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
}

/// Methods permitted by the shared unary HTTP transport.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CoreHttpMethod {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

/// Core service replies stay on private runtime pipes, never on renderer RPC.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(
    tag = "service",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoreServiceResponse {
    SecretLoaded {
        value: Option<Vec<u8>>,
    },
    SecretStored,
    SecretDeleted {
        deleted: bool,
    },
    HttpExecuted {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
}

// Requests and replies can contain credentials. Envelope diagnostics may format them,
// but must never expose headers, bodies or stored values.
impl std::fmt::Debug for CoreServiceRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CoreServiceRequest([REDACTED])")
    }
}
impl std::fmt::Debug for CoreServiceResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CoreServiceResponse([REDACTED])")
    }
}
