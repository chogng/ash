pub(crate) mod batch;
mod exec_cell;
mod history_cell;
mod markdown;
mod model;
mod streaming;
pub(crate) use streaming::StreamDisplay;
mod view;

pub(crate) use history_cell::CellView;
pub(crate) use history_cell::ChatHistoryRenderCache;
pub(crate) use history_cell::CommandStatus;
pub(crate) use history_cell::LocalCommandCompletion;
pub(crate) use history_cell::MessageRole;
pub(crate) use markdown::export_markdown;
pub(crate) use model::TranscriptCell;
pub(crate) use model::TranscriptCellId;
pub(crate) use model::TranscriptModel;
pub(crate) use view::ChatHistoryPointerState;
pub(crate) use view::ChatHistoryPointerTarget;
pub(crate) use view::ChatHistoryScroll;
pub(crate) use view::ChatHistoryView;
pub(crate) use view::TranscriptScrollAnchor;
pub(crate) use view::TranscriptScrollDirection;
pub(crate) use view::TranscriptScrollTarget;
pub(crate) use view::first_scroll_target;
pub(crate) use view::scroll_target;

pub(crate) mod viewport;
