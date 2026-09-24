//! Host keybinding lifecycle independent of command execution.

mod catalog;
mod input;
mod runtime;
mod settings;

pub use catalog::KeybindingCatalog;
pub use input::recording_chord;
pub use runtime::CHORD_TIMEOUT;
pub use runtime::KeybindingResolution;
pub use runtime::Keybindings;
pub use runtime::UserBinding;
pub use runtime::UserBindingTarget;
pub use settings::KeybindingsConfigError;
pub use settings::binding_diagnostics;
pub use settings::compile_user_bindings;
pub use settings::edited_user_bindings;

#[cfg(test)]
#[path = "keybindings_tests.rs"]
mod tests;
