//! Transport-neutral RPC messages and the current JSON-RPC 2.0 wire envelopes.
//!
//! The App Server's methods, results, and notifications live in [`crate::protocol`]. This module
//! deliberately knows nothing about those domain DTOs so a future Protobuf encoding can map the
//! same RPC semantics without changing the business protocol.

use crate::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

/// Generic JSON-RPC error returned by a client-hosted method implementation.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: serde_json::Value,
}

/// The only JSON-RPC version accepted by the current wire encoding.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

/// A JSON-RPC request identifier.
///
/// JSON-RPC authorizations string and number identifiers; `Null` is retained for parse and invalid
/// request error responses. The App Server dispatcher applies its narrower positive-integer
/// request-ID policy after decoding this wire representation.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Number(u64),
    String(String),
    Null(()),
}

impl JsonRpcId {
    /// Returns the identifier when it is represented by an unsigned JSON number.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(id) => Some(*id),
            Self::String(_) | Self::Null(()) => None,
        }
    }
}

/// A JSON-RPC request envelope.
///
/// `params` is generic so callers can bind it to a concrete protocol DTO. The App Server applies
/// its own request-ID policy at its dispatch boundary.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcRequest<P> {
    pub jsonrpc: JsonRpcVersion,
    pub id: JsonRpcId,
    pub method: String,
    pub params: P,
}

/// A JSON-RPC notification envelope, which intentionally has no request identifier.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcNotification<P> {
    pub jsonrpc: JsonRpcVersion,
    pub method: String,
    pub params: P,
}

/// A successful JSON-RPC response envelope.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcSuccess<R> {
    pub jsonrpc: JsonRpcVersion,
    pub id: JsonRpcId,
    pub result: R,
}

/// A failed JSON-RPC response envelope.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcFailure<E> {
    pub jsonrpc: JsonRpcVersion,
    pub id: JsonRpcId,
    pub error: E,
}

/// A JSON-RPC response, which contains exactly one success result or error object.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcResponse<R, E> {
    Success(JsonRpcSuccess<R>),
    Failure(JsonRpcFailure<E>),
}

impl<P> JsonRpcRequest<P> {
    /// Creates a JSON-RPC 2.0 request for a typed parameter payload.
    pub fn new(id: JsonRpcId, method: String, params: P) -> Self {
        Self {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method,
            params,
        }
    }
}

impl<P> JsonRpcNotification<P> {
    /// Creates a JSON-RPC 2.0 notification for a typed parameter payload.
    pub fn new(method: String, params: P) -> Self {
        Self {
            jsonrpc: JsonRpcVersion::V2,
            method,
            params,
        }
    }
}

impl<R> JsonRpcSuccess<R> {
    /// Creates a JSON-RPC 2.0 success response for a request identifier.
    pub fn new(id: JsonRpcId, result: R) -> Self {
        Self {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result,
        }
    }
}

impl<E> JsonRpcFailure<E> {
    /// Creates a JSON-RPC 2.0 error response for a request identifier.
    pub fn new(id: JsonRpcId, error: E) -> Self {
        Self {
            jsonrpc: JsonRpcVersion::V2,
            id,
            error,
        }
    }
}
