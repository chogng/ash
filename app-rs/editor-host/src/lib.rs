//! Editor host state and auxiliary presentation.
//!
//! This crate owns editor-specific retained UI state and result presentation. File I/O,
//! save-conflict policy, Tab lifetime, App Server requests, and host event routing remain
//! in the app composition layer.

mod auto_scroll;
mod diagnostics;
mod file_host;
mod input_state;
mod interaction;
mod language_features;
mod language_service;
mod pane;
mod search;
mod style;

pub use auto_scroll::{FileEditorAutoScrollDirection, FileEditorAutoScrollState};
pub use diagnostics::FileEditorDiagnosticTooltip;
pub use file_host::{FileEditorCloseRequest, FileEditorHost, FileEditorTab};
pub use input_state::{FileEditorInputState, FileEditorWheelDelta};
pub use interaction::{
    FILE_EDITOR_DOCUMENT, FILE_EDITOR_FIND_INPUT, FILE_EDITOR_NOTICE, FILE_EDITOR_PANE,
    FILE_EDITOR_REPLACE_INPUT, FILE_EDITOR_SEARCH_BAR, FILE_EDITOR_TABS, FileEditorAction,
    file_editor_close_id, file_editor_close_index, file_editor_fold_id, file_editor_fold_index,
    file_editor_tab_id, file_editor_tab_index,
};
pub use language_features::{LanguageCompletionPopover, LanguageHoverPopover};
pub use language_service::{
    FileEditorLanguageEvent, FileEditorLanguageEventSink, FileEditorLanguageService,
    RemoteLanguageSessionTarget,
};
pub use pane::{FileEditorPane, FileEditorPrompt};
pub use search::{FileEditorSearchMode, FileEditorSearchState};
pub use style::EditorOverlayStyle;
