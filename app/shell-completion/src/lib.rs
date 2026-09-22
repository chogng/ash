//! Product-neutral Shell parsing, command signatures, token evidence, and completion candidates.
//!
//! This crate never executes input or decides whether it may run. Product adapters provide an
//! environment snapshot; consumers such as `ash-input-classifier` use the resulting structural
//! evidence without owning a second Shell parser or command catalog.

mod catalog;
mod completion;
mod dir;
mod engine;
mod environment;
mod parser;
mod registry;
mod types;

pub use completion::ShellCompletion;
pub use completion::ShellCompletionKind;
pub use completion::ShellCompletionSnapshot;
pub use engine::ShellCompletionEngine;
pub use registry::ShellArgumentSpec;
pub use registry::ShellChoice;
pub use registry::ShellCommandRegistry;
pub use registry::ShellCommandSpec;
pub use registry::ShellOptionSpec;
pub use registry::ShellValueHint;
pub use types::ShellAlias;
pub use types::ShellAliasError;
pub use types::ShellToken;
pub use types::ShellTokenDescription;
pub use types::ShellTokenKind;
pub use types::ShellTokenPosition;
pub use types::ShellTokenSnapshot;
