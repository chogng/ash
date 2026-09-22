use crate::model::Plan;
use crate::model::Work;
use core_api::CoreError;
use protocol::CommandId;
use protocol::SessionId;
use protocol::ThreadId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use std::path::Path;
use std::sync::Mutex;

/// Durable workflow artifacts and command receipts, separate from model-editable workspace files.
pub struct Store {
    database: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, CoreError> {
        Self::initialize(
            state::open_sqlite_database(path, state::SqliteDurability::Durable)
                .map_err(CoreError::Journal)?,
        )
    }
    pub fn in_memory() -> Result<Self, CoreError> {
        Self::initialize(
            state::open_in_memory_database(state::SqliteDurability::Durable)
                .map_err(CoreError::Journal)?,
        )
    }
    fn initialize(database: Connection) -> Result<Self, CoreError> {
        database.execute_batch("CREATE TABLE IF NOT EXISTS agent_workflows (session TEXT NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root));
            CREATE TABLE IF NOT EXISTS agent_workflow_commands (session TEXT NOT NULL, root TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, plan TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session, root, command));").map_err(journal)?;
        Ok(Self {
            database: Mutex::new(database),
        })
    }
    pub(crate) fn commit(
        &self,
        session: &SessionId,
        root: &ThreadId,
        command: &CommandId,
        request: &str,
        prepare: impl FnOnce(Option<Work>) -> Result<Plan, CoreError>,
    ) -> Result<Plan, CoreError> {
        let mut database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let transaction = database
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(journal)?;
        let existing: Option<(String, String)> = transaction.query_row("SELECT request, plan FROM agent_workflow_commands WHERE session=?1 AND root=?2 AND command=?3", params![session.as_str(), root.as_str(), command.as_str()], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(journal)?;
        if let Some((previous, plan)) = existing {
            if previous != request {
                return Err(CoreError::CommandConflict);
            }
            return serde_json::from_str(&plan).map_err(journal);
        }
        let pending: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM agent_workflow_commands WHERE session=?1 AND root=?2 AND finished<2)", params![session.as_str(), root.as_str()], |row| row.get(0)).map_err(journal)?;
        if pending {
            return Err(CoreError::InvalidInput("A workflow command is still being committed; resume it before issuing another command".into()));
        }
        let previous: Option<String> = transaction
            .query_row(
                "SELECT state FROM agent_workflows WHERE session=?1 AND root=?2",
                params![session.as_str(), root.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(journal)?;
        let work = previous
            .map(|previous| serde_json::from_str(&previous))
            .transpose()
            .map_err(journal)?;
        let plan = prepare(work)?;
        transaction.execute("INSERT INTO agent_workflow_commands(session, root, command, request, plan) VALUES (?1, ?2, ?3, ?4, ?5)", params![session.as_str(), root.as_str(), command.as_str(), request, serde_json::to_string(&plan).map_err(journal)?]).map_err(journal)?;
        transaction.commit().map_err(journal)?;
        Ok(plan)
    }
    pub(crate) fn activate(
        &self,
        session: &SessionId,
        root: &ThreadId,
        plan: &Plan,
    ) -> Result<(), CoreError> {
        let mut database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let transaction = database.transaction().map_err(journal)?;
        transaction.execute("INSERT INTO agent_workflows(session, root, state) VALUES (?1, ?2, ?3) ON CONFLICT(session, root) DO UPDATE SET state=excluded.state", params![session.as_str(), root.as_str(), serde_json::to_string(&plan.transition.work).map_err(journal)?]).map_err(journal)?;
        transaction.execute("UPDATE agent_workflow_commands SET plan=?3, finished=1 WHERE root=?1 AND command=?2", params![root.as_str(), plan.submission.command_id.as_str(), serde_json::to_string(plan).map_err(journal)?]).map_err(journal)?;
        transaction.commit().map_err(journal)
    }
    pub(crate) fn abort(&self, root: &ThreadId, command: &CommandId) -> Result<(), CoreError> {
        self.database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?
            .execute(
                "DELETE FROM agent_workflow_commands WHERE root=?1 AND command=?2 AND finished=0",
                params![root.as_str(), command.as_str()],
            )
            .map_err(journal)?;
        Ok(())
    }
    pub(crate) fn finish(
        &self,
        root: &ThreadId,
        turn: &protocol::TurnId,
        sequence: u64,
    ) -> Result<(), CoreError> {
        let sequence = i64::try_from(sequence).map_err(journal)?;
        self.database.lock().map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?.execute("UPDATE agent_workflow_commands SET finished=2, plan=json_set(plan, '$.response_sequence', ?3) WHERE root=?1 AND json_extract(plan, '$.turn')=?2", params![root.as_str(), turn.as_str(), sequence]).map_err(journal)?;
        Ok(())
    }
    pub(crate) fn pending(&self) -> Result<Vec<(ThreadId, Plan)>, CoreError> {
        let database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let mut statement = database
            .prepare(
                "SELECT root, plan FROM agent_workflow_commands WHERE finished<2 ORDER BY rowid",
            )
            .map_err(journal)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(journal)?;
        rows.map(|row| {
            let (root, plan) = row.map_err(journal)?;
            Ok((
                ThreadId::new(root).map_err(journal)?,
                serde_json::from_str(&plan).map_err(journal)?,
            ))
        })
        .collect()
    }
    pub fn delete_session(&self, session: &SessionId) -> Result<(), CoreError> {
        let mut database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let transaction = database.transaction().map_err(journal)?;
        transaction
            .execute(
                "DELETE FROM agent_workflow_commands WHERE session=?1",
                [session.as_str()],
            )
            .map_err(journal)?;
        transaction
            .execute(
                "DELETE FROM agent_workflows WHERE session=?1",
                [session.as_str()],
            )
            .map_err(journal)?;
        transaction.commit().map_err(journal)
    }
}

pub(crate) fn journal(error: impl std::fmt::Display) -> CoreError {
    CoreError::Journal(error.to_string())
}
