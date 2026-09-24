use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;

/// A presentation-level fact consumed by the active Thread feature.
pub(crate) enum ThreadPresentationEvent {
    TranscriptSnapshotReceived(ThreadTranscriptSnapshot),
    TranscriptHistoryPageReceived(ThreadTranscriptSnapshot),
    TranscriptUpdateReceived(Box<ThreadTranscriptUpdateEnvelope>),
    UserSubmitted(String),
    CommandSubmitted {
        command: String,
        completion: super::transcript::LocalCommandCompletion,
    },
    CommandStarted(String),
    CommandCompleted {
        command: String,
        result: String,
    },
    CommandFailed {
        command: String,
        error: String,
    },
    NoticeReceived(String),
    FailureReported(String),
    Interrupted,
    Cleared,
}
