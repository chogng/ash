//! Product-neutral shortcut values, parsing, conditions, and rule resolution.

mod binding;
mod context;
mod key;
mod parser;
mod resolver;
mod user;

pub use binding::BindingPriority;
pub use binding::BindingSet;
pub use binding::BindingSource;
pub use context::ContextExpression;
pub use context::ContextExpressionError;
pub use context::ContextValue;
pub use key::Chord;
pub use key::HostPlatform;
pub use key::KeyIdentity;
pub use key::KeySequence;
pub use key::KeySequenceError;
pub use key::KeyStroke;
pub use key::LogicalKey;
pub use key::MAX_CHORDS;
pub use key::Modifiers;
pub use key::PhysicalKey;
pub use key::ShortcutModifiers;
pub use parser::KeybindingParseError;
pub use parser::format_key_sequence;
pub use parser::keycap_labels;
pub use parser::parse_key_sequence;
pub use parser::serialize_key_sequence;
pub use resolver::KeybindingResolver;
pub use resolver::ResolveResult;
pub use user::MAX_USER_BINDINGS;
pub use user::UserBinding;
pub use user::UserBindingTarget;
pub use user::UserBindingsError;
pub use user::compile_user_bindings;
pub use user::user_binding_diagnostics;

#[cfg(test)]
#[path = "keybinding_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "conformance_tests.rs"]
mod conformance_tests;
