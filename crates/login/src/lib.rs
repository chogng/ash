//! Redacted interactive-account login lifecycle and provider-driver boundary.
//!
//! This crate never owns OAuth codecs, credential bytes, browser callbacks, or
//! secret persistence. Exact provider adapters retain those responsibilities.

mod driver;
mod error;
mod service;
mod types;

pub use driver::AccountMetadataRefresher;
pub use driver::AccountMultiplicity;
pub use driver::InteractiveLoginDriver;
pub use driver::LoginEvents;
pub use error::LoginError;
pub use error::LoginErrorKind;
pub use service::LoginService;
pub use types::AccountRef;
pub use types::AccountSnapshot;
pub use types::AccountState;
pub use types::AccountStatus;
pub use types::BeginLogin;
pub use types::BeginLoginRequest;
pub use types::CancelLoginOutcome;
pub use types::CompleteLogin;
pub use types::LoginCompletion;
pub use types::LoginCompletionOutcome;
pub use types::LoginFailure;
pub use types::LoginId;
pub use types::LoginMethod;
pub use types::LogoutOutcome;

#[cfg(test)]
#[path = "login_tests.rs"]
mod tests;

pub mod extension;
