use crate::OllamaError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PullEvent {
    Status(String),
    Progress {
        digest: String,
        completed: Option<u64>,
        total: Option<u64>,
    },
    Completed,
    Failed(String),
}

/// Receives ordered progress from one explicit Ollama model download.
///
/// Implementations should return an error when their owning UI, command, or connection is no
/// longer able to consume events. That error stops the HTTP stream and is returned to the caller.
pub trait PullProgressSink {
    fn emit(&mut self, event: PullEvent) -> Result<(), OllamaError>;
}
