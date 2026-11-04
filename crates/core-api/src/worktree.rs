use crate::CoreError;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;

/// Pins a new worktree to a named remote ref and its observed commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeStart {
    pub remote: String,
    pub remote_identity: String,
    pub reference: String,
    pub commit: String,
}

/// Durable Thread identity supplied before Core creates or attaches its Thread event stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadWorktreeBindingRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub origin: ThreadOrigin,
    pub branch_name: Option<String>,
    pub worktree_start: Option<WorktreeStart>,
}

/// Host boundary that must persist an isolated Worktree binding before Thread execution exists.
pub trait ThreadWorktreeBinder: Send + Sync {
    fn provision(&self, request: &ThreadWorktreeBindingRequest) -> Result<(), CoreError>;
}
