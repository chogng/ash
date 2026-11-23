use crate::Error;
use crate::Result;
use crate::model::Commit;
use crate::model::Message;
use crate::model::OUTPUT_BYTES;
use crate::model::Scope;
use crate::model::Subscription;
use crate::model::Write;
use crate::model::input;
use protocol::SessionId;
use protocol::ThreadId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

mod read;

const MIGRATOR: state::SqliteMigrator<'_> = state::SqliteMigrator::new(
    "agent-message-board",
    &[
        state::SqliteMigration::sql(
            1,
            include_str!("../migrations/0001_agent_message_board.sql"),
        ),
        state::SqliteMigration::sql(2, include_str!("../migrations/0002_remote_locations.sql")),
        state::SqliteMigration::sql(
            3,
            include_str!("../migrations/0003_remote_cleanup_receipts.sql"),
        ),
    ],
);

/// Owns board data in the profile database, or in memory for an ephemeral session.
/// Writes and their replay receipts commit together; Session deletion closes its boards.
pub struct Store {
    database: Mutex<Connection>,
    unread_watches: Mutex<BTreeMap<(Scope, ThreadId), Weak<UnreadWatch>>>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Unread {
    pub count: i64,
    pub through: i64,
    pub notices: Vec<serde_json::Value>,
}

/// Identifies remote storage for cleanup. Only the credential's environment name is persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBoardLocation {
    pub endpoint: String,
    pub credential_env: String,
}

