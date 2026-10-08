use crate::model::Plan;
use crate::model::Work;
use crate::parallel::ParallelBindingIntent;
use crate::parallel::ParallelCommandReceipt;
use crate::parallel::ParallelDevelopment;
use crate::parallel::ParallelMutation;
use crate::parallel::ParallelMutationOutcome;
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
    fn initialize(mut database: Connection) -> Result<Self, CoreError> {
        database.execute_batch("CREATE TABLE IF NOT EXISTS agent_workflows (session TEXT NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root));
            CREATE TABLE IF NOT EXISTS agent_workflow_commands (session TEXT NOT NULL, root TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, plan TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session, root, command));
            CREATE TABLE IF NOT EXISTS agent_parallel_developments (session TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL, created_order INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root, run_id));
            CREATE TABLE IF NOT EXISTS agent_parallel_commands (session TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(session, root, run_id, command));
            CREATE TABLE IF NOT EXISTS agent_parallel_bindings (session TEXT NOT NULL, root TEXT NOT NULL, delegation TEXT NOT NULL, intent TEXT NOT NULL, PRIMARY KEY(session, root, delegation));").map_err(journal)?;
        migrate_parallel_tables(&mut database)?;
        // Run-keyed prototypes allowed the same command id on different runs; only request-matched
        // start retries can safely identify a receipt across runs.
        database
            .execute("DROP INDEX IF EXISTS agent_parallel_command_identity", [])
            .map_err(journal)?;
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

    /// Creates a parallel development run with a durable command receipt.
    pub fn create_parallel_development(
        &self,
        session: &SessionId,
        root: &ThreadId,
        command: &CommandId,
        mut development: ParallelDevelopment,
    ) -> Result<ParallelCommandReceipt, CoreError> {
        let request_key = development.creation_request_key()?;
        validate_parallel_request(&request_key)?;
        let run_id = development.run_id().to_owned();
        let mut database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let transaction = database
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(journal)?;
        if let Some(receipt) = parallel_command_receipt(
            &transaction,
            session,
            root,
            &run_id,
            command,
            &request_key,
            ParallelCommandKind::Create,
        )? {
            return Ok(receipt);
        }
        let existing_runs: Vec<String> = {
            let mut statement = transaction
                .prepare(
                    "SELECT state FROM agent_parallel_developments WHERE session=?1 AND root=?2",
                )
                .map_err(journal)?;
            let rows = statement
                .query_map(params![session.as_str(), root.as_str()], |row| row.get(0))
                .map_err(journal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(journal)?
        };
        for encoded in existing_runs {
            let previous: ParallelDevelopment = serde_json::from_str(&encoded).map_err(journal)?;
            previous.validate()?;
            if previous.status() != crate::parallel::ParallelStatus::Cancelled
                && previous.status() != crate::parallel::ParallelStatus::Published
            {
                return Err(CoreError::InvalidInput(
                    "A parallel development run is still active; resume or cancel it before starting another".into(),
                ));
            }
        }
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_parallel_developments WHERE session=?1 AND root=?2 AND run_id=?3)",
                params![session.as_str(), root.as_str(), run_id],
                |row| row.get(0),
            )
            .map_err(journal)?;
        if exists {
            return Err(CoreError::CommandConflict);
        }
        development.set_revision(1);
        development.validate()?;
        let created_order: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(created_order), 0) + 1 FROM agent_parallel_developments WHERE session=?1 AND root=?2",
                params![session.as_str(), root.as_str()],
                |row| row.get(0),
            )
            .map_err(journal)?;
        let encoded = serde_json::to_string(&development).map_err(journal)?;
        let receipt = ParallelCommandReceipt {
            development: development.clone(),
            outcome: ParallelMutationOutcome::Created,
            replayed: false,
        };
        let stored_receipt = serde_json::to_string(&receipt).map_err(journal)?;
        transaction
            .execute(
                "INSERT INTO agent_parallel_developments(session, root, run_id, created_order, state) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session.as_str(), root.as_str(), run_id, created_order, encoded],
            )
            .map_err(journal)?;
        transaction
            .execute(
                "INSERT INTO agent_parallel_commands(session, root, run_id, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![session.as_str(), root.as_str(), run_id, command.as_str(), request_key, stored_receipt],
            )
            .map_err(journal)?;
        transaction.commit().map_err(journal)?;
        Ok(receipt)
    }

    /// Applies one idempotent domain command using revision compare-and-swap.
    ///
    /// Applies only the domain mutation while the SQLite write transaction is open. Core, Git,
    /// process, and network side effects need durable intent and receipt reconciliation outside it.
    pub fn mutate_parallel_development(
        &self,
        session: &SessionId,
        root: &ThreadId,
        run_id: &str,
        command: &CommandId,
        expected_revision: u64,
        mutation: ParallelMutation,
    ) -> Result<ParallelCommandReceipt, CoreError> {
        let request_key =
            serde_json::to_string(&(run_id, expected_revision, &mutation)).map_err(journal)?;
        validate_parallel_request(&request_key)?;
        let mut database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let transaction = database
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(journal)?;
        if let Some(receipt) = parallel_command_receipt(
            &transaction,
            session,
            root,
            run_id,
            command,
            &request_key,
            ParallelCommandKind::Mutation,
        )? {
            return Ok(receipt);
        }
        let encoded: String = transaction
            .query_row(
                "SELECT state FROM agent_parallel_developments WHERE session=?1 AND root=?2 AND run_id=?3",
                params![session.as_str(), root.as_str(), run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(journal)?
            .ok_or_else(|| CoreError::NotFound("parallel development".into()))?;
        let mut development: ParallelDevelopment =
            serde_json::from_str(&encoded).map_err(journal)?;
        if development.revision() != expected_revision {
            return Err(invalid_revision());
        }
        let outcome = mutation.apply(&mut development)?;
        let next_revision = development
            .revision()
            .checked_add(1)
            .ok_or_else(|| journal("parallel development revision overflow"))?;
        development.set_revision(next_revision);
        development.validate()?;
        let encoded = serde_json::to_string(&development).map_err(journal)?;
        let receipt = ParallelCommandReceipt {
            development: development.clone(),
            outcome,
            replayed: false,
        };
        let stored_receipt = serde_json::to_string(&receipt).map_err(journal)?;
        transaction
            .execute(
                "UPDATE agent_parallel_developments SET state=?4 WHERE session=?1 AND root=?2 AND run_id=?3",
                params![session.as_str(), root.as_str(), run_id, encoded],
            )
            .map_err(journal)?;
        transaction
            .execute(
                "INSERT INTO agent_parallel_commands(session, root, run_id, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![session.as_str(), root.as_str(), run_id, command.as_str(), request_key, stored_receipt],
            )
            .map_err(journal)?;
        transaction.commit().map_err(journal)?;
        Ok(receipt)
    }

    pub fn read_parallel_development(
        &self,
        session: &SessionId,
        root: &ThreadId,
        run_id: &str,
    ) -> Result<ParallelDevelopment, CoreError> {
        let database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let encoded: String = database
            .query_row(
                "SELECT state FROM agent_parallel_developments WHERE session=?1 AND root=?2 AND run_id=?3",
                params![session.as_str(), root.as_str(), run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(journal)?
            .ok_or_else(|| CoreError::NotFound("parallel development".into()))?;
        let development: ParallelDevelopment = serde_json::from_str(&encoded).map_err(journal)?;
        development.validate()?;
        Ok(development)
    }

    /// Returns runs in creation order so a reconnecting client can discover the latest run.
    pub fn list_parallel_developments(
        &self,
        session: &SessionId,
        root: &ThreadId,
    ) -> Result<Vec<ParallelDevelopment>, CoreError> {
        let database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let mut statement = database
            .prepare(
                "SELECT state FROM agent_parallel_developments WHERE session=?1 AND root=?2 ORDER BY created_order",
            )
            .map_err(journal)?;
        let rows = statement
            .query_map(params![session.as_str(), root.as_str()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(journal)?;
        rows.map(|row| {
            let development: ParallelDevelopment =
                serde_json::from_str(&row.map_err(journal)?).map_err(journal)?;
            development.validate()?;
            Ok(development)
        })
        .collect()
    }

    pub fn read_latest_parallel_development(
        &self,
        session: &SessionId,
        root: &ThreadId,
    ) -> Result<ParallelDevelopment, CoreError> {
        self.list_parallel_developments(session, root)?
            .pop()
            .ok_or_else(|| CoreError::NotFound("parallel development".into()))
    }

    /// Persists an immutable source binding before Core creates a delegated Thread.
    /// Replaying the same delegation is safe only when the full intent is identical.
    pub fn put_parallel_binding_intent(
        &self,
        session: &SessionId,
        root: &ThreadId,
        delegation: &protocol::DelegationId,
        intent: &ParallelBindingIntent,
    ) -> Result<(), CoreError> {
        intent.validate()?;
        validate_parallel_request(&serde_json::to_string(intent).map_err(journal)?)?;
        let encoded = serde_json::to_string(intent).map_err(journal)?;
        let database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let run_state: Option<String> = database
            .query_row(
                "SELECT state FROM agent_parallel_developments WHERE session=?1 AND root=?2 AND run_id=?3",
                params![session.as_str(), root.as_str(), intent.run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(journal)?;
        let run_state =
            run_state.ok_or_else(|| CoreError::NotFound("parallel development".into()))?;
        let run: ParallelDevelopment = serde_json::from_str(&run_state).map_err(journal)?;
        run.validate()?;
        let task = run.task(&intent.task_id)?;
        if intent.target_oid != run.target().expected_oid {
            return Err(CoreError::Policy(
                "parallel binding target differs from its frozen run target".into(),
            ));
        }
        let primary_tree = intent
            .repository_trees
            .get(".")
            .expect("validated parallel binding has primary tree");
        let matches_candidate = task.snapshots().iter().any(|snapshot| {
            snapshot.snapshot_id == intent.snapshot_id
                && snapshot.digest == intent.snapshot_digest
                && snapshot.candidate_tree == *primary_tree
                && snapshot.source_thread == intent.source_thread
        });
        let matches_baseline = intent.snapshot_id == "baseline"
            && intent.source_thread == *root
            && intent.snapshot_digest == run.baseline_digest()?
            && primary_tree == run.baseline_tree();
        if !matches_candidate && !matches_baseline {
            return Err(CoreError::Policy(
                "parallel binding intent does not match a durable candidate or baseline".into(),
            ));
        }
        let previous: Option<String> = database
            .query_row(
                "SELECT intent FROM agent_parallel_bindings WHERE session=?1 AND root=?2 AND delegation=?3",
                params![session.as_str(), root.as_str(), delegation.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(journal)?;
        if let Some(previous) = previous {
            if previous != encoded {
                return Err(CoreError::CommandConflict);
            }
            return Ok(());
        }
        database
            .execute(
                "INSERT INTO agent_parallel_bindings(session, root, delegation, intent) VALUES (?1, ?2, ?3, ?4)",
                params![session.as_str(), root.as_str(), delegation.as_str(), encoded],
            )
            .map_err(journal)?;
        Ok(())
    }

    pub fn read_parallel_binding_intent(
        &self,
        session: &SessionId,
        root: &ThreadId,
        delegation: &protocol::DelegationId,
    ) -> Result<Option<ParallelBindingIntent>, CoreError> {
        let database = self
            .database
            .lock()
            .map_err(|_| CoreError::Journal("Workflow store lock poisoned".into()))?;
        let encoded = database
            .query_row(
                "SELECT intent FROM agent_parallel_bindings WHERE session=?1 AND root=?2 AND delegation=?3",
                params![session.as_str(), root.as_str(), delegation.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(journal)?;
        encoded
            .map(|encoded| {
                let intent: ParallelBindingIntent =
                    serde_json::from_str(&encoded).map_err(journal)?;
                intent.validate()?;
                Ok(intent)
            })
            .transpose()
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
        transaction
            .execute(
                "DELETE FROM agent_parallel_commands WHERE session=?1",
                [session.as_str()],
            )
            .map_err(journal)?;
        transaction
            .execute(
                "DELETE FROM agent_parallel_bindings WHERE session=?1",
                [session.as_str()],
            )
            .map_err(journal)?;
        transaction
            .execute(
                "DELETE FROM agent_parallel_developments WHERE session=?1",
                [session.as_str()],
            )
            .map_err(journal)?;
        transaction.commit().map_err(journal)
    }
}

#[derive(Clone, Copy)]
enum ParallelCommandKind {
    Create,
    Mutation,
}

fn parallel_command_receipt(
    transaction: &rusqlite::Transaction<'_>,
    session: &SessionId,
    root: &ThreadId,
    run_id: &str,
    command: &CommandId,
    request: &str,
    kind: ParallelCommandKind,
) -> Result<Option<ParallelCommandReceipt>, CoreError> {
    let previous: Vec<(String, String)> = match kind {
        ParallelCommandKind::Create => {
            // The run id is regenerated by a retried start, so match its canonical request below.
            let mut statement = transaction
                .prepare(
                    "SELECT request, receipt FROM agent_parallel_commands WHERE session=?1 AND root=?2 AND command=?3",
                )
                .map_err(journal)?;
            let rows = statement
                .query_map(
                    params![session.as_str(), root.as_str(), command.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(journal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(journal)?
        }
        ParallelCommandKind::Mutation => transaction
            .query_row(
                "SELECT request, receipt FROM agent_parallel_commands WHERE session=?1 AND root=?2 AND run_id=?3 AND command=?4",
                params![session.as_str(), root.as_str(), run_id, command.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(journal)?
            .into_iter()
            .collect(),
    };
    let matching: Vec<_> = previous
        .iter()
        .filter(|(previous_request, _)| previous_request == request)
        .collect();
    let (_, receipt) = match matching.as_slice() {
        [] if previous.is_empty() => return Ok(None),
        [] => return Err(CoreError::CommandConflict),
        [receipt] => receipt,
        _ => {
            return Err(CoreError::InvalidInput(
                "More than one historical parallel command receipt matches this command and request; choose a new command id".into(),
            ));
        }
    };
    let value: serde_json::Value = serde_json::from_str(&receipt).map_err(journal)?;
    if let Ok(mut receipt) = serde_json::from_value::<ParallelCommandReceipt>(value.clone()) {
        receipt.replayed = true;
        return Ok(Some(receipt));
    }
    let development = serde_json::from_value(value).map_err(journal)?;
    let outcome = match kind {
        ParallelCommandKind::Create => ParallelMutationOutcome::Created,
        ParallelCommandKind::Mutation => ParallelMutationOutcome::Applied,
    };
    Ok(Some(ParallelCommandReceipt {
        development,
        outcome,
        replayed: true,
    }))
}

fn validate_parallel_request(request: &str) -> Result<(), CoreError> {
    if request.is_empty() || request.len() > 128 * 1024 {
        return Err(CoreError::InvalidInput(
            "Parallel command request must contain 1 to 131072 bytes".into(),
        ));
    }
    Ok(())
}

/// Preserve prototype records while adding stable run identity and creation order. Rowid is used
/// only once to migrate the old table's insertion order; runtime reads use the stored sequence.
fn migrate_parallel_tables(database: &mut Connection) -> Result<(), CoreError> {
    let has_run_id = table_has_column(database, "agent_parallel_developments", "run_id")?;
    let has_created_order =
        table_has_column(database, "agent_parallel_developments", "created_order")?;
    if !has_run_id || !has_created_order {
        let transaction = database.transaction().map_err(journal)?;
        let rows: Vec<(String, String, Option<String>, String)> = if has_run_id {
            let mut statement = transaction
                .prepare(
                    "SELECT session, root, run_id, state FROM agent_parallel_developments ORDER BY rowid",
                )
                .map_err(journal)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, Some(row.get(2)?), row.get(3)?))
                })
                .map_err(journal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(journal)?
        } else {
            let mut statement = transaction
                .prepare(
                    "SELECT session, root, state FROM agent_parallel_developments ORDER BY rowid",
                )
                .map_err(journal)?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, None, row.get(2)?)))
                .map_err(journal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(journal)?
        };
        transaction
            .execute_batch(
                "ALTER TABLE agent_parallel_developments RENAME TO agent_parallel_developments_v1;
                 CREATE TABLE agent_parallel_developments (
                     session TEXT NOT NULL,
                     root TEXT NOT NULL,
                     run_id TEXT NOT NULL,
                     created_order INTEGER NOT NULL,
                     state TEXT NOT NULL,
                     PRIMARY KEY(session, root, run_id)
                 );",
            )
            .map_err(journal)?;
        let mut orders = std::collections::HashMap::<(String, String), i64>::new();
        for (session, root, previous_run_id, state) in rows {
            let development: ParallelDevelopment = serde_json::from_str(&state).map_err(journal)?;
            let run_id = previous_run_id.unwrap_or_else(|| development.run_id().to_owned());
            if run_id != development.run_id() {
                return Err(journal(
                    "parallel development run id did not match its stored state during migration",
                ));
            }
            let key = (session.clone(), root.clone());
            let order = orders.entry(key).or_default();
            *order = order
                .checked_add(1)
                .ok_or_else(|| journal("parallel development creation order overflow"))?;
            transaction
                .execute(
                    "INSERT INTO agent_parallel_developments(session, root, run_id, created_order, state) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![session, root, run_id, *order, state],
                )
                .map_err(journal)?;
        }
        transaction
            .execute_batch("DROP TABLE agent_parallel_developments_v1;")
            .map_err(journal)?;
        transaction.commit().map_err(journal)?;
    }

    let has_command_run_id = table_has_column(database, "agent_parallel_commands", "run_id")?;
    if !has_command_run_id {
        let transaction = database.transaction().map_err(journal)?;
        let rows: Vec<(String, String, String, String, String)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT session, root, command, request, receipt FROM agent_parallel_commands ORDER BY rowid",
                )
                .map_err(journal)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })
                .map_err(journal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(journal)?
        };
        transaction
            .execute_batch(
                "ALTER TABLE agent_parallel_commands RENAME TO agent_parallel_commands_v1;
                 CREATE TABLE agent_parallel_commands (
                     session TEXT NOT NULL,
                     root TEXT NOT NULL,
                     run_id TEXT NOT NULL,
                     command TEXT NOT NULL,
                     request TEXT NOT NULL,
                     receipt TEXT NOT NULL,
                     PRIMARY KEY(session, root, run_id, command)
                 );",
            )
            .map_err(journal)?;
        for (session, root, command, request, receipt) in rows {
            let development = development_from_receipt(&receipt)?;
            let run_id = development.run_id().to_owned();
            let request = normalize_legacy_parallel_request(&request, &run_id)?;
            transaction
                .execute(
                    "INSERT INTO agent_parallel_commands(session, root, run_id, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![session, root, run_id, command, request, receipt],
                )
                .map_err(journal)?;
        }
        transaction
            .execute_batch("DROP TABLE agent_parallel_commands_v1;")
            .map_err(journal)?;
        transaction.commit().map_err(journal)?;
    } else {
        // Earlier run-keyed versions stored a serialized creation request containing the generated
        // run id. Normalize those keys so a retry using the current canonical key replays its receipt.
        let transaction = database.transaction().map_err(journal)?;
        let rows: Vec<(String, String, String, String, String)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT session, root, run_id, command, request FROM agent_parallel_commands ORDER BY rowid",
                )
                .map_err(journal)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })
                .map_err(journal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(journal)?
        };
        for (session, root, run_id, command, request) in rows {
            let normalized = normalize_legacy_parallel_request(&request, &run_id)?;
            if normalized != request {
                transaction
                    .execute(
                        "UPDATE agent_parallel_commands SET request=?5 WHERE session=?1 AND root=?2 AND run_id=?3 AND command=?4",
                        params![session, root, run_id, command, normalized],
                    )
                    .map_err(journal)?;
            }
        }
        transaction.commit().map_err(journal)?;
    }
    Ok(())
}

fn development_from_receipt(receipt: &str) -> Result<ParallelDevelopment, CoreError> {
    let value: serde_json::Value = serde_json::from_str(receipt).map_err(journal)?;
    if let Ok(receipt) = serde_json::from_value::<ParallelCommandReceipt>(value.clone()) {
        return Ok(receipt.development);
    }
    serde_json::from_value(value).map_err(journal)
}

fn normalize_legacy_parallel_request(request: &str, run_id: &str) -> Result<String, CoreError> {
    if let Ok(development) = serde_json::from_str::<ParallelDevelopment>(request) {
        return development.creation_request_key();
    }
    if let Ok((expected_revision, mutation)) =
        serde_json::from_str::<(u64, ParallelMutation)>(request)
    {
        return serde_json::to_string(&(run_id, expected_revision, mutation)).map_err(journal);
    }
    if let Ok((request_run_id, expected_revision, mutation)) =
        serde_json::from_str::<(String, u64, ParallelMutation)>(request)
        && request_run_id == run_id
    {
        return serde_json::to_string(&(request_run_id, expected_revision, mutation))
            .map_err(journal);
    }
    Ok(request.to_owned())
}

fn table_has_column(database: &Connection, table: &str, column: &str) -> Result<bool, CoreError> {
    // Table names are internal constants at each call site, never user input.
    let mut statement = database
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(journal)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(journal)?;
    for name in columns {
        if name.map_err(journal)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn invalid_revision() -> CoreError {
    CoreError::InvalidInput("Parallel development revision changed; refresh before retrying".into())
}

pub(crate) fn journal(error: impl std::fmt::Display) -> CoreError {
    CoreError::Journal(error.to_string())
}
