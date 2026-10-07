//! macOS Secure Enclave provider and platform bindings.

#[path = "platform_macos/error.rs"]
mod error;
#[path = "platform_macos/key_protection.rs"]
mod key_protection;
#[path = "platform_macos/provider.rs"]
mod provider;

pub(crate) use provider::AppleProvider;
pub(crate) use provider::device_supported;
