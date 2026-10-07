//! Declarative Hook matching, policy binding, and sandboxed process execution.

mod error;
mod matcher;
mod outcome;
mod policy;
mod process;
mod protocol;
mod records;
mod runtime;

pub use records::HookRunEvent;
pub use records::HookRunRecord;
pub use records::HookRunStatus;
pub use runtime::DeclarativeHookRuntime;
pub use runtime::HookDirBindingError;
