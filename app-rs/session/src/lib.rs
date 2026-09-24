//! App Server runtime, state, presentation, and interaction for Session.
//!
//! The runtime owns Session/Thread requests, subscriptions, and reconnects. The Pane owns the
//! backend-assembled transcript and one ChatWidget composed from the timeline and ChatInput
//! surfaces. Tabs, product effects, and other App Server capabilities remain outside this crate.

mod chat_input;
mod pane;
mod runtime;

pub(crate) use chat_input::ChatInput;
pub use chat_input::ChatInputInteractionItem;
pub use chat_input::ChatInputInteractionView;
pub use chat_input::ComposerClassificationResult;
pub use chat_input::ComposerClassificationTask;
pub use chat_input::ComposerClassificationUpdate;
pub use chat_input::ComposerInteractionActivation;
pub use chat_input::ComposerModelOption;
pub use chat_input::ComposerPanelLayout;
pub use chat_input::ComposerRoute;
pub use chat_input::ComposerSubmission;
pub use chat_input::INTERACTION_ROW_HEIGHT;
pub use chat_input::SelectionDirection;
pub use chat_input::composer_model_options;
pub use chat_input::interaction_content_size;
pub use chat_input::interaction_list_bounds;
pub use chat_input::interaction_preferred_height;
pub use chat_input::interaction_selection_scroll_command;
pub use pane::SessionCanvasLayout;
pub use pane::SessionHeader;
pub use pane::SessionHeaderStyle;
pub use pane::SessionPaneContext;
pub use pane::SessionPaneLayout;
pub use pane::SessionPaneState;
pub use pane::SessionPaneStyle;
pub use pane::SessionPaneView;
pub(crate) use pane::ThreadTimeline;
pub use pane::ThreadTimelineScroll;
pub(crate) use pane::ThreadTimelineStyle;
pub use pane::TimelineScrollDelta;
pub(crate) use pane::TranscriptState;
pub use pane::draw_session_pane;
pub use pane::interaction;
pub(crate) use pane::line_capacity;
pub(crate) use pane::line_count;
pub use runtime::CommandResult;
pub use runtime::EnvCwdSetResult;
pub(crate) use runtime::RECONNECT_WINDOW;
pub use runtime::SESSION_UNAVAILABLE_COMMAND_ERROR;
pub use runtime::SessionRuntime;
pub(crate) use runtime::SessionRuntimeCommand;
pub use runtime::SessionRuntimeEvent;
pub(crate) use runtime::SessionRuntimeEventSink;
pub use runtime::SessionRuntimeTarget;
pub(crate) use runtime::reconnect_delay_within_window;
pub(crate) use runtime::reject_disconnected_command;
