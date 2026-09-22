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
                notification: None,
                recipients: Vec::new(),
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
                subscription(&transaction, Target::Channel(id), actor, Subscription::On)?;
                Commit {
                    output: json!({"channel": channel, "creator": actor, "created_at": time}),
                    notification: None,
                    recipients: Vec::new(),
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
                subscription(&transaction, Target::Topic(root), actor, Subscription::On)?;
                let mut recipients: BTreeSet<ThreadId> = notify.iter().cloned().collect();
                let (sql, target) = match topic {
                    Some(id) => (
                        "SELECT member FROM agent_board_topic_members WHERE topic=?1",
                        *id,
                    ),
                    None => (
                        "SELECT member FROM agent_board_channel_members WHERE channel=?1",
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
                recipients.remove(actor);
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
                    notification: Some(message.summary(150)),
                    recipients: recipients.into_iter().collect(),
                }
            }
            Write::Subscription {
                channel,
                topic,
                member,
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
                let member = member.as_ref().unwrap_or(actor);
                subscription(&transaction, target, member, *state)?;
                Commit {
                    output: json!({"channel": channel, "topic": topic, "member": member, "state": state}),
                    notification: None,
                    recipients: Vec::new(),
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

fn subscription(
    database: &Transaction<'_>,
    target: Target,
    member: &ThreadId,
    change: Subscription,
) -> Result<()> {
    let (table, column, id) = match target {
        Target::Channel(id) => ("agent_board_channel_members", "channel", id),
        Target::Topic(id) => ("agent_board_topic_members", "topic", id),
    };
    let sql = match change {
        Subscription::On => {
            format!("INSERT OR IGNORE INTO {table}({column}, member) VALUES (?1, ?2)")
        }
        Subscription::Off => format!("DELETE FROM {table} WHERE {column}=?1 AND member=?2"),
    };
    database.execute(&sql, params![id, member.as_str()])?;
    Ok(())
}