/// A live reader invalidated by writes to its own unread records.
pub(crate) struct UnreadWatch {
    dirty: AtomicBool,
    cached: Mutex<Option<(i64, Unread)>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let database = state::open_sqlite_database(path, state::SqliteDurability::Durable)
            .map_err(Error::Runtime)?;
        Self::initialize(database)
    }

    pub fn in_memory() -> Result<Self> {
        let database = state::open_in_memory_database(state::SqliteDurability::Durable)
            .map_err(Error::Runtime)?;
        Self::initialize(database)
    }

    fn initialize(mut database: Connection) -> Result<Self> {
        MIGRATOR.run(&mut database).map_err(Error::Runtime)?;
        Ok(Self {
            database: Mutex::new(database),
            unread_watches: Mutex::default(),
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.database
            .lock()
            .map_err(|_| Error::Runtime("database lock poisoned".into()))
    }

    pub(crate) fn unread(&self, scope: &Scope, member: &ThreadId) -> Result<Unread> {
        let mut database = self.connection()?;
        unread(&mut database, scope, member)
    }

    pub(crate) fn watch_unread(
        &self,
        scope: &Scope,
        member: &ThreadId,
    ) -> Result<Arc<UnreadWatch>> {
        let mut watches = self.unread_watches.lock().map_err(unread_lock_error)?;
        let key = (scope.clone(), member.clone());
        if let Some(watch) = watches.get(&key).and_then(Weak::upgrade) {
            return Ok(watch);
        }
        watches.retain(|_, watch| watch.strong_count() > 0);
        let watch = Arc::new(UnreadWatch {
            dirty: AtomicBool::new(true),
            cached: Mutex::default(),
        });
        watches.insert(key, Arc::downgrade(&watch));
        Ok(watch)
    }

    pub(crate) fn watched_unread(
        &self,
        scope: &Scope,
        member: &ThreadId,
        watch: &UnreadWatch,
    ) -> Result<Unread> {
        let mut cached = watch.cached.lock().map_err(unread_lock_error)?;
        let mut database = self.connection()?;
        // Other connections can write this profile database. Keep the fast path
        // coherent even when those writers have a different Store instance.
        let data_version = database.query_row("PRAGMA data_version", [], |row| row.get(0))?;
        if !watch.dirty.load(Ordering::Relaxed)
            && let Some((version, unread)) = cached.as_ref()
            && *version == data_version
        {
            return Ok(unread.clone());
        }
        let unread = unread(&mut database, scope, member)?;
        *cached = Some((data_version, unread.clone()));
        watch.dirty.store(false, Ordering::Relaxed);
        Ok(unread)
    }

    pub fn delete_session(&self, session: &SessionId) -> Result<()> {
        self.close_session(session, None).map(|_| ())
    }

    /// Records a possible external write before sending it, even if its response is lost.
    pub fn remember_remote(
        &self,
        session: &SessionId,
        location: &RemoteBoardLocation,
    ) -> Result<()> {
        let mut database = self.connection()?;
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_open_session(&transaction, session)?;
        transaction.execute(
            "INSERT OR IGNORE INTO agent_board_sessions(session) VALUES (?1)",
            [session.as_str()],
        )?;
        transaction.execute(
            "INSERT INTO agent_board_remote_locations(session, endpoint, credential_env) VALUES (?1, ?2, ?3)
             ON CONFLICT(session, endpoint) DO UPDATE SET credential_env=excluded.credential_env
             WHERE credential_env<>excluded.credential_env",
            params![session.as_str(), location.endpoint, location.credential_env],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Atomically discards local data and makes every recorded remote location eligible for retry.
    /// The fallback preserves deletion of boards created before location tracking existed.
    pub fn close_session(
        &self,
        session: &SessionId,
        legacy_location: Option<&RemoteBoardLocation>,
    ) -> Result<bool> {
        let mut database = self.connection()?;
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(location) = legacy_location {
            transaction.execute(
                "INSERT OR IGNORE INTO agent_board_sessions(session) VALUES (?1)",
                [session.as_str()],
            )?;
            transaction.execute(
                "INSERT INTO agent_board_remote_locations(session, endpoint, credential_env)
                 SELECT session, ?2, ?3 FROM agent_board_sessions
                 WHERE session=?1 AND deleted=0
                   AND NOT EXISTS (SELECT 1 FROM agent_board_remote_locations WHERE session=?1)",
                params![session.as_str(), location.endpoint, location.credential_env],
            )?;
        }
        close_local_board(&transaction, session)?;
        let pending = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_board_remote_locations WHERE session=?1 AND cleaned=0)",
            [session.as_str()],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        self.invalidate_unread(|scope, _| &scope.session == session);
        Ok(pending)
    }

    /// Restores a known route after the Session owner has confirmed the Session is gone.
    /// A cleanup receipt prevents a retained recovery configuration from reopening the job.
    pub fn recover_remote_deletion(
        &self,
        session: &SessionId,
        location: &RemoteBoardLocation,
    ) -> Result<()> {
        let mut database = self.connection()?;
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        close_local_board(&transaction, session)?;
        transaction.execute(
            "INSERT INTO agent_board_remote_locations(session, endpoint, credential_env) VALUES (?1, ?2, ?3)
             ON CONFLICT(session, endpoint) DO UPDATE SET credential_env=excluded.credential_env
             WHERE cleaned=0 AND credential_env<>excluded.credential_env",
            params![session.as_str(), location.endpoint, location.credential_env],
        )?;
        transaction.commit()?;
        self.invalidate_unread(|scope, _| &scope.session == session);
        Ok(())
    }

    pub fn pending_remote_deletions(&self) -> Result<Vec<(SessionId, RemoteBoardLocation)>> {
        let database = self.connection()?;
        let mut statement = database.prepare(
            "SELECT r.session, r.endpoint, r.credential_env
             FROM agent_board_remote_locations r JOIN agent_board_sessions s USING(session)
             WHERE s.deleted=1 AND r.cleaned=0 ORDER BY r.session, r.endpoint",
        )?;
        let jobs = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                RemoteBoardLocation {
                    endpoint: row.get(1)?,
                    credential_env: row.get(2)?,
                },
            ))
        })?;
        jobs.map(|job| {
            let (session, location) = job?;
            let session =
                SessionId::new(session).map_err(|error| Error::Runtime(error.to_string()))?;
            Ok((session, location))
        })
        .collect()
    }

    pub fn confirm_remote_deletion(
        &self,
        session: &SessionId,
        location: &RemoteBoardLocation,
    ) -> Result<()> {
        self.connection()?.execute(
            "UPDATE agent_board_remote_locations SET cleaned=1 WHERE session=?1 AND endpoint=?2 AND credential_env=?3
             AND EXISTS (SELECT 1 FROM agent_board_sessions WHERE session=?1 AND deleted=1)",
            params![session.as_str(), location.endpoint, location.credential_env],
        )?;
        Ok(())
    }

    pub(crate) fn write(
        &self,
        scope: &Scope,
        actor: &ThreadId,
        call: &str,
        time: i64,
        command: &Write,
    ) -> Result<Commit> {
        let request = serde_json::to_string(command)?;
        let mut database = self.connection()?;
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_session(&transaction, scope)?;
        transaction.execute(
            "INSERT OR IGNORE INTO agent_board_sessions(session) VALUES (?1)",
            [scope.session.as_str()],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO agent_boards(session, root) VALUES (?1, ?2)",
            params![scope.session.as_str(), scope.root.as_str()],
        )?;
        let board = board_id(&transaction, scope)?.expect("board inserted in this transaction");
        let previous: Option<(String, String)> = transaction.query_row(
            "SELECT request, response FROM agent_board_commands WHERE board=?1 AND actor=?2 AND call=?3",
            params![board, actor.as_str(), call],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((original, response)) = previous {
            if original != request {
                return Err(input(
                    "this operation already committed different arguments",
                ));
            }
            return Ok(Commit {
                output: serde_json::from_str(&response)?,
            });
        }

        let mut changed = BTreeSet::new();
        let commit = match command {
            Write::CreateChannel { channel } => {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_board_channels WHERE board=?1 AND name=?2)",
                    params![board, channel],
                    |row| row.get(0),
                )?;
                if exists {
                    return Err(input("channel already exists"));
                }
                transaction.execute(
                    "INSERT INTO agent_board_channels(board, name, search_name, creator, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![board, channel, caseless::default_case_fold_str(channel), actor.as_str(), time],
                )?;
                let id = transaction.last_insert_rowid();
                subscription(&transaction, Target::Channel(id), actor, Follow::Automatic)?;
                Commit {
                    output: json!({"channel": channel, "creator": actor, "created_at": time}),
                }
            }
            Write::Post {
                channel,
                topic,
                text,
                notify,
            } => {
                let channel_id = channel_id(&transaction, board, channel)?;
                if let Some(topic) = topic {
                    check_topic(&transaction, channel_id, *topic)?;
                }
                transaction.execute(
                    "INSERT INTO agent_board_posts(channel, topic, author, created_at, body, search_body)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![channel_id, topic, actor.as_str(), time, text, caseless::default_case_fold_str(text)],
                )?;
                let id = transaction.last_insert_rowid();
                let root = topic.unwrap_or(id);
                subscription(&transaction, Target::Topic(root), actor, Follow::Automatic)?;
                let mut recipients: BTreeSet<ThreadId> = notify.iter().cloned().collect();
                let (sql, opt_out_sql, target) = match topic {
                    Some(id) => (
                        "SELECT member FROM agent_board_topic_members WHERE topic=?1",
                        "SELECT member FROM agent_board_topic_opt_outs WHERE topic=?1",
                        *id,
                    ),
                    None => (
                        "SELECT member FROM agent_board_channel_members WHERE channel=?1",
                        "SELECT member FROM agent_board_channel_opt_outs WHERE channel=?1",
                        channel_id,
                    ),
                };
                let mut statement = transaction.prepare(sql)?;
                for member in statement.query_map([target], |row| row.get::<_, String>(0))? {
                    recipients.insert(
                        ThreadId::new(member?)
                            .map_err(|error| Error::Runtime(error.to_string()))?,
                    );
                }
                let mut statement = transaction.prepare(opt_out_sql)?;
                for member in statement.query_map([target], |row| row.get::<_, String>(0))? {
                    recipients.remove(
                        &ThreadId::new(member?)
                            .map_err(|error| Error::Runtime(error.to_string()))?,
                    );
                }
                recipients.remove(actor);
                let target_kind = i64::from(topic.is_some());
                for recipient in &recipients {
                    transaction.execute(
                        "INSERT INTO agent_board_unread(board, member, post, target_kind, target)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![board, recipient.as_str(), id, target_kind, target],
                    )?;
                }
                changed = recipients;
                let message = Message {
                    id,
                    topic: root,
                    channel: channel.clone(),
                    author: actor.clone(),
                    time,
                    text: text.clone(),
                    replies: 0,
                };
                Commit {
                    output: message.receipt(),
                }
            }
            Write::Subscription {
                channel,
                topic,
                state,
            } => {
                let channel_id = channel_id(&transaction, board, channel)?;
                let target = match topic {
                    Some(id) => {
                        check_topic(&transaction, channel_id, *id)?;
                        Target::Topic(*id)
                    }
                    None => Target::Channel(channel_id),
                };
                subscription(&transaction, target, actor, Follow::Explicit(*state))?;
                if matches!(state, Subscription::Off) {
                    changed.insert(actor.clone());
                }
                Commit {
                    output: json!({"channel": channel, "topic": topic, "member": actor, "state": state}),
                }
            }
            Write::Acknowledge { through } => {
                let removed = transaction.execute(
                    "DELETE FROM agent_board_unread WHERE board=?1 AND member=?2 AND post<=?3",
                    params![board, actor.as_str(), through],
                )?;
                if removed > 0 {
                    changed.insert(actor.clone());
                }
                Commit {
                    output: json!({"through": through, "acknowledged": removed}),
                }
            }
        };
        let response = serde_json::to_string(&commit.output)?;
        if response.len() > OUTPUT_BYTES {
            return Err(input("receipt exceeds the message-board response limit"));
        }
        transaction.execute(
            "INSERT INTO agent_board_commands(board, actor, call, request, response) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![board, actor.as_str(), call, request, response],
        )?;
        transaction.commit()?;
        if !changed.is_empty() {
            self.invalidate_unread(|board, member| board == scope && changed.contains(member));
        }
        Ok(commit)
    }

    fn invalidate_unread(&self, affected: impl Fn(&Scope, &ThreadId) -> bool) {
        let mut watches = self
            .unread_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        watches.retain(|(scope, member), watch| {
            let Some(watch) = watch.upgrade() else {
                return false;
            };
            if affected(scope, member) {
                watch.dirty.store(true, Ordering::Relaxed);
            }
            true
        });
    }
}

