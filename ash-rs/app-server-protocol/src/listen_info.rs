use std::error::Error;
use std::fmt;
use std::net::SocketAddr;

use crate::JsonSchema;
use crate::TS;
#[cfg(any(test, feature = "export"))]
use schemars::Schema;
#[cfg(any(test, feature = "export"))]
use schemars::SchemaGenerator;
use serde::Deserialize;
use serde::Serialize;
use url::Url;

const LISTEN_INFO_KIND: &str = "app-server-listen-info";
const LISTEN_INFO_VERSION: u32 = 1;

/// Machine-readable startup record emitted after an App Server listener is ready.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AppServerListenInfo {
    #[schemars(schema_with = "listen_info_kind_schema")]
    #[ts(type = "\"app-server-listen-info\"")]
    kind: String,
    #[schemars(schema_with = "listen_info_version_schema")]
    #[ts(type = "1")]
    version: u32,
    endpoint: String,
}

#[cfg(any(test, feature = "export"))]
fn listen_info_kind_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({
        "type": "string",
        "const": LISTEN_INFO_KIND,
    })
}

#[cfg(any(test, feature = "export"))]
fn listen_info_version_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({
        "type": "integer",
        "const": LISTEN_INFO_VERSION,
    })
}

impl AppServerListenInfo {
    /// Creates a startup record for a bound loopback WebSocket listener.
    pub fn loopback_websocket(address: SocketAddr) -> Result<Self, AppServerListenInfoError> {
        if !address.ip().is_loopback() {
            return Err(AppServerListenInfoError::NonLoopbackEndpoint);
        }
        let listen_info = Self {
            kind: LISTEN_INFO_KIND.into(),
            version: LISTEN_INFO_VERSION,
            endpoint: format!("ws://{address}"),
        };
        listen_info.validate()?;
        Ok(listen_info)
    }

    /// Returns the validated WebSocket endpoint.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Validates a decoded startup record before a process host consumes it.
    pub fn validate(&self) -> Result<(), AppServerListenInfoError> {
        if self.kind != LISTEN_INFO_KIND {
            return Err(AppServerListenInfoError::UnknownKind);
        }
        if self.version != LISTEN_INFO_VERSION {
            return Err(AppServerListenInfoError::UnknownVersion);
        }
        let endpoint =
            Url::parse(&self.endpoint).map_err(|_| AppServerListenInfoError::InvalidEndpoint)?;
        if endpoint.scheme() != "ws"
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.username() != ""
            || endpoint.password().is_some()
        {
            return Err(AppServerListenInfoError::InvalidEndpoint);
        }
        let host = endpoint
            .host_str()
            .ok_or(AppServerListenInfoError::InvalidEndpoint)?;
        let address = host
            .parse::<std::net::IpAddr>()
            .map_err(|_| AppServerListenInfoError::InvalidEndpoint)?;
        if !address.is_loopback() {
            return Err(AppServerListenInfoError::NonLoopbackEndpoint);
        }
        endpoint
            .port()
            .filter(|port| *port != 0)
            .ok_or(AppServerListenInfoError::InvalidEndpoint)?;
        Ok(())
    }
}

/// A stable validation failure for an App Server startup record.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppServerListenInfoError {
    UnknownKind,
    UnknownVersion,
    InvalidEndpoint,
    NonLoopbackEndpoint,
}

impl fmt::Display for AppServerListenInfoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnknownKind => "unknown App Server listen-info kind",
            Self::UnknownVersion => "unsupported App Server listen-info version",
            Self::InvalidEndpoint => "invalid App Server listen-info endpoint",
            Self::NonLoopbackEndpoint => "App Server listen-info endpoint is not loopback",
        })
    }
}

impl Error for AppServerListenInfoError {}

#[cfg(test)]
#[path = "listen_info_tests.rs"]
mod tests;
