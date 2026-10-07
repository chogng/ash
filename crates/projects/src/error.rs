#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProjectError {
    #[error("Project was not found: {0}")]
    NotFound(String),
    #[error("Project already exists: {0}")]
    AlreadyExists(String),
    #[error("Project command ID was already used for different parameters")]
    CommandConflict,
    #[error("Project revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("invalid Project input: {0}")]
    InvalidInput(String),
    #[error("invalid Project transition: {0}")]
    InvalidTransition(String),
    #[error("Project storage failed: {0}")]
    Storage(String),
}
