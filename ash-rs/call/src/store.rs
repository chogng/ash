use crate::CallError;
use crate::CallMember;
use crate::CallRole;
use crate::CallSnapshot;
use crate::JoinGrant;
use crate::MediaState;
use crate::MemberCredential;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use serde_json::json;
use std::path::Path;
use std::sync::Mutex;

pub struct CallStore {
    connection: Mutex<Connection>,
}

impl CallStore {
    pub fn open(path: &Path) -> Result<Self, CallError> {
        let connection = Connection::open(path).map_err(storage)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage)?;
        connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS media_calls(id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS media_members(credential TEXT PRIMARY KEY, call_id TEXT NOT NULL, member_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS media_devices(call_id TEXT NOT NULL, member_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY(call_id, member_id));
            CREATE TABLE IF NOT EXISTS media_operations(actor TEXT NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL, call_id TEXT NOT NULL, PRIMARY KEY(actor, operation));
        ").map_err(storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// The product host authenticates permission to create calls before invoking this operation.
    pub fn create(
        &self,
        credential: &MemberCredential,
        operation: &str,
    ) -> Result<CallSnapshot, CallError> {
        crate::validate_id(operation)?;
        let actor = credential.digest();
        let mut connection = self.connection.lock().map_err(storage)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(call) = replay(&tx, &actor, operation, "create")? {
            return Ok(call);
        }
        let used: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM media_members WHERE credential=?1)",
                [&actor],
                |row| row.get(0),
            )
            .map_err(storage)?;
        if used {
            return Err(CallError::Conflict);
        }
        let member = CallMember {
            id: crate::identifier(),
            role: CallRole::Owner,
        };
        let call = CallSnapshot {
            id: crate::identifier(),
            revision: 1,
            media_epoch: 1,
            media_room: crate::identifier(),
            media_state: MediaState::Preparing,
            members: vec![member.clone()],
        };
        save(&tx, &call)?;
        tx.execute(
            "INSERT INTO media_members VALUES(?1,?2,?3)",
            (&actor, &call.id, &member.id),
        )
        .map_err(storage)?;
        record(&tx, &actor, operation, "create", &call.id)?;
        tx.commit().map_err(storage)?;
        Ok(call)
    }

    pub fn read(&self, credential: &MemberCredential) -> Result<CallSnapshot, CallError> {
        let connection = self.connection.lock().map_err(storage)?;
        let (id, _) = identity(&connection, &credential.digest())?;
        read(&connection, &id)
    }

