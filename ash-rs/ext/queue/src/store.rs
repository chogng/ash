use crate::Delivery;
use crate::QueueError;
use crate::QueueInput;
use crate::QueueStatus;
use crate::QueuedMessage;
use protocol::CommandId;
use protocol::SessionId;
use protocol::ThreadId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::path::Path;
use std::sync::Mutex;

pub struct QueueStore {
    connection: Mutex<Connection>,
    wake: std::sync::Condvar,
    signal: Mutex<u64>,
}

impl QueueStore {
    pub fn wake(&self) {
        let mut signal = self.signal.lock().expect("queue wake lock poisoned");
        *signal = signal.wrapping_add(1);
        self.wake.notify_all();
    }
    pub(crate) fn wait(&self, timeout: std::time::Duration) {
        let signal = self.signal.lock().expect("queue wake lock poisoned");
        let observed = *signal;
        drop(
            self.wake
                .wait_timeout_while(signal, timeout, |signal| *signal == observed)
                .expect("queue wake lock poisoned"),
        );
    }

    pub fn open(path: &Path) -> Result<Self, QueueError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS queue_metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO queue_metadata VALUES(1,2,0);")?;
        let version: u32 =
            transaction.query_row("SELECT version FROM queue_metadata WHERE id=1", [], |row| {
                row.get(0)
            })?;
        if !matches!(version, 1 | 2) {
            return Err(QueueError::Storage(format!(
                "unsupported queue schema {version}"
            )));
        }
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS queued_messages (
            position INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL,
            session_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            request TEXT NOT NULL,
            status TEXT NOT NULL,
            turn_id TEXT,
            error TEXT,
            revision INTEGER NOT NULL,
            lease_until INTEGER NOT NULL DEFAULT 0,
            ready_at INTEGER NOT NULL DEFAULT 0,
            sort_key INTEGER NOT NULL DEFAULT 0
        ); CREATE INDEX IF NOT EXISTS queue_thread ON queued_messages(thread_id,position);",
        )?;
        if version == 1 {
            // Queue requests are mutable records, unlike content-addressed Thread history.
            // Migrate only the permission field and preserve command identity and revision.
            transaction.execute_batch(
                "UPDATE queued_messages SET request=json_set(request,'$.approvalMode',
                    CASE json_extract(request,'$.approvalMode')
                        WHEN 'askPermissions' THEN 'manual' ELSE 'auto' END)
                    WHERE json_extract(request,'$.approvalMode') IN ('askPermissions','autoReview');
                 UPDATE queue_metadata SET version=2 WHERE id=1;",
            )?;
        }
        transaction.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
            wake: std::sync::Condvar::new(),
            signal: Mutex::new(0),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, QueueError> {
        self.connection
            .lock()
            .map_err(|_| QueueError::Storage("queue lock poisoned".into()))
    }

    pub fn delete_session(&self, session: &SessionId) -> Result<(), QueueError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction.execute(
            "DELETE FROM queued_messages WHERE session_id=?1",
            [session.as_str()],
        )? > 0
        {
            next_revision(&transaction)?;
        }
        transaction.commit()?;
        self.wake();
        Ok(())
    }

    pub fn get(&self, id: &CommandId) -> Result<Option<QueuedMessage>, QueueError> {
        read(&*self.lock()?, id)
    }

    pub fn edit(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        id: &CommandId,
        expected_revision: i64,
        edit: &crate::QueueEdit,
    ) -> Result<QueuedMessage, QueueError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut message = read(&transaction, id)?.ok_or(QueueError::NotFound)?;
        if &message.request.session_id != session || &message.request.thread_id != thread {
            return Err(QueueError::NotFound);
        }
        if message.revision != expected_revision {
            return Err(QueueError::Conflict);
        }
        if !matches!(
            message.status,
            QueueStatus::Pending | QueueStatus::Paused | QueueStatus::Rejected
        ) {
            return Err(QueueError::Busy);
        }
        let revision = next_revision(&transaction)?;
        let mut status = match message.status {
            QueueStatus::Paused => "paused",
            QueueStatus::Rejected => "rejected",
            _ => "pending",
        };
        match edit {
            crate::QueueEdit::Pause => status = "paused",
            crate::QueueEdit::Replace { input } => {
                if message.status != QueueStatus::Paused || input.is_empty() {
                    return Err(QueueError::Invalid(
                        "pause the message before editing".into(),
                    ));
                }
                message.request.input = input.clone();
                message.request.steer_turn = None;
                status = "pending";
            }
            crate::QueueEdit::Send { turn_id } => {
                message.request.steer_turn = turn_id.clone();
                status = "pending";
                let first: i64 = transaction.query_row(
                    "SELECT min(sort_key) FROM queued_messages WHERE thread_id=?1",
                    [thread.as_str()],
                    |row| row.get(0),
                )?;
                transaction.execute(
                    "UPDATE queued_messages SET sort_key=?2 WHERE id=?1",
                    params![
                        id.as_str(),
                        first.checked_sub(1).ok_or_else(|| QueueError::Storage(
                            "queue ordering exhausted".into()
                        ))?
                    ],
                )?;
            }
            crate::QueueEdit::Move { direction } => {
                let position: i64 = transaction.query_row(
                    "SELECT sort_key FROM queued_messages WHERE id=?1",
                    [id.as_str()],
                    |row| row.get(0),
                )?;
                let query = match direction {
                    crate::QueueMove::Up => {
                        "SELECT id,sort_key FROM queued_messages WHERE thread_id=?1 AND sort_key<?2 AND status IN ('pending','paused','rejected') ORDER BY sort_key DESC LIMIT 1"
                    }
                    crate::QueueMove::Down => {
                        "SELECT id,sort_key FROM queued_messages WHERE thread_id=?1 AND sort_key>?2 AND status IN ('pending','paused','rejected') ORDER BY sort_key LIMIT 1"
                    }
                };
                if let Some((other, key)) = transaction
                    .query_row(query, params![thread.as_str(), position], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .optional()?
                {
                    transaction.execute(
                        "UPDATE queued_messages SET sort_key=?2,revision=?3 WHERE id=?1",
                        params![other, position, revision],
                    )?;
                    transaction.execute(
                        "UPDATE queued_messages SET sort_key=?2 WHERE id=?1",
                        params![id.as_str(), key],
                    )?;
                }
            }
        }
        let encoded = serde_json::to_string(&message.request)?;
        if encoded.len() > 1024 * 1024 {
            return Err(QueueError::Invalid("input exceeds 1 MiB".into()));
        }
        transaction.execute("UPDATE queued_messages SET request=?2,status=?3,revision=?4,error=NULL,ready_at=0 WHERE id=?1", params![id.as_str(),encoded,status,revision])?;
        let result = read(&transaction, id)?.ok_or(QueueError::NotFound)?;
        transaction.commit()?;
        self.wake();
        Ok(result)
    }

    pub fn enqueue(&self, input: &QueueInput) -> Result<QueuedMessage, QueueError> {
        let encoded = serde_json::to_string(input)?;
        if input.command_id.as_str().len() > 128
            || input.input.is_empty()
            || input.directory.is_empty()
            || encoded.len() > 1024 * 1024
        {
            return Err(QueueError::Invalid(
                "input must be nonempty and at most 1 MiB".into(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = read(&transaction, &input.command_id)? {
            return if existing.request == *input {
                Ok(existing)
            } else {
                Err(QueueError::Conflict)
            };
        }
        let count: i64 = transaction.query_row("SELECT count(*) FROM queued_messages WHERE thread_id=?1 AND status IN ('pending','paused','rejected','delivering')", [input.thread_id.as_str()], |row| row.get(0))?;
        if count >= 128 {
            return Err(QueueError::Invalid(
                "a Thread can retain at most 128 pending messages".into(),
            ));
        }
        let revision = next_revision(&transaction)?;
        transaction.execute("INSERT INTO queued_messages(id,session_id,thread_id,request,status,revision) VALUES(?1,?2,?3,?4,'pending',?5)",
            params![input.command_id.as_str(), input.session_id.as_str(), input.thread_id.as_str(), encoded, revision])?;
        transaction.execute(
            "UPDATE queued_messages SET sort_key=position WHERE id=?1",
            [input.command_id.as_str()],
        )?;
        let result = read(&transaction, &input.command_id)?.ok_or(QueueError::NotFound)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn list(
        &self,
        session: &SessionId,
        thread: &ThreadId,
    ) -> Result<Vec<QueuedMessage>, QueueError> {
        let connection = self.lock()?;
        // Terminal delivery receipts stay durable for deduplication; views show the latest 128.
        let mut statement = connection.prepare("SELECT id FROM (SELECT id,sort_key FROM queued_messages WHERE session_id=?1 AND thread_id=?2 ORDER BY CASE WHEN status IN ('pending','paused','rejected','delivering') THEN 0 ELSE 1 END, position DESC LIMIT 256) ORDER BY sort_key")?;
        let ids = statement
            .query_map(params![session.as_str(), thread.as_str()], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| read_id(&connection, &id)?.ok_or(QueueError::NotFound))
            .collect()
    }

    pub fn revision(&self) -> Result<i64, QueueError> {
        Ok(self.lock()?.query_row(
            "SELECT revision FROM queue_metadata WHERE id=1",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn needs_host(&self) -> Result<bool, QueueError> {
        Ok(self.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM queued_messages WHERE status IN ('pending','delivering'))",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn cancel(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        id: &CommandId,
    ) -> Result<QueuedMessage, QueueError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let message = read(&transaction, id)?.ok_or(QueueError::NotFound)?;
        if &message.request.session_id != session || &message.request.thread_id != thread {
            return Err(QueueError::NotFound);
        }
        match message.status {
            QueueStatus::Cancelled => return Ok(message),
            QueueStatus::Delivering | QueueStatus::Started => return Err(QueueError::Busy),
            QueueStatus::Rejected | QueueStatus::Paused | QueueStatus::Pending => {}
        }
        let revision = next_revision(&transaction)?;
        transaction.execute(
            "UPDATE queued_messages SET status='cancelled', revision=?2 WHERE id=?1",
            params![id.as_str(), revision],
        )?;
        let result = read(&transaction, id)?.ok_or(QueueError::NotFound)?;
        transaction.commit()?;
        Ok(result)
    }

    pub(crate) fn candidates(&self, now: i64) -> Result<Vec<QueuedMessage>, QueueError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare("SELECT id FROM queued_messages q WHERE
            ((status='pending' AND ready_at<=?1) OR (status='delivering' AND lease_until<=?1))
            AND NOT EXISTS (SELECT 1 FROM queued_messages older WHERE older.thread_id=q.thread_id AND older.sort_key<q.sort_key AND older.status IN ('pending','paused','delivering'))
            ORDER BY sort_key LIMIT 128")?;
        let ids = statement
            .query_map([now], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| read_id(&connection, &id)?.ok_or(QueueError::NotFound))
            .collect()
    }

    pub(crate) fn claim(
        &self,
        message: &QueuedMessage,
        now: i64,
    ) -> Result<Option<QueuedMessage>, QueueError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute("UPDATE queued_messages SET status='delivering', lease_until=?3 WHERE id=?1 AND revision=?2 AND ((status='pending' AND ready_at<=?4) OR (status='delivering' AND lease_until<=?4))",
            params![message.request.command_id.as_str(), message.revision, now.saturating_add(60_000), now])?;
        if changed == 0 {
            return Ok(None);
        }
        let revision = next_revision(&transaction)?;
        transaction.execute(
            "UPDATE queued_messages SET revision=?2 WHERE id=?1",
            params![message.request.command_id.as_str(), revision],
        )?;
        let result = read(&transaction, &message.request.command_id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub(crate) fn finish(
        &self,
        message: &QueuedMessage,
        delivery: &Delivery,
        now: i64,
    ) -> Result<(), QueueError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (status, turn, error) = match delivery {
            Delivery::Waiting => ("pending", None, None),
            Delivery::Started(id) => ("started", Some(id.as_str()), None),
            Delivery::Rejected(reason) => ("rejected", None, Some(reason.as_str())),
        };
        let changed = transaction.execute("UPDATE queued_messages SET status=?3,turn_id=?4,error=?5,lease_until=0,ready_at=?6 WHERE id=?1 AND revision=?2 AND status='delivering'",
            params![message.request.command_id.as_str(), message.revision, status, turn, error, now.saturating_add(500)])?;
        if changed == 1 {
            let revision = next_revision(&transaction)?;
            transaction.execute(
                "UPDATE queued_messages SET revision=?2 WHERE id=?1",
                params![message.request.command_id.as_str(), revision],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

fn next_revision(connection: &Connection) -> Result<i64, QueueError> {
    connection.execute(
        "UPDATE queue_metadata SET revision=revision+1 WHERE id=1",
        [],
    )?;
    Ok(connection.query_row(
        "SELECT revision FROM queue_metadata WHERE id=1",
        [],
        |row| row.get(0),
    )?)
}
fn read(connection: &Connection, id: &CommandId) -> Result<Option<QueuedMessage>, QueueError> {
    read_id(connection, id.as_str())
}
fn read_id(connection: &Connection, id: &str) -> Result<Option<QueuedMessage>, QueueError> {
    let row = connection
        .query_row(
            "SELECT request,status,turn_id,error,revision FROM queued_messages WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(request, status, turn, error, revision)| {
        Ok(QueuedMessage {
            request: serde_json::from_str(&request)?,
            status: match status.as_str() {
                "pending" => QueueStatus::Pending,
                "paused" => QueueStatus::Paused,
                "delivering" => QueueStatus::Delivering,
                "started" => QueueStatus::Started,
                "rejected" => QueueStatus::Rejected,
                "cancelled" => QueueStatus::Cancelled,
                _ => return Err(QueueError::Storage("unknown queue status".into())),
            },
            turn_id: turn
                .map(protocol::TurnId::new)
                .transpose()
                .map_err(|error| QueueError::Storage(format!("{error}")))?,
            error,
            revision,
        })
    })
    .transpose()
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
