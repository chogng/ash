//! Shared, synchronous outbound HTTP transport for Ash crates.
//!
//! This crate owns transport configuration and one-attempt request execution.
//! API clients own protocol encoding, response decoding, and operation retry.

mod config;
mod error;
mod header;
mod outbound_network;
mod request;
mod telemetry;
mod ureq_client;

pub use config::{
    CertificateBundle, ClientIdentity, ClientIdentityPolicy, ConnectionPoolPolicy,
    HttpClientConfig, NetworkTargetPolicy, ProxyBypass, ProxyPolicy, RedirectPolicy,
    ResponseBodyLimit, Timeout, TlsPolicy, TransportTimeouts,
};
pub use error::HttpClientError;
pub use header::HttpHeader;
pub use outbound_network::{
    OutboundNetworkSnapshot, OutboundProxyRoute, OutboundProxyTarget, OutboundTlsStream,
};
pub use request::{HttpMethod, HttpRequest, HttpResponse};
pub use telemetry::{
    HttpClientTelemetry, HttpClientTelemetryEvent, HttpStatusClass, HttpTransportOutcome,
    TelemetryHttpClient,
};
pub use ureq_client::{HttpBodySink, HttpClient, UreqHttpClient};

#[cfg(test)]
#[path = "http_client_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "ureq_client_tests.rs"]
mod transport_tests;
