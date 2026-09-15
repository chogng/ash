use ash_thread_store::ThreadStoreError;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CoreError {
    Cancelled(String),
    Context(String),
    Execution(String),
    InvalidTransition {
        from: String,
        to: String,
    },
    InvalidInput(String),
    Journal(String),
    Model(String),
    ModelFailure(ash_protocol::StableTurnError),
    ModelTransient {
        failure: ash_protocol::StableTurnError,
        retry_after_ms: Option<u64>,
    },
    ModelContextOverflow,
    ModelAuthFailed,
    ModelInvalidRequest,
    ModelInvalidResponse,
    ModelUsageLimited,
    NotFound(String),
    Policy(String),
    PolicyCircuitBreaker(String),
    ToolRepetition(String),
    CommandConflict,
    ThreadStore(ThreadStoreError),
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(message) => write!(formatter, "cancelled: {message}"),
            Self::Context(message) => write!(formatter, "context error: {message}"),
            Self::Execution(message) => write!(formatter, "execution error: {message}"),
            Self::InvalidTransition { from, to } => {
                write!(formatter, "cannot transition from {from} to {to}")
            }
            Self::InvalidInput(message) => write!(formatter, "invalid input: {message}"),
            Self::Journal(message) => write!(formatter, "journal error: {message}"),
            Self::Model(message) => write!(formatter, "model error: {message}"),
            Self::ModelFailure(failure) => formatter.write_str(&failure.message),
            Self::ModelTransient { retry_after_ms, .. } => match retry_after_ms {
                Some(delay) => write!(formatter, "transient model error; retry after {delay} ms"),
                None => formatter.write_str("transient model error"),
            },
            Self::ModelContextOverflow => formatter.write_str("model context window exceeded"),
            Self::ModelAuthFailed => formatter.write_str("model provider authentication failed"),
            Self::ModelInvalidRequest => formatter.write_str("model request was invalid"),
            Self::ModelInvalidResponse => formatter.write_str("model response was invalid"),
            Self::ModelUsageLimited => formatter.write_str("model provider usage limit reached"),
            Self::NotFound(value) => write!(formatter, "not found: {value}"),
            Self::Policy(message) => write!(formatter, "policy error: {message}"),
            Self::PolicyCircuitBreaker(message) => {
                write!(formatter, "policy circuit breaker: {message}")
            }
            Self::ToolRepetition(message) => write!(formatter, "tool repetition: {message}"),
            Self::CommandConflict => formatter.write_str("command ID conflict"),
            Self::ThreadStore(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<agent_graph_store::AgentGraphStoreError> for CoreError {
    fn from(error: agent_graph_store::AgentGraphStoreError) -> Self {
        Self::Journal(error.to_string())
    }
}

impl From<ThreadStoreError> for CoreError {
    fn from(error: ThreadStoreError) -> Self {
        Self::ThreadStore(error)
    }
}
