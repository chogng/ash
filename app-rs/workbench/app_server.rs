//! App's application boundary to the shared ash-rs App Server client.
//!
//! `ash-app-server-client` owns the reusable App Server session, request, event, and shutdown
//! contract. This module owns the app-specific choice of Local or Remote backend and exposes a
//! stable crate-local surface to Agent, Language, and Terminal adapters. UI crates must remain
//! above this boundary and must not depend on the App Server client directly.

#[path = "app_server/host.rs"]
mod host;

pub(crate) use host::AppServerHost;
#[cfg(test)]
pub(crate) use host::local_app_server_command;

pub(crate) use ash_app_server_client::AppServerRequestHandle;
pub(crate) use ash_app_server_client::ClientError;
pub(crate) use ash_app_server_client::ServerNotification;

#[cfg(test)]
pub(crate) mod testing {
    pub(crate) use ash_app_server_client::AppServerClient;
    pub(crate) use ash_app_server_client::InProcessClientOptions;
    pub(crate) use ash_app_server_client::InProcessTransport;
    pub(crate) use ash_app_server_client::start_in_process_client;
}

#[cfg(test)]
#[path = "app_server/tests.rs"]
mod tests;
