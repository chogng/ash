//! Embedded V8 execution for Ash Code Mode.
//!
//! The runtime owns only JavaScript state. Tool execution crosses the [`ToolInvoker`] boundary,
//! so JavaScript never receives filesystem, network, or process handles. Core can implement the
//! boundary with its ordinary approval and durable nested-call broker.

mod callbacks;
mod globals;
mod output;
mod session;
mod v8_init;
mod value;

pub use output::limit_output;
pub use session::{CodeModeRuntime, CodeModeStore, RuntimeError, ToolInvoker};
pub use v8_init::{V8JitMode, initialize_v8};

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
