use crate::Error;
use crate::Result;
use crate::TaskPackage;
use crate::TaskReceipt;
use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use protocol::ContentDigest;
use protocol::ThreadId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OutgoingTask {
    pub host: String,
    pub root: String,
    /// Original arguments are retained so retries cannot send a new code snapshot.
    pub request: String,
    pub package: TaskPackage,
}

pub struct Store(Mutex<Connection>);
impl Store {
    /// Bounded source links remain discoverable after a lost response or interrupted Turn. Read
    /// only metadata here: loading every saved object pack would make task listing unbounded.
    pub fn outgoing_links(&self, owner: &ThreadId) -> Result<serde_json::Value> {
        let db = self.0.lock().map_err(storage)?;
        let mut query = db
            .prepare(
                "SELECT id, json_extract(package,'$.host'),
            json_extract(package,'$.root'), json_extract(package,'$.package.title')
            FROM task_delivery_packages WHERE direction='out' AND owner=?1
            ORDER BY rowid DESC LIMIT 50",
            )
            .map_err(storage)?;
        let tasks = query
            .query_map([owner.as_str()], |row| {
                Ok(serde_json::json!({
                    "delivery_id": row.get::<_, String>(0)?, "host": row.get::<_, String>(1)?,
                    "root": row.get::<_, String>(2)?, "title": row.get::<_, String>(3)?
                }))
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        Ok(serde_json::json!({"tasks": tasks, "limit":50}))
    }
    pub fn open(path: &Path) -> Result<Self> {
        let mut db = state::open_sqlite_database(path, state::SqliteDurability::Durable)
            .map_err(Error::Storage)?;
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
            component TEXT PRIMARY KEY, version INTEGER NOT NULL);",
            )
            .map_err(storage)?;
        let version: Option<u32> = transaction
            .query_row(
                "SELECT version FROM ash_schema_migrations
            WHERE component='task-delivery'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        if version.is_some_and(|version| version != 1) {
            return Err(Error::Storage(
                "unsupported task-delivery storage version".into(),
            ));
        }
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_delivery_packages (
            direction TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL,
            package TEXT NOT NULL, receipt TEXT,
            PRIMARY KEY(direction, id));",
            )
            .map_err(storage)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO ash_schema_migrations(component,version)
            VALUES('task-delivery',1)",
                [],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(Self(Mutex::new(db)))
    }

    pub fn outgoing(&self, owner: &ThreadId, id: &ContentDigest) -> Result<OutgoingTask> {
        let json = self.0.lock().map_err(storage)?.query_row(
            "SELECT package FROM task_delivery_packages WHERE direction='out' AND id=?1 AND owner=?2",
            params![id.as_str(), owner.as_str()], |row| row.get::<_, String>(0))
            .optional().map_err(storage)?.ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&json)?)
    }

    /// Progress queries need only the saved route. Do not retain a potentially large code pack
    /// for the duration of each SSH query or let concurrent reads multiply its memory cost.
    pub(crate) fn outgoing_target(
        &self,
        owner: &ThreadId,
        id: &ContentDigest,
    ) -> Result<SshTarget> {
        let (host, root): (String, String) = self
            .0
            .lock()
            .map_err(storage)?
            .query_row(
                "SELECT json_extract(package,'$.host'), json_extract(package,'$.root')
            FROM task_delivery_packages WHERE direction='out' AND id=?1 AND owner=?2",
                params![id.as_str(), owner.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        Ok(SshTarget::new(
            SshHost::parse(&host).map_err(storage)?,
            RemoteDirPath::parse(&root).map_err(storage)?,
        ))
    }

    pub fn save_outgoing(&self, task: &OutgoingTask) -> Result<OutgoingTask> {
        task.package.validate()?;
        self.reserve(
            "out",
            &task.package.delivery_id,
            task.package.source.thread_id.as_str(),
            &serde_json::to_string(task)?,
        )?;
        self.outgoing(&task.package.source.thread_id, &task.package.delivery_id)
    }

    /// Reserve before any filesystem or history mutation. Replaying an identical package can
    /// finish a receive interrupted between worktree provisioning, Thread creation and enqueue.
    pub fn reserve_incoming(&self, package: &TaskPackage) -> Result<()> {
        package.validate()?;
        self.reserve(
            "in",
            &package.delivery_id,
            package.source.profile_id.as_str(),
            &serde_json::to_string(package)?,
        )
    }

    fn reserve(&self, direction: &str, id: &ContentDigest, owner: &str, json: &str) -> Result<()> {
        let db = self.0.lock().map_err(storage)?;
        db.execute(
            "INSERT OR IGNORE INTO task_delivery_packages(direction,id,owner,package)
            VALUES(?1,?2,?3,?4)",
            params![direction, id.as_str(), owner, json],
        )
        .map_err(storage)?;
        let saved: String = db
            .query_row(
                "SELECT package FROM task_delivery_packages
            WHERE direction=?1 AND id=?2",
                params![direction, id.as_str()],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if saved != json {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    pub fn accept(&self, receipt: &TaskReceipt) -> Result<()> {
        let db = self.0.lock().map_err(storage)?;
        let json = serde_json::to_string(receipt)?;
        let updated = db
            .execute(
                "UPDATE task_delivery_packages SET receipt=?1
            WHERE direction='in' AND id=?2 AND (receipt IS NULL OR receipt=?1)",
                params![json, receipt.delivery_id.as_str()],
            )
            .map_err(storage)?;
        if updated != 1 {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    pub fn receipt(&self, id: &ContentDigest) -> Result<Option<TaskReceipt>> {
        let json: Option<String> = self
            .0
            .lock()
            .map_err(storage)?
            .query_row(
                "SELECT receipt FROM task_delivery_packages WHERE direction='in' AND id=?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?
            .flatten();
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }
}
fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
