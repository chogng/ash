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
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use std::sync::MutexGuard;

mod read;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agent_board_sessions (
    session TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_boards (
    id INTEGER PRIMARY KEY,
    session TEXT NOT NULL REFERENCES agent_board_sessions(session),
    root TEXT NOT NULL,
    UNIQUE(session, root)
);
CREATE TABLE IF NOT EXISTS agent_board_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board INTEGER NOT NULL REFERENCES agent_boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL, search_name TEXT NOT NULL,
    creator TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(board, name)
);
CREATE TABLE IF NOT EXISTS agent_board_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel INTEGER NOT NULL REFERENCES agent_board_channels(id) ON DELETE CASCADE,
    topic INTEGER REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    author TEXT NOT NULL, created_at INTEGER NOT NULL,
    body TEXT NOT NULL, search_body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_board_channel_posts ON agent_board_posts(channel, id);
CREATE INDEX IF NOT EXISTS agent_board_channel_topics ON agent_board_posts(channel, id) WHERE topic IS NULL;
CREATE INDEX IF NOT EXISTS agent_board_topic_posts ON agent_board_posts(topic, id);
CREATE TABLE IF NOT EXISTS agent_board_channel_members (
    channel INTEGER NOT NULL REFERENCES agent_board_channels(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(channel, member)
);
CREATE TABLE IF NOT EXISTS agent_board_topic_members (
    topic INTEGER NOT NULL REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(topic, member)
);
CREATE TABLE IF NOT EXISTS agent_board_channel_opt_outs (
    channel INTEGER NOT NULL REFERENCES agent_board_channels(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(channel, member)
);
CREATE TABLE IF NOT EXISTS agent_board_topic_opt_outs (
    topic INTEGER NOT NULL REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(topic, member)
);
CREATE TABLE IF NOT EXISTS agent_board_unread (
    board INTEGER NOT NULL REFERENCES agent_boards(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    post INTEGER NOT NULL REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    target_kind INTEGER NOT NULL, target INTEGER NOT NULL,
    PRIMARY KEY(board, member, post)
);
CREATE INDEX IF NOT EXISTS agent_board_unread_target ON agent_board_unread(target_kind, target, member);
CREATE TABLE IF NOT EXISTS agent_board_commands (
    board INTEGER NOT NULL REFERENCES agent_boards(id) ON DELETE CASCADE,
    actor TEXT NOT NULL, call TEXT NOT NULL,
    request TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(board, actor, call)
);
";

/// Owns board data in the profile database, or in memory for an ephemeral session.
/// Writes and their replay receipts commit together; Session deletion closes its boards.
pub struct Store {
    database: Mutex<Connection>,
}

pub(crate) struct Unread {
    pub count: i64,
    pub through: i64,
    pub notices: Vec<serde_json::Value>,
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

    fn initialize(database: Connection) -> Result<Self> {
        database.execute_batch(SCHEMA)?;
        Ok(Self {
            database: Mutex::new(database),
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.database
            .lock()
            .map_err(|_| Error::Runtime("database lock poisoned".into()))
    }

    pub(crate) fn unread(&self, scope: &Scope, member: &ThreadId) -> Result<Unread> {
        let mut database = self.connection()?;
        let transaction = database.transaction()?;
        check_session(&transaction, scope)?;
        let Some(board) = board_id(&transaction, scope)? else {
            return Ok(Unread {
                count: 0,
                through: 0,
                notices: Vec::new(),
            });
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

    pub fn delete_session(&self, session: &SessionId) -> Result<()> {
        let mut database = self.connection()?;
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO agent_board_sessions(session, deleted) VALUES (?1, 1)
             ON CONFLICT(session) DO UPDATE SET deleted = 1",
            [session.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM agent_boards WHERE session = ?1",
            [session.as_str()],
        )?;
        transaction.commit()?;
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
                Commit {
                    output: json!({"channel": channel, "topic": topic, "member": actor, "state": state}),
                }
            }
            Write::Acknowledge { through } => {
                let removed = transaction.execute(
                    "DELETE FROM agent_board_unread WHERE board=?1 AND member=?2 AND post<=?3",
                    params![board, actor.as_str(), through],
                )?;
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
        Ok(commit)
    }
}

fn check_session(database: &Connection, scope: &Scope) -> Result<()> {
    let deleted: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_board_sessions WHERE session=?1 AND deleted=1)",
        [scope.session.as_str()],
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
