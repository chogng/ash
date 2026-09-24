//! Local Shell-versus-Agent input classification with pinned embedded assets.

mod classifier;
mod history;
mod model;
mod natural_language;
mod parser;
mod rules;
mod shell;

pub use ash_shell_completion::ShellAlias;
pub use ash_shell_completion::ShellAliasError;
pub use ash_shell_completion::ShellCompletion;
pub use ash_shell_completion::ShellCompletionKind;
pub use ash_shell_completion::ShellCompletionSnapshot;
pub use classifier::InputClassification;
pub use classifier::InputClassificationContext;
pub use classifier::InputClassificationSource;
pub use classifier::InputClassificationTask;
pub use classifier::InputClassifier;
pub use classifier::InputConversation;
pub use classifier::InputRoute;
pub use history::InputHistoryEntry;
pub use model::MODEL_SHA256;
pub use model::MODEL_VERSION;
pub use model::TOKENIZER_SHA256;
pub use model::start_background_warmup;

#[cfg(test)]
#[path = "input_classifier_tests.rs"]
mod tests;
