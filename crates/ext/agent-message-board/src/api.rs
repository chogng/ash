use crate::Commit;
use crate::ReadRequest;
use crate::Result;
use crate::Scope;
use crate::Store;
use crate::Unread;
use crate::WriteRequest;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Mutex;

/// Supplies membership and scopes transient state to a live Turn under the owner lock.
pub trait BoardTurnHost: Send + Sync {
    fn tree_members(&self, caller: &ThreadId) -> Result<(Scope, Vec<ThreadId>)>;
    fn with_active_turn(
        &self,
        caller: &ThreadId,
        session: &SessionId,
        turn: &TurnId,
        update: &mut dyn FnMut(),
    ) -> Result<()>;
}

/// Supplies board access facts from the runtime that owns Threads and Turns.
pub trait MessageBoardHost: BoardTurnHost {
    fn require_running_turn(
        &self,
        caller: &ThreadId,
        session: &SessionId,
        turn: &TurnId,
    ) -> Result<()>;
    fn scope(&self, caller: &ThreadId) -> Result<Scope>;
    fn current_time(&self) -> Result<i64>;
}

/// Board operations shared by SQLite and remote service implementations.
/// The host owns tree membership and the configured clock. Each backend preserves
/// operation receipts and unread acknowledgements; a transport error must remain an error.
pub trait BoardBackend: Send + Sync {
    /// Publishes the host-validated members of this tree before accessing it.
    /// Registration is additive so newly delegated members join the existing board.
    fn register_members(
        &self,
        scope: &Scope,
        members: &[ThreadId],
        cancellation: &CancellationToken,
    ) -> Result<()>;
    fn read(
        &self,
        scope: &Scope,
        member: &ThreadId,
        request: &ReadRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value>;
    fn write(
        &self,
        scope: &Scope,
        member: &ThreadId,
        operation: &str,
        time: i64,
        request: &WriteRequest,
        cancellation: &CancellationToken,
    ) -> Result<Commit>;
    fn unread(
        &self,
        scope: &Scope,
        member: &ThreadId,
        cancellation: &CancellationToken,
    ) -> Result<Unread>;
    fn delete_session(&self, session: &SessionId) -> Result<()>;
}

impl BoardBackend for Store {
    fn register_members(
        &self,
        scope: &Scope,
        members: &[ThreadId],
        cancellation: &CancellationToken,
    ) -> Result<()> {
        cancellation
            .check()
            .map_err(|error| crate::Error::Runtime(error.to_string()))?;
        if !members.contains(&scope.root) {
            return Err(crate::Error::Input(
                "board members must include the root Thread".into(),
            ));
        }
        // Same-process membership is already checked by the Thread owner. SQLite
        // does not maintain a second copy of its mutable runtime authority.
        Ok(())
    }
    fn read(
        &self,
        scope: &Scope,
        member: &ThreadId,
        request: &ReadRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        cancellation
            .check()
            .map_err(|error| crate::Error::Runtime(error.to_string()))?;
        Store::read(self, scope, member, request)
    }
    fn write(
        &self,
        scope: &Scope,
        member: &ThreadId,
        operation: &str,
        time: i64,
        request: &WriteRequest,
        cancellation: &CancellationToken,
    ) -> Result<Commit> {
        cancellation
            .check()
            .map_err(|error| crate::Error::Runtime(error.to_string()))?;
        request.validate()?;
        Store::write(self, scope, member, operation, time, request)
    }
    fn unread(
        &self,
        scope: &Scope,
        member: &ThreadId,
        cancellation: &CancellationToken,
    ) -> Result<Unread> {
        cancellation
            .check()
            .map_err(|error| crate::Error::Runtime(error.to_string()))?;
        Store::unread(self, scope, member)
    }
    fn delete_session(&self, session: &SessionId) -> Result<()> {
        Store::delete_session(self, session)
    }
}

/// A bounded preview belonging to one exact receiving Turn, never a request to start work.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BoardNotification {
    pub scope: Scope,
    pub recipient: ThreadId,
    pub turn_id: TurnId,
    pub post: Value,
}

impl BoardNotification {
    pub fn validate(&self) -> Result<()> {
        validate_preview(&self.post).map(|_| ())
    }
}

fn validate_preview(post: &Value) -> Result<i64> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Preview {
        id: i64,
        topic: i64,
        channel: String,
        author: ThreadId,
        created_at: i64,
        preview: String,
        total_chars: u64,
        replies: u64,
    }
    let preview: Preview = serde_json::from_value(post.clone())
        .map_err(|_| crate::Error::Input("invalid board notification metadata".into()))?;
    crate::model::post_id(preview.id)?;
    crate::model::post_id(preview.topic)?;
    crate::model::channel_name(&preview.channel)?;
    let count = preview.preview.chars().count();
    if serde_json::to_vec(post)?.len() > 2048 || count > 150 || preview.total_chars < count as u64 {
        return Err(crate::Error::Input(
            "invalid board notification preview".into(),
        ));
    }
    // Deserialization validates typed metadata even though rendering retains the
    // original JSON shape shared with the existing board_read output.
    let _ = (preview.author, preview.created_at, preview.replies);
    Ok(preview.id)
}

/// A background snapshot of authoritative unread records for exactly one Turn.
#[derive(Default)]
pub struct RemoteUnread(Mutex<RemoteUnreadState>);

#[derive(Default)]
struct RemoteUnreadState {
    revision: u64,
    unread: Unread,
    observation: Option<CancellationSource>,
}

impl RemoteUnread {
    /// Starts a refresh and stream that a successful acknowledgement can retire.
    pub fn start_observation(&self, turn: &CancellationToken) -> CancellationToken {
        let source = turn.child_source();
        let token = source.token();
        self.state().observation = Some(source);
        token
    }

    pub fn revision(&self) -> u64 {
        self.state().revision
    }

    pub fn publish(&self, revision: u64, unread: Unread) {
        let mut state = self.state();
        if state.revision == revision {
            state.unread = unread;
        }
    }

    pub(crate) fn snapshot(&self) -> Unread {
        self.state().unread.clone()
    }

    pub(crate) fn invalidate(&self) {
        let observation = {
            let mut state = self.state();
            state.revision += 1;
            state.unread = Unread::default();
            state.observation.take()
        };
        if let Some(source) = observation {
            source.cancel();
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, RemoteUnreadState> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Unread {
    /// Checks the remote snapshot before trusting it as contextual evidence.
    pub fn validate_remote(&self) -> Result<()> {
        let invalid = || crate::Error::Runtime("invalid board unread response".into());
        if self.count < self.notices.len() as i64
            || self.notices.len() > 8
            || (self.count == 0 && self.through != 0)
            || (self.count > 0 && self.through <= 0)
        {
            return Err(invalid());
        }
        let mut ids = BTreeSet::new();
        for notice in &self.notices {
            let id = validate_preview(notice)?;
            if id > self.through || !ids.insert(id) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