fn close_local_board(transaction: &Transaction<'_>, session: &SessionId) -> Result<()> {
    transaction.execute(
        "INSERT INTO agent_board_sessions(session, deleted) VALUES (?1, 1)
         ON CONFLICT(session) DO UPDATE SET deleted=1 WHERE deleted=0",
        [session.as_str()],
    )?;
    transaction.execute(
        "DELETE FROM agent_boards WHERE session=?1",
        [session.as_str()],
    )?;
    Ok(())
}

fn unread_lock_error<T>(_: std::sync::PoisonError<T>) -> Error {
    Error::Runtime("board unread lock poisoned".into())
}

fn unread(database: &mut Connection, scope: &Scope, member: &ThreadId) -> Result<Unread> {
    let transaction = database.transaction()?;
    check_session(&transaction, scope)?;
    let Some(board) = board_id(&transaction, scope)? else {
        return Ok(Unread::default());
    };
    let (count, through): (i64, Option<i64>) = transaction.query_row(
        "SELECT COUNT(*), MAX(post) FROM agent_board_unread WHERE board=?1 AND member=?2",
        params![board, member.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut statement = transaction.prepare(
        "SELECT p.id, COALESCE(p.topic,p.id), c.name, p.author, p.created_at,
                substr(p.body,1,150), length(p.body)
         FROM agent_board_unread u
         JOIN agent_board_posts p ON p.id=u.post
         JOIN agent_board_channels c ON c.id=p.channel
         WHERE u.board=?1 AND u.member=?2 ORDER BY u.post DESC LIMIT 8",
    )?;
    let notices = statement
        .query_map(params![board, member.as_str()], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "topic": row.get::<_, i64>(1)?,
                "channel": row.get::<_, String>(2)?,
                "author": row.get::<_, String>(3)?,
                "created_at": row.get::<_, i64>(4)?,
                "preview": row.get::<_, String>(5)?,
                "total_chars": row.get::<_, i64>(6)?,
                "replies": 0,
            }))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Unread {
        count,
        through: through.unwrap_or(0),
        notices,
    })
}

