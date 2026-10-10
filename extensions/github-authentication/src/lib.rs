//! Product GitHub authentication provider, hosted in an independent Rust process.

mod auth;
mod runtime;
mod services;

pub use auth::GitHubOAuth;
pub use runtime::GitHubAuthenticationExtension;
