use lsp_types::{TextDocumentContentChangeEvent, TextDocumentSyncCapability, TextDocumentSyncKind};

use crate::LanguageServerError;

/// Monotonic version assigned to one open text document.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct DocumentVersion(i32);

impl DocumentVersion {
    pub const INITIAL: Self = Self(1);

    pub const fn value(self) -> i32 {
        self.0
    }

    pub(crate) fn next(self) -> Result<Self, LanguageServerError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(LanguageServerError::DocumentVersionOverflow)
    }
}

/// Change representation selected for one `textDocument/didChange` notification.
#[derive(Clone, Debug)]
pub enum DocumentChange {
    Full(String),
    Incremental(Vec<TextDocumentContentChangeEvent>),
}

/// Saved-text payload selected by a caller.
#[derive(Clone, Copy, Debug)]
pub enum DocumentSave<'a> {
    WithoutText,
    WithText(&'a str),
}

/// Change synchronization negotiated with a language server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentChangeSync {
    None,
    Full,
    Incremental,
}

/// Save synchronization negotiated with a language server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentSaveSync {
    None,
    WithoutText,
    IncludeText,
}

/// Immutable document synchronization contract derived from server capabilities.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentSyncPolicy {
    pub open_close: bool,
    pub change: DocumentChangeSync,
    pub save: DocumentSaveSync,
}

impl Default for DocumentSyncPolicy {
    fn default() -> Self {
        Self {
            open_close: false,
            change: DocumentChangeSync::None,
            save: DocumentSaveSync::None,
        }
    }
}

impl DocumentSyncPolicy {
    pub(crate) fn from_capability(capability: Option<&TextDocumentSyncCapability>) -> Self {
        match capability {
            None => Self::default(),
            Some(TextDocumentSyncCapability::Kind(kind)) => Self {
                open_close: *kind != TextDocumentSyncKind::NONE,
                change: change_sync(*kind),
                save: DocumentSaveSync::None,
            },
            Some(TextDocumentSyncCapability::Options(options)) => {
                let save = match options.save.as_ref() {
                    None => DocumentSaveSync::None,
                    Some(lsp_types::TextDocumentSyncSaveOptions::Supported(false)) => {
                        DocumentSaveSync::None
                    }
                    Some(lsp_types::TextDocumentSyncSaveOptions::Supported(true)) => {
                        DocumentSaveSync::WithoutText
                    }
                    Some(lsp_types::TextDocumentSyncSaveOptions::SaveOptions(options)) => {
                        if options.include_text == Some(true) {
                            DocumentSaveSync::IncludeText
                        } else {
                            DocumentSaveSync::WithoutText
                        }
                    }
                };
                Self {
                    open_close: options.open_close.unwrap_or(false),
                    change: options
                        .change
                        .map(change_sync)
                        .unwrap_or(DocumentChangeSync::None),
                    save,
                }
            }
        }
    }
}

fn change_sync(kind: TextDocumentSyncKind) -> DocumentChangeSync {
    if kind == TextDocumentSyncKind::FULL {
        DocumentChangeSync::Full
    } else if kind == TextDocumentSyncKind::INCREMENTAL {
        DocumentChangeSync::Incremental
    } else {
        DocumentChangeSync::None
    }
}

#[derive(Debug)]
pub(crate) struct OpenDocument {
    pub(crate) version: DocumentVersion,
}