    pub fn invite(
        &self,
        credential: &MemberCredential,
        operation: &str,
        revision: u64,
        invited: &MemberCredential,
        role: CallRole,
    ) -> Result<CallSnapshot, CallError> {
        if role == CallRole::Owner {
            return Err(CallError::Invalid);
        }
        let invited_hash = invited.digest();
        let request = json!(["invite", revision, invited_hash, role]).to_string();
        self.modify(credential, operation, revision, &request, |tx, call, _| {
            if call.media_state != MediaState::Ready {
                return Err(CallError::NotReady);
            }
            if call.members.len() >= 64 {
                return Err(CallError::Conflict);
            }
            let used: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM media_members WHERE credential=?1)",
                    [&invited_hash],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if used {
                return Err(CallError::Conflict);
            }
            let member = CallMember {
                id: crate::identifier(),
                role,
            };
            tx.execute(
                "INSERT INTO media_members VALUES(?1,?2,?3)",
                (&invited_hash, &call.id, &member.id),
            )
            .map_err(storage)?;
            call.members.push(member);
            Ok(())
        })
    }

    pub fn remove_member(
        &self,
        credential: &MemberCredential,
        operation: &str,
        revision: u64,
        member: &str,
    ) -> Result<CallSnapshot, CallError> {
        let request = json!(["remove", revision, member]).to_string();
        self.modify(
            credential,
            operation,
            revision,
            &request,
            |tx, call, owner| {
                if call.media_state != MediaState::Ready {
                    return Err(CallError::NotReady);
                }
                if member == owner || !call.members.iter().any(|entry| entry.id == member) {
                    return Err(CallError::Invalid);
                }
                call.members.retain(|entry| entry.id != member);
                tx.execute(
                    "DELETE FROM media_members WHERE call_id=?1 AND member_id=?2",
                    (&call.id, member),
                )
                .map_err(storage)?;
                call.media_state = MediaState::Rotating {
                    previous_room: call.media_room.clone(),
                };
                call.media_room = crate::identifier();
                call.media_epoch = call.media_epoch.checked_add(1).ok_or(CallError::Conflict)?;
                Ok(())
            },
        )
    }

    pub fn end(
        &self,
        credential: &MemberCredential,
        operation: &str,
        revision: u64,
    ) -> Result<CallSnapshot, CallError> {
        self.modify(
            credential,
            operation,
            revision,
            &json!(["end", revision]).to_string(),
            |_, call, _| {
                if call.media_state != MediaState::Ready {
                    return Err(CallError::NotReady);
                }
                call.media_state = MediaState::Closing;
                Ok(())
            },
        )
    }

    /// Every permission change replaces the media room; previously issued JWTs cannot join it.
    pub fn set_role(
        &self,
        credential: &MemberCredential,
        operation: &str,
        revision: u64,
        member: &str,
        role: CallRole,
    ) -> Result<CallSnapshot, CallError> {
        if matches!(role, CallRole::Owner | CallRole::Agent) {
            return Err(CallError::Invalid);
        }
        self.modify(
            credential,
            operation,
            revision,
            &json!(["role", revision, member, role]).to_string(),
            |_, call, owner| {
                if call.media_state != MediaState::Ready {
                    return Err(CallError::NotReady);
                }
                if member == owner {
                    return Err(CallError::Invalid);
                }
                let entry = call
                    .members
                    .iter_mut()
                    .find(|entry| entry.id == member)
                    .ok_or(CallError::Invalid)?;
                if entry.role == CallRole::Agent {
                    return Err(CallError::Invalid);
                }
                entry.role = role;
                call.media_state = MediaState::Rotating {
                    previous_room: call.media_room.clone(),
                };
                call.media_room = crate::identifier();
                call.media_epoch = call.media_epoch.checked_add(1).ok_or(CallError::Conflict)?;
                Ok(())
            },
        )
    }

    /// Called by the media service only after the durable room operation has completed.
    pub fn media_completed(&self, id: &str, revision: u64) -> Result<CallSnapshot, CallError> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let mut call = read(&tx, id)?;
        if call.revision != revision {
            return Err(CallError::Conflict);
        }
        call.media_state = match call.media_state {
            MediaState::Preparing | MediaState::Rotating { .. } => MediaState::Ready,
            MediaState::Closing => MediaState::Closed,
            _ => return Err(CallError::Conflict),
        };
        call.revision = call.revision.checked_add(1).ok_or(CallError::Conflict)?;
        save(&tx, &call)?;
        tx.commit().map_err(storage)?;
        Ok(call)
    }

    /// Pending room operations survive process failure and are reconciled before issuing tickets.
    pub fn pending_media(&self) -> Result<Vec<CallSnapshot>, CallError> {
        let connection = self.connection.lock().map_err(storage)?;
        let mut statement = connection
            .prepare("SELECT snapshot FROM media_calls")
            .map_err(storage)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        let mut pending = Vec::new();
        for row in rows {
            let call: CallSnapshot =
                serde_json::from_str(&row.map_err(storage)?).map_err(storage)?;
            if !matches!(call.media_state, MediaState::Ready | MediaState::Closed) {
                pending.push(call);
            }
        }
        Ok(pending)
    }

    pub fn join(
        &self,
        credential: &MemberCredential,
        device_id: &str,
    ) -> Result<JoinGrant, CallError> {
        crate::validate_id(device_id)?;
        let mut connection = self.connection.lock().map_err(storage)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let (id, member_id) = identity(&tx, &credential.digest())?;
        let call = read(&tx, &id)?;
        if call.media_state != MediaState::Ready {
            return Err(CallError::NotReady);
        }
        let member = call
            .members
            .iter()
            .find(|member| member.id == member_id)
            .ok_or(CallError::Denied)?
            .clone();
        let participant_id =
            crate::digest(format!("{}:{}:{}", call.media_epoch, member_id, device_id).as_bytes());
        if member.role.can_publish_audio() {
            tx.execute(
                "INSERT OR IGNORE INTO media_devices VALUES(?1,?2,?3)",
                (&id, &member_id, device_id),
            )
            .map_err(storage)?;
        }
        let selected: Option<String> = tx
            .query_row(
                "SELECT device_id FROM media_devices WHERE call_id=?1 AND member_id=?2",
                (&id, &member_id),
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        let microphone = member.role.can_publish_audio() && selected.as_deref() == Some(device_id);
        tx.commit().map_err(storage)?;
        Ok(JoinGrant {
            call,
            member,
            participant_id,
            microphone,
        })
    }

    /// Selects this member's sending device and retires every previously issued publishing ticket.
    pub fn select_device(
        &self,
        credential: &MemberCredential,
        operation: &str,
        revision: u64,
        device_id: &str,
    ) -> Result<CallSnapshot, CallError> {
        crate::validate_id(operation)?;
        crate::validate_id(device_id)?;
        let actor = credential.digest();
        let request = json!(["device", revision, device_id]).to_string();
        let mut connection = self.connection.lock().map_err(storage)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let (id, member) = identity(&tx, &actor)?;
        let mut call = read(&tx, &id)?;
        if !call
            .members
            .iter()
            .any(|entry| entry.id == member && entry.role.can_publish_audio())
        {
            return Err(CallError::Denied);
        }
        if let Some(call) = replay(&tx, &actor, operation, &request)? {
            return Ok(call);
        }
        if call.revision != revision {
            return Err(CallError::Conflict);
        }
        if call.media_state != MediaState::Ready {
            return Err(CallError::NotReady);
        }
        tx.execute("INSERT INTO media_devices VALUES(?1,?2,?3) ON CONFLICT(call_id,member_id) DO UPDATE SET device_id=excluded.device_id", (&id, &member, device_id)).map_err(storage)?;
        call.media_state = MediaState::Rotating {
            previous_room: call.media_room.clone(),
        };
        call.media_room = crate::identifier();
        call.media_epoch = call.media_epoch.checked_add(1).ok_or(CallError::Conflict)?;
        call.revision = call.revision.checked_add(1).ok_or(CallError::Conflict)?;
        save(&tx, &call)?;
        record(&tx, &actor, operation, &request, &id)?;
        tx.commit().map_err(storage)?;
        Ok(call)
    }

    fn modify(
        &self,
        credential: &MemberCredential,
        operation: &str,
        revision: u64,
        request: &str,
        apply: impl FnOnce(&Transaction<'_>, &mut CallSnapshot, &str) -> Result<(), CallError>,
    ) -> Result<CallSnapshot, CallError> {
        crate::validate_id(operation)?;
        let actor = credential.digest();
        let mut connection = self.connection.lock().map_err(storage)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let (id, member) = identity(&tx, &actor)?;
        let mut call = read(&tx, &id)?;
        if !call
            .members
            .iter()
            .any(|entry| entry.id == member && entry.role == CallRole::Owner)
        {
            return Err(CallError::Denied);
        }
        if let Some(call) = replay(&tx, &actor, operation, request)? {
            return Ok(call);
        }
        if call.revision != revision {
            return Err(CallError::Conflict);
        }
        apply(&tx, &mut call, &member)?;
        call.revision = call.revision.checked_add(1).ok_or(CallError::Conflict)?;
        save(&tx, &call)?;
        record(&tx, &actor, operation, request, &id)?;
        tx.commit().map_err(storage)?;
        Ok(call)
    }
}

fn identity(connection: &Connection, actor: &str) -> Result<(String, String), CallError> {
    connection
        .query_row(
            "SELECT call_id,member_id FROM media_members WHERE credential=?1",
            [actor],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(storage)?
        .ok_or(CallError::Denied)
}
fn read(connection: &Connection, id: &str) -> Result<CallSnapshot, CallError> {
    let json: String = connection
        .query_row(
            "SELECT snapshot FROM media_calls WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?
        .ok_or(CallError::Denied)?;
    serde_json::from_str(&json).map_err(storage)
}
fn save(connection: &Connection, call: &CallSnapshot) -> Result<(), CallError> {
    connection.execute("INSERT INTO media_calls VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot", (&call.id, serde_json::to_string(call).map_err(storage)?)).map_err(storage)?;
    Ok(())
}
fn record(
    tx: &Transaction<'_>,
    actor: &str,
    operation: &str,
    request: &str,
    id: &str,
) -> Result<(), CallError> {
    tx.execute(
        "INSERT INTO media_operations VALUES(?1,?2,?3,?4)",
        (actor, operation, request, id),
    )
    .map_err(storage)?;
    Ok(())
}
fn replay(
    tx: &Transaction<'_>,
    actor: &str,
    operation: &str,
    request: &str,
) -> Result<Option<CallSnapshot>, CallError> {
    let previous: Option<(String, String)> = tx
        .query_row(
            "SELECT request,call_id FROM media_operations WHERE actor=?1 AND operation=?2",
            (actor, operation),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(storage)?;
    match previous {
        Some((stored, id)) if stored == request => Ok(Some(read(tx, &id)?)),
        Some(_) => Err(CallError::Conflict),
        None => Ok(None),
    }
}
fn storage(_: impl std::fmt::Display) -> CallError {
    CallError::Storage
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
