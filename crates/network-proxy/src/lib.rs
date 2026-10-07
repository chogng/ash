//! Network request authorization and execution-scoped HTTP/CONNECT and SOCKS5 proxies.
//!
//! The `server` feature isolates listeners and transport dependencies from consumers of the
//! authorization contract. The host supplies policy; platform sandboxes enforce proxy-only access.

mod environment;
mod policy;
pub use environment::ProxyEnvironment;

#[cfg(feature = "server")]
mod http;
#[cfg(feature = "server")]
mod server;
#[cfg(feature = "server")]
mod socks;

pub use policy::NetworkDecision;
pub use policy::NetworkDecisionFuture;
pub use policy::NetworkPolicy;
pub use policy::NetworkPolicyHandle;
pub use policy::NetworkProtocol;
pub use policy::NetworkRequest;

#[cfg(feature = "server")]
pub use server::NetworkProxy;

#[cfg(all(test, feature = "server"))]
#[path = "proxy_tests.rs"]
mod tests;
