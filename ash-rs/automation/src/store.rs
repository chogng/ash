use crate::AutomationError;
use crate::next_occurrence;
use crate::validate_definition;
use ash_protocol::Automation;
use ash_protocol::AutomationDefinition;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use ash_protocol::AutomationSchedule;
use ash_protocol::AutomationStatus;
use ash_protocol::UnixMillis;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

/// A version-checked plan write. Revision zero creates a plan; every write has a stable receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AutomationWrite {
    pub command_id: String,
    pub id: String,
    pub expected_revision: u64,
    pub definition: AutomationDefinition,
    pub status: AutomationStatus,
}

/// Profile-owned plan, run and command storage. Every mutating operation is transactional.
pub struct AutomationStore {
    connection: Mutex<Connection>,
}

impl AutomationStore {
    pub fn open(path: &Path) -> Result<Self, AutomationError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS automation_plans (
               id TEXT PRIMARY KEY, record TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS automation_runs (
               id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, created_at INTEGER NOT NULL,
               active INTEGER NOT NULL, record TEXT NOT NULL);
             CREATE UNIQUE INDEX IF NOT EXISTS automation_one_active_run
               ON automation_runs(automation_id) WHERE active = 1;
             CREATE INDEX IF NOT EXISTS automation_run_history
               ON automation_runs(automation_id, created_at DESC, id);
             CREATE TABLE IF NOT EXISTS automation_commands (
               id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS automation_deleted (id TEXT PRIMARY KEY);",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn list(&self) -> Result<Vec<Automation>, AutomationError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        plans(&connection)
    }

    pub fn write(
        &self,
        request: &AutomationWrite,
        now: UnixMillis,
    ) -> Result<Automation, AutomationError> {
        validate_id(&request.id)?;
        validate_id(&request.command_id)?;
        validate_definition(&request.definition)?;
        if request.expected_revision >= 9_007_199_254_740_991 {
            return Err(AutomationError::Conflict);
        }
        let payload = serde_json::to_string(request)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(result) = replay(&transaction, &request.command_id, &payload)? {
            return decode_plan(&result);
        }
        let previous = plan(&transaction, &request.id)?;
        let deleted: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_deleted WHERE id = ?1)",
            [&request.id],
            |row| row.get(0),
        )?;
        if deleted {
            return Err(AutomationError::Conflict);
        }
        if previous.as_ref().map_or(0, |plan| plan.revision) != request.expected_revision {
            return Err(AutomationError::Conflict);
        }
        if previous.is_none() && plans(&transaction)?.len() >= 1_000 {
            return Err(AutomationError::Invalid(
                "profile plan limit reached".into(),
            ));
        }
        let next_run_at = if request.status == AutomationStatus::Paused {
            None
        } else {
            let next = next_occurrence(&request.definition.schedule, now)?;
            if next.is_none() {
                return Err(AutomationError::Invalid(
                    "schedule has no future occurrence".into(),
                ));
            }
            next
        };
        let plan = Automation {
            id: request.id.clone(),
            revision: request
                .expected_revision
                .checked_add(1)
                .ok_or(AutomationError::Conflict)?,
            definition: request.definition.clone(),
            status: request.status,
            created_at: previous.as_ref().map_or(now, |plan| plan.created_at),
            updated_at: now,
            next_run_at,
        };
        let record = serde_json::to_string(&plan)?;
        transaction.execute(
            "INSERT INTO automation_plans(id, record) VALUES (?1, ?2)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record",
            params![plan.id, record],
        )?;
        receipt(&transaction, &request.command_id, &payload, &record)?;
        transaction.commit()?;
        Ok(plan)
    }

    pub fn delete(&self, id: &str, expected_revision: u64) -> Result<(), AutomationError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(plan) = plan(&transaction, id)? else {
            return Ok(());
        };
        if plan.revision != expected_revision {
            return Err(AutomationError::Conflict);
        }
        if has_active_run(&transaction, id)? {
            return Err(AutomationError::Busy);
        }
        transaction.execute("DELETE FROM automation_plans WHERE id = ?1", [id])?;
        transaction.execute("INSERT INTO automation_deleted(id) VALUES (?1)", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn run_now(
        &self,
        id: &str,
        command_id: &str,
        now: UnixMillis,
    ) -> Result<AutomationRun, AutomationError> {
        validate_id(command_id)?;
        let payload = serde_json::to_string(&("run", id))?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(result) = replay(&transaction, command_id, &payload)? {
            return decode_run(&result);
        }
        let plan = plan(&transaction, id)?.ok_or(AutomationError::NotFound)?;
        if has_active_run(&transaction, id)? {
            return Err(AutomationError::Busy);
        }
        let run = new_run(&plan, format!("manual:{command_id}"), now, now);
        insert_run(&transaction, &run)?;
        receipt(
            &transaction,
            command_id,
            &payload,
            &serde_json::to_string(&run)?,
        )?;
        transaction.commit()?;
        Ok(run)
    }

    /// Creates due runs and advances each plan atomically. `last_checked` belongs to the host
    /// invocation: occurrences before it are missed, while occurrences since it are due now.
    pub fn poll(&self, last_checked: UnixMillis, now: UnixMillis) -> Result<(), AutomationError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for mut plan in plans(&transaction)? {
            let Some(due) = plan.next_run_at.filter(|due| *due <= now) else {
                continue;
            };
            if plan.status != AutomationStatus::Enabled {
                continue;
            }
            let id = format!("scheduled:{}:{}:{}", plan.id, plan.revision, due.get());
            let mut run = new_run(&plan, id, due, now);
            let once = matches!(plan.definition.schedule, AutomationSchedule::Once { .. });
            let missed = due < last_checked && !once;
            let busy = has_active_run(&transaction, &plan.id)?;
            if missed || busy {
                run.status = AutomationRunStatus::Skipped;
                run.finished_at = Some(now);
                run.message = Some(if busy {
                    "Previous run has not finished".into()
                } else {
                    format!(
                        "Missed scheduled occurrences from {} through {}",
                        due.get(),
                        now.get()
                    )
                });
            }
            insert_run(&transaction, &run)?;
            plan.next_run_at = if once {
                None
            } else {
                UnixMillis::new(now.get().saturating_add(1))
                    .ok()
                    .map(|from| next_occurrence(&plan.definition.schedule, from))
                    .transpose()?
                    .flatten()
            };
            transaction.execute(
                "UPDATE automation_plans SET record = ?2 WHERE id = ?1",
                params![plan.id, serde_json::to_string(&plan)?],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn runs(&self, id: &str, limit: u32) -> Result<Vec<AutomationRun>, AutomationError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let mut statement = connection.prepare(
            "SELECT record FROM automation_runs WHERE automation_id = ?1
            ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let records = statement.query_map(params![id, limit.clamp(1, 100)], |row| {
            row.get::<_, String>(0)
        })?;
        records.map(|record| decode_run(&record?)).collect()
    }

    pub fn active_runs(&self) -> Result<Vec<AutomationRun>, AutomationError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let mut statement = connection.prepare(
            "SELECT record FROM automation_runs WHERE active = 1 ORDER BY created_at, id",
        )?;
        let records = statement.query_map([], |row| row.get::<_, String>(0))?;
        records.map(|record| decode_run(&record?)).collect()
    }

    /// Installs an observation from the execution owner. A stop requested concurrently with an
    /// execution observation remains pending until a terminal result is observed.
    pub fn observe(&self, observation: &AutomationRun) -> Result<(), AutomationError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_run(&transaction, &observation.id)?;
        if current.status.is_finished() {
            return Ok(());
        }
        if current.automation_id != observation.automation_id
            || current.definition != observation.definition
            || current.revision != observation.revision
        {
            return Err(AutomationError::Conflict);
        }
        let mut updated = observation.clone();
        if current.status == AutomationRunStatus::Stopping && !updated.status.is_finished() {
            updated.status = AutomationRunStatus::Stopping;
        }
        save_run(&transaction, &updated)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn stop_run(&self, id: &str) -> Result<AutomationRun, AutomationError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut run = load_run(&transaction, id)?;
        if !run.status.is_finished() {
            run.status = AutomationRunStatus::Stopping;
            save_run(&transaction, &run)?;
        }
        transaction.commit()?;
        Ok(run)
    }

    pub fn needs_host(&self) -> Result<bool, AutomationError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let active: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE active = 1)",
            [],
            |row| row.get(0),
        )?;
        Ok(active
            || plans(&connection)?
                .iter()
                .any(|plan| plan.status == AutomationStatus::Enabled && plan.next_run_at.is_some()))
    }
}

