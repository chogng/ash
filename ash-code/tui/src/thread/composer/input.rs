mod attachments;
mod completion;
mod editor;
mod pending_pastes;
mod slash_commands;
mod state;
mod view;
mod vim;
mod wrap;

pub(crate) use ash_slash_commands::SlashCommandCatalog;
pub(crate) use completion::ChatInputCatalog;
pub(crate) use completion::CompletionView;
pub(crate) use completion::MentionPluginItem;
pub(crate) use completion::SkillCompletionItem;
pub(crate) use completion::draw as draw_completion;
pub(crate) use completion::index_at as completion_index_at;
pub(crate) use slash_commands::SlashCommandInvocation;
pub(crate) use slash_commands::TuiSlashCommandAction;
#[cfg(test)]
pub(crate) use slash_commands::built_in_catalog_command;
pub(crate) use slash_commands::built_in_slash_command_definitions;
#[cfg(test)]
pub(crate) use slash_commands::default_slash_command_catalog;
pub(crate) use state::ChatInput;
pub(crate) use state::ChatInputDraft;
pub(crate) use state::ChatInputItem;
pub(crate) use state::ChatInputOutcome;
pub(crate) use state::ChatInputQueueOutcome;
pub(crate) use state::ChatSubmission;
pub(crate) use state::QueuedChatInput;
pub(crate) use view::ChatInputChrome;
pub(crate) use view::ChatInputCursor;
pub(crate) use view::ChatInputFocus;
pub(crate) use view::content_area;
pub(crate) use view::draw as draw_chat_input;
pub(crate) use vim::ChatInputMode;

#[cfg(test)]
#[path = "input/completion_tests.rs"]
mod completion_tests;
