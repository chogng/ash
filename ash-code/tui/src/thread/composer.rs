mod catalog;
pub(crate) mod file_search;
mod input;
mod steer;
mod submission;
mod surface;

pub(crate) use catalog::chat_input_catalog_snapshot;
pub(crate) use catalog::slash_command_registry;
pub(crate) use input::ChatInput;
pub(crate) use input::ChatInputCatalog;
pub(crate) use input::ChatInputChrome;
pub(crate) use input::ChatInputCursor;
pub(crate) use input::ChatInputDraft;
pub(crate) use input::ChatInputFocus;
pub(crate) use input::ChatInputItem;
pub(crate) use input::ChatInputMode;
pub(crate) use input::ChatInputOutcome;
pub(crate) use input::ChatInputQueueOutcome;
pub(crate) use input::ChatSubmission;
pub(crate) use input::CompletionView;
pub(crate) use input::MentionPluginItem;
pub(crate) use input::QueuedChatInput;
pub(crate) use input::SkillCompletionItem;
pub(crate) use input::SlashCommandCatalog;
pub(crate) use input::SlashCommandInvocation;
pub(crate) use input::TuiSlashCommandAction;
#[cfg(test)]
pub(crate) use input::built_in_catalog_command;
pub(crate) use input::built_in_slash_command_definitions;
pub(crate) use input::completion_index_at;
pub(crate) use input::content_area;
pub(crate) use input::draw_chat_input;
pub(crate) use input::draw_completion;
pub(crate) use steer::Steer;
pub(crate) use steer::SteerId;
pub(crate) use submission::ChatComposer;
pub(crate) use submission::ChatComposerOutcome;
pub(crate) use submission::ChatComposerView;
pub(crate) use surface::ChatComposerPointerTarget;
pub(crate) use surface::ChatComposerSurface;
pub(crate) use surface::completion_contains;
pub(crate) use surface::draw_completion_layer;
pub(crate) use surface::pointer_target_at;

/// Identifies the logical draft that requested an asynchronous attachment read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftTarget {
    NewSession {
        generation: u64,
    },
    Thread {
        thread_id: ash_protocol::ThreadId,
        generation: u64,
    },
}