fn validate_id(value: &str) -> Result<(), AutomationError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
    {
        return Err(AutomationError::Invalid("invalid identity".into()));
    }
    Ok(())
}

fn plans(connection: &Connection) -> Result<Vec<Automation>, AutomationError> {
    let mut statement = connection.prepare("SELECT record FROM automation_plans ORDER BY id")?;
    let records = statement.query_map([], |row| row.get::<_, String>(0))?;
    records.map(|record| decode_plan(&record?)).collect()
}

fn plan(connection: &Connection, id: &str) -> Result<Option<Automation>, AutomationError> {
    let record: Option<String> = connection
        .query_row(
            "SELECT record FROM automation_plans WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    record.map(|record| decode_plan(&record)).transpose()
}

fn has_active_run(connection: &Connection, id: &str) -> Result<bool, AutomationError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE automation_id = ?1 AND active = 1)",
        [id],
        |row| row.get(0),
    )?)
}

fn replay(
    connection: &Connection,
    id: &str,
    request: &str,
) -> Result<Option<String>, AutomationError> {
    let receipt: Option<(String, String)> = connection
        .query_row(
            "SELECT request, result FROM automation_commands WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match receipt {
        Some((original, _)) if original != request => Err(AutomationError::CommandConflict),
        Some((_, result)) => Ok(Some(result)),
        None => Ok(None),
    }
}

