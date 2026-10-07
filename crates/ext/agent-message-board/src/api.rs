use crate::Commit;
use crate::ReadRequest;
use crate::Result;
use crate::Scope;
use crate::Store;
use crate::Unread;
use crate::WriteRequest;
use async_utils::CancellationToken;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// Board operations shared by SQLite and remote service implementations.
/// The runtime owns tree membership and the configured clock. Each backend preserves
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

/// Transient SSE previews owned by ExtensionState's receiving Turn scope.
/// Durable unread state remains authoritative, including acknowledgements.
#[derive(Default)]
pub struct LiveNotices(Mutex<BTreeMap<i64, Value>>);

impl LiveNotices {
    pub fn accept(&self, post: Value) -> Result<()> {
        let id = validate_preview(&post)?;
        let mut notices = self
            .0
            .lock()
            .map_err(|_| crate::Error::Runtime("board notification lock poisoned".into()))?;
        notices.insert(id, post);
        while notices.len() > 8 {
            notices.pop_first();
        }
        Ok(())
    }

    pub(crate) fn merge(&self, unread: &mut Unread) -> Result<()> {
        let notices = self
            .0
            .lock()
            .map_err(|_| crate::Error::Runtime("board notification lock poisoned".into()))?;
        // Only replace previews still present in the authoritative unread page.
        // An SSE frame cannot resurrect an acknowledged or deleted message.
        for post in &mut unread.notices {
            if let Some(live) = post["id"].as_i64().and_then(|id| notices.get(&id)) {
                *post = live.clone();
            }
        }
        Ok(())
    }
}
