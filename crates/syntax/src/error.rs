use thiserror::Error;

use crate::{DocumentRevision, SyntaxLanguage};

/// Failure produced while opening or incrementally updating a syntax document.
#[derive(Debug, Error)]
pub enum SyntaxError {
    #[error("failed to load the {language:?} tree-sitter grammar: {source}")]
    Language {
        language: SyntaxLanguage,
        #[source]
        source: tree_sitter::LanguageError,
    },
    #[error("failed to compile the {query_name} query for {language:?}: {source}")]
    Query {
        language: SyntaxLanguage,
        query_name: &'static str,
        #[source]
        source: tree_sitter::QueryError,
    },
    #[error("tree-sitter cancelled parsing the document")]
    ParseCancelled,
    #[error(
        "document revision must increase monotonically: current {current:?}, requested {requested:?}"
    )]
    NonIncreasingRevision {
        current: DocumentRevision,
        requested: DocumentRevision,
    },
    #[error("edit range {start}..{end} is invalid for a {document_len}-byte document")]
    InvalidEditRange {
        start: usize,
        end: usize,
        document_len: usize,
    },
    #[error("edit offset {offset} is not a UTF-8 character boundary")]
    InvalidEditBoundary { offset: usize },
    #[error("selection range {start}..{end} is invalid for a {document_len}-byte document")]
    InvalidSelectionRange {
        start: usize,
        end: usize,
        document_len: usize,
    },
    #[error("selection offset {offset} is not a UTF-8 character boundary")]
    InvalidSelectionBoundary { offset: usize },
    #[error("syntax edit ranges overlap or share an ambiguous insertion point")]
    OverlappingEdits,
    #[error("document contains {actual} bytes, exceeding the {limit}-byte analysis limit")]
    DocumentTooLarge { actual: usize, limit: usize },
}