fn receipt(
    connection: &Connection,
    id: &str,
    request: &str,
    result: &str,
) -> Result<(), AutomationError> {
    connection.execute(
        "INSERT INTO automation_commands(id, request, result) VALUES (?1, ?2, ?3)",
        params![id, request, result],
    )?;
    Ok(())
}

fn new_run(
    plan: &Automation,
    id: String,
    scheduled_at: UnixMillis,
    now: UnixMillis,
) -> AutomationRun {
    AutomationRun {
        id,
        automation_id: plan.id.clone(),
        revision: plan.revision,
        definition: plan.definition.clone(),
        scheduled_at,
        created_at: now,
        started_at: None,
        finished_at: None,
        status: AutomationRunStatus::Pending,
        session_id: None,
        thread_id: None,
        turn_id: None,
        message: None,
    }
}

fn insert_run(connection: &Connection, run: &AutomationRun) -> Result<(), AutomationError> {
    connection.execute("INSERT INTO automation_runs(id, automation_id, created_at, active, record) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![run.id, run.automation_id, run.created_at.get() as i64, !run.status.is_finished(), serde_json::to_string(run)?])?;
    Ok(())
}

fn load_run(connection: &Connection, id: &str) -> Result<AutomationRun, AutomationError> {
    let record: String = connection
        .query_row(
            "SELECT record FROM automation_runs WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(AutomationError::NotFound)?;
    decode_run(&record)
}

fn save_run(connection: &Connection, run: &AutomationRun) -> Result<(), AutomationError> {
    connection.execute(
        "UPDATE automation_runs SET active = ?2, record = ?3 WHERE id = ?1",
        params![
            run.id,
            !run.status.is_finished(),
            serde_json::to_string(run)?
        ],
    )?;
    Ok(())
}

fn decode_plan(record: &str) -> Result<Automation, AutomationError> {
    let plan: Automation = serde_json::from_str(record)?;
    validate_id(&plan.id)?;
    validate_definition(&plan.definition)?;
    if plan.revision == 0
        || plan.revision > 9_007_199_254_740_991
        || (plan.status == AutomationStatus::Paused && plan.next_run_at.is_some())
    {
        return Err(AutomationError::Invalid(
            "invalid persisted plan state".into(),
        ));
    }
    Ok(plan)
}

fn decode_run(record: &str) -> Result<AutomationRun, AutomationError> {
    let run: AutomationRun = serde_json::from_str(record)?;
    validate_id(&run.automation_id)?;
    validate_definition(&run.definition)?;
    if run.id.is_empty()
        || run.id.len() > 256
        || run.revision == 0
        || run.status.is_finished() != run.finished_at.is_some()
    {
        return Err(AutomationError::Invalid(
            "invalid persisted run state".into(),
        ));
    }
    Ok(run)
}
