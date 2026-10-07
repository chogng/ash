use thiserror::Error;

/// Identifies which input caused a diff validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffSide {
    Original,
    Modified,
}

/// A bounded diff computation failure.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum DiffError {
    #[error("{side:?} input exceeds the {limit}-byte limit with {actual} bytes")]
    InputTooLarge {
        side: DiffSide,
        actual: usize,
        limit: usize,
    },
    #[error("{side:?} input exceeds the {limit}-line limit with {actual} lines")]
    TooManyLines {
        side: DiffSide,
        actual: usize,
        limit: usize,
    },
    #[error("{side:?} input is not valid UTF-8")]
    InvalidUtf8 { side: DiffSide },
    #[error("{side:?} input contains NUL and is treated as binary")]
    BinaryInput { side: DiffSide },
    #[error("diff computation was cancelled")]
    Cancelled,
    #[error("diff edit distance exceeded the configured limit of {limit}")]
    EditDistanceLimit { limit: usize },
    #[error("diff trace exceeded the configured {limit}-cell memory bound")]
    TraceLimit { limit: usize },
}
