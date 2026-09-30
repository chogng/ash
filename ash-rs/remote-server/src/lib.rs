//! Headless Remote App Server runtime.
//!
//! This package runs on the target host after a client product installs or selects it. It owns no
//! SSH client: the connecting host owns SSH; this runtime connects to the remote profile's
//! independently packaged App Server process.

mod server;

pub use server::RemoteServerError;
pub use server::RemoteServerOptions;
pub use server::run_from_environment;
pub use server::run_from_environment_with_product_services;
pub use server::serve_stdio;

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