fn check_session(database: &Connection, scope: &Scope) -> Result<()> {
    require_open_session(database, &scope.session)
}

fn require_open_session(database: &Connection, session: &SessionId) -> Result<()> {
    let deleted: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_board_sessions WHERE session=?1 AND deleted=1)",
        [session.as_str()],
        |row| row.get(0),
    )?;
    if deleted {
        return Err(input("the message-board Session was deleted"));
    }
    Ok(())
}

fn board_id(database: &Connection, scope: &Scope) -> Result<Option<i64>> {
    Ok(database
        .query_row(
            "SELECT id FROM agent_boards WHERE session=?1 AND root=?2",
            params![scope.session.as_str(), scope.root.as_str()],
            |row| row.get(0),
        )
        .optional()?)
}

fn channel_id(database: &Connection, board: i64, name: &str) -> Result<i64> {
    database
        .query_row(
            "SELECT id FROM agent_board_channels WHERE board=?1 AND name=?2",
            params![board, name],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| input("channel does not exist in this board"))
}

fn check_topic(database: &Connection, channel: i64, topic: i64) -> Result<()> {
    let root: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_board_posts WHERE id=?1 AND channel=?2 AND topic IS NULL)",
        params![topic, channel], |row| row.get(0),
    )?;
    if !root {
        return Err(input(
            "topic must identify a root post in the selected channel",
        ));
    }
    Ok(())
}

