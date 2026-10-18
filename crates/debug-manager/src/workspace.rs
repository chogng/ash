use ash_debug_contract::DebugWorkspaceEdit;
use ash_debug_contract::DebugWorkspaceResult;
use ash_debug_contract::DebugWorkspaceSnapshot;
use ash_debug_contract::DebugWorkspaceState;
use ash_debug_contract::DebugWorkspaceStatus;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use sha2::Digest;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum DebugWorkspaceError {
    #[error("invalid debug workspace definitions")]
    Invalid,
    #[error("debug workspace storage failed: {0}")]
    Storage(String),
}

/// Profile-local, workspace-keyed definitions shared by all connections.
/// SQLite serializes compare-and-swap and migration receipts with the document,
/// so neither a second process nor interrupted legacy cleanup can lose edits.
pub struct DebugWorkspaceStore {
    connection: Mutex<Connection>,
}

impl DebugWorkspaceStore {
    pub fn open(path: &Path) -> Result<Self, DebugWorkspaceError> {
        let connection =
            ash_state::open_sqlite_database(path, ash_state::SqliteDurability::Durable)
                .map_err(DebugWorkspaceError::Storage)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS debug_workspaces (
                workspace_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                document TEXT NOT NULL,
                memento_receipt TEXT
            );",
            )
            .map_err(storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Import only into an absent target or an equal target. A receipt allows
    /// cleanup to resume even if definitions changed after the original import.
    pub fn read(
        &self,
        workspace_id: &str,
        legacy: Option<DebugWorkspaceState>,
    ) -> Result<DebugWorkspaceResult, DebugWorkspaceError> {
        validate_key(workspace_id)?;
        if let Some(state) = &legacy {
            validate(state)?;
        }
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let record = load(&transaction, workspace_id)?;
        let mut snapshot = record
            .as_ref()
            .map(|(snapshot, _)| snapshot.clone())
            .unwrap_or_else(empty);
        let mut status = DebugWorkspaceStatus::Current;
        if let Some(legacy) = legacy {
            let document = serde_json::to_string(&legacy).map_err(storage)?;
            let receipt = format!("{:x}", sha2::Sha256::digest(document.as_bytes()));
            if record
                .as_ref()
                .is_some_and(|(_, prior)| prior.as_ref() == Some(&receipt))
            {
                // Already durable; never reimport an old Memento over new edits.
            } else if record.is_none() || snapshot.state == legacy {
                snapshot = DebugWorkspaceSnapshot {
                    revision: snapshot.revision.max(1),
                    state: legacy,
                };
                transaction.execute(
                    "INSERT INTO debug_workspaces VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(workspace_id) DO UPDATE SET memento_receipt = excluded.memento_receipt",
                    params![workspace_id, snapshot.revision, document, receipt],
                ).map_err(storage)?;
                status = DebugWorkspaceStatus::Applied;
            } else {
                status = DebugWorkspaceStatus::Conflict;
            }
        }
        transaction.commit().map_err(storage)?;
        Ok(DebugWorkspaceResult { status, snapshot })
    }

    pub fn write(
        &self,
        workspace_id: &str,
        revision: u32,
        edits: Vec<DebugWorkspaceEdit>,
    ) -> Result<DebugWorkspaceResult, DebugWorkspaceError> {
        validate_key(workspace_id)?;
        if edits.len() > 16384 {
            return Err(DebugWorkspaceError::Invalid);
        }
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let current = load(&transaction, workspace_id)?
            .map(|(value, _)| value)
            .unwrap_or_else(empty);
        let result = if current.revision != revision {
            DebugWorkspaceResult {
                status: DebugWorkspaceStatus::Conflict,
                snapshot: current,
            }
        } else {
            let mut state = current.state;
            for edit in edits {
                apply(&mut state, edit)?;
            }
            validate(&state)?;
            let document = serde_json::to_string(&state).map_err(storage)?;
            let next = revision
                .checked_add(1)
                .ok_or(DebugWorkspaceError::Invalid)?;
            transaction.execute(
                "INSERT INTO debug_workspaces(workspace_id, revision, document) VALUES (?1, ?2, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision, document = excluded.document",
                params![workspace_id, next, document],
            ).map_err(storage)?;
            DebugWorkspaceResult {
                status: DebugWorkspaceStatus::Applied,
                snapshot: DebugWorkspaceSnapshot {
                    revision: next,
                    state,
                },
            }
        };
        transaction.commit().map_err(storage)?;
        Ok(result)
    }
}

fn empty() -> DebugWorkspaceSnapshot {
    DebugWorkspaceSnapshot {
        revision: 0,
        state: DebugWorkspaceState::default(),
    }
}

fn load(
    connection: &Connection,
    key: &str,
) -> Result<Option<(DebugWorkspaceSnapshot, Option<String>)>, DebugWorkspaceError> {
    let record = connection.query_row(
        "SELECT revision, document, memento_receipt FROM debug_workspaces WHERE workspace_id = ?1", [key],
        |row| Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
    ).optional().map_err(storage)?;
    record
        .map(|(revision, document, receipt)| {
            let state: DebugWorkspaceState = serde_json::from_str(&document).map_err(storage)?;
            validate(&state)?;
            Ok((DebugWorkspaceSnapshot { revision, state }, receipt))
        })
        .transpose()
}

fn storage(error: impl std::fmt::Display) -> DebugWorkspaceError {
    DebugWorkspaceError::Storage(error.to_string())
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}

fn validate_key(key: &str) -> Result<(), DebugWorkspaceError> {
    if text(key, 4096) {
        Ok(())
    } else {
        Err(DebugWorkspaceError::Invalid)
    }
}

fn validate(state: &DebugWorkspaceState) -> Result<(), DebugWorkspaceError> {
    let bases = state
        .breakpoints
        .iter()
        .map(|point| &point.base)
        .chain(state.function_breakpoints.iter().map(|point| &point.base))
        .chain(state.data_breakpoints.iter().map(|point| &point.base));
    let mut ids = HashSet::new();
    let valid = state.breakpoints.len()
        + state.function_breakpoints.len()
        + state.data_breakpoints.len()
        <= 4096
        && state.watch_expressions.len() <= 4096
        && state.exception_breakpoints.len() <= 128
        && bases.into_iter().all(|base| {
            text(&base.id, 32768)
                && ids.insert(&base.id)
                && [&base.condition, &base.hit_condition, &base.log_message]
                    .into_iter()
                    .all(|value| value.as_ref().is_none_or(|value| text(value, 32768)))
        })
        && state.breakpoints.iter().all(|point| {
            text(&point.resource, 16384)
                && url::Url::parse(&point.resource).is_ok()
                && point.line_number > 0
                && point.column_number != Some(0)
        })
        && state
            .function_breakpoints
            .iter()
            .all(|point| text(&point.name, 32768))
        && state.data_breakpoints.iter().all(|point| {
            text(&point.data_id, 32768)
                && text(&point.adapter_type, 256)
                && point.description.len() <= 32768
                && !point.description.contains('\0')
                && point.base.log_message.is_none()
                && point.access_types.len() <= 3
                && point.access_types.contains(&point.access_type)
        })
        && state
            .watch_expressions
            .iter()
            .all(|value| text(value, 32768))
        && state.exception_breakpoints.iter().all(|(key, filters)| {
            text(key, 128) && filters.len() <= 128 && filters.iter().all(|filter| text(filter, 256))
        })
        // Leave room for the result envelope inside the transport's frame limit.
        && serde_json::to_vec(state).map_err(storage)?.len() <= 3 * 1024 * 1024;
    if valid {
        Ok(())
    } else {
        Err(DebugWorkspaceError::Invalid)
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;

fn apply(
    state: &mut DebugWorkspaceState,
    edit: DebugWorkspaceEdit,
) -> Result<(), DebugWorkspaceError> {
    match edit {
        DebugWorkspaceEdit::ClearBreakpoints => {
            state.breakpoints.clear();
            state.function_breakpoints.clear();
            state.data_breakpoints.clear();
        }
        DebugWorkspaceEdit::SetEnabled { enabled } => {
            for point in &mut state.breakpoints {
                point.base.enabled = enabled;
            }
            for point in &mut state.function_breakpoints {
                point.base.enabled = enabled;
            }
            for point in &mut state.data_breakpoints {
                point.base.enabled = enabled;
            }
        }
        DebugWorkspaceEdit::Source { point } => {
            state
                .breakpoints
                .retain(|value| value.base.id != point.base.id);
            state.breakpoints.push(point);
        }
        DebugWorkspaceEdit::Function { point } => {
            if let Some(existing) = state
                .function_breakpoints
                .iter_mut()
                .find(|value| value.base.id == point.base.id)
            {
                *existing = point;
            } else {
                state.function_breakpoints.push(point);
            }
        }
        DebugWorkspaceEdit::Data { point } => {
            if let Some(existing) = state
                .data_breakpoints
                .iter_mut()
                .find(|value| value.base.id == point.base.id)
            {
                *existing = point;
            } else {
                state.data_breakpoints.push(point);
            }
        }
        DebugWorkspaceEdit::Remove { ids } => {
            if ids.len() > 4096 || ids.iter().any(|id| !text(id, 32768)) {
                return Err(DebugWorkspaceError::Invalid);
            }
            state
                .breakpoints
                .retain(|point| !ids.contains(&point.base.id));
            state
                .function_breakpoints
                .retain(|point| !ids.contains(&point.base.id));
            state
                .data_breakpoints
                .retain(|point| !ids.contains(&point.base.id));
        }
        DebugWorkspaceEdit::AddWatch { expression } => {
            if !state.watch_expressions.contains(&expression) {
                state.watch_expressions.push(expression);
            }
        }
        DebugWorkspaceEdit::RemoveWatch { expression } => {
            if !text(&expression, 32768) {
                return Err(DebugWorkspaceError::Invalid);
            }
            state.watch_expressions.retain(|value| value != &expression);
        }
        DebugWorkspaceEdit::Exceptions {
            adapter_type,
            filters,
        } => {
            if !text(&adapter_type, 128) {
                return Err(DebugWorkspaceError::Invalid);
            }
            state.exception_breakpoints.insert(adapter_type, filters);
        }
    }
    Ok(())
}
