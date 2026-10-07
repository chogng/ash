//! Backend-neutral Debug Adapter Protocol process and framing runtime.
//!
//! This crate owns trusted stdio adapter launch, DAP `Content-Length` framing, bounded output,
//! connection-independent session identity, and process cleanup. Product hosts own launch
//! configuration, breakpoint semantics, UI state, and connection authorization.

mod framing;
mod service;

pub use service::DebugAdapterCommand;
pub use service::DebugAdapterError;
pub use service::DebugAdapterMessage;
pub use service::DebugAdapterRead;
pub use service::DebugAdapterService;
pub use service::DebugAdapterSessionId;

#[cfg(test)]
#[path = "framing_tests.rs"]
mod tests;