enum Target {
    Channel(i64),
    Topic(i64),
}

enum Follow {
    Automatic,
    Explicit(Subscription),
}

fn subscription(
    database: &Transaction<'_>,
    target: Target,
    member: &ThreadId,
    follow: Follow,
) -> Result<()> {
    let (members, opt_outs, column, kind, id) = match target {
        Target::Channel(id) => (
            "agent_board_channel_members",
            "agent_board_channel_opt_outs",
            "channel",
            0,
            id,
        ),
        Target::Topic(id) => (
            "agent_board_topic_members",
            "agent_board_topic_opt_outs",
            "topic",
            1,
            id,
        ),
    };
    match follow {
        Follow::Automatic => {
            database.execute(
                &format!(
                    "INSERT OR IGNORE INTO {members}({column}, member)
                     SELECT ?1, ?2 WHERE NOT EXISTS (
                         SELECT 1 FROM {opt_outs} WHERE {column}=?1 AND member=?2
                     )"
                ),
                params![id, member.as_str()],
            )?;
        }
        Follow::Explicit(Subscription::On) => {
            database.execute(
                &format!("DELETE FROM {opt_outs} WHERE {column}=?1 AND member=?2"),
                params![id, member.as_str()],
            )?;
            database.execute(
                &format!("INSERT OR IGNORE INTO {members}({column}, member) VALUES (?1, ?2)"),
                params![id, member.as_str()],
            )?;
        }
        Follow::Explicit(Subscription::Off) => {
            database.execute(
                &format!("DELETE FROM {members} WHERE {column}=?1 AND member=?2"),
                params![id, member.as_str()],
            )?;
            database.execute(
                &format!("INSERT OR IGNORE INTO {opt_outs}({column}, member) VALUES (?1, ?2)"),
                params![id, member.as_str()],
            )?;
            database.execute(
                "DELETE FROM agent_board_unread WHERE target_kind=?1 AND target=?2 AND member=?3",
                params![kind, id, member.as_str()],
            )?;
        }
    }
    Ok(())
}
