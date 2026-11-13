use serde::Serialize;
use std::fmt;

/// Stable, serializable boundary errors shared by native and WASM hosts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Error {
    SourceTooLarge { bytes: usize, limit: usize },
    InvalidByteOffset { offset: usize },
    InvalidUtf16Offset { offset: u32 },
    ReversedRange { start: u32, end: u32 },
    RevisionMismatch { expected: u32, actual: u32 },
    RevisionExhausted,
    OverlappingEdits,
    TooManyEdits { count: usize, limit: usize },
    ParseLimit { limit: String },
    InvalidRequest { message: String },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceTooLarge { bytes, limit } => {
                write!(f, "Source has {bytes} bytes; limit is {limit}")
            }
            Self::InvalidByteOffset { offset } => {
                write!(f, "Offset {offset} is not a UTF-8 character boundary")
            }
            Self::InvalidUtf16Offset { offset } => write!(
                f,
                "Offset {offset} is outside the source or splits a UTF-16 surrogate pair"
            ),
            Self::ReversedRange { start, end } => {
                write!(f, "Range starts at {start} after its end {end}")
            }
            Self::RevisionMismatch { expected, actual } => write!(
                f,
                "Expected revision {expected}; current revision is {actual}"
            ),
            Self::RevisionExhausted => f.write_str("Document revision is exhausted"),
            Self::OverlappingEdits => {
                f.write_str("Transaction ranges overlap or have ambiguous insertion order")
            }
            Self::TooManyEdits { count, limit } => {
                write!(f, "Transaction has {count} edits; limit is {limit}")
            }
            Self::ParseLimit { limit } => write!(f, "Document exceeds parsing limit: {limit}"),
            Self::InvalidRequest { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}
