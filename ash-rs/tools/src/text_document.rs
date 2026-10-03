use ash_file_system::TextDocumentEditor;
use ash_file_system::TextDocumentError;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::sync::Arc;

/// Selects the document source bound to the initiating Turn. `None` selects an explicit
/// filesystem environment; a lost editor binding is an error and cannot select disk.
pub trait TextDocumentEditorProvider: Send + Sync {
    fn for_turn(
        &self,
        thread: &ThreadId,
        turn: &TurnId,
    ) -> Result<Option<Arc<dyn TextDocumentEditor>>, TextDocumentError>;
}
