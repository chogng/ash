//! Authenticated HTTP host for durable Document Engine collaboration rooms.
//!
//! The host owns HTTP authentication, origin policy, long-poll delivery and
//! SQLite lifecycle. Ordered room semantics remain in `ash-collaboration`.
//! It intentionally has no App Server, directory, tool, or session authority.

mod http;
mod options;

pub use options::CollaborationServerOptions;

use std::fmt;

/// Runs the durable remote collaboration listener until the process exits.
pub fn run(options: CollaborationServerOptions) -> Result<(), CollaborationServerError> {
    options
        .validate()
        .map_err(CollaborationServerError::configuration)?;
    http::serve(options)
}

/// Failure while configuring or running the collaboration host.
#[derive(Debug)]
pub struct CollaborationServerError(String);

impl CollaborationServerError {
    pub(crate) fn configuration(message: String) -> Self {
        Self(message)
    }

    pub(crate) fn http(error: std::io::Error) -> Self {
        Self(format!("HTTP server error: {error}"))
    }

    pub(crate) fn storage(message: String) -> Self {
        Self(message)
    }
}

impl fmt::Display for CollaborationServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for CollaborationServerError {}
