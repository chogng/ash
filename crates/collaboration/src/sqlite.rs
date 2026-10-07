use crate::DocumentCollaborationAuditEvent;
use crate::DocumentCollaborationInvite;
use crate::DocumentCollaborationMember;
use crate::DocumentCollaborationOpenParams;
use crate::DocumentCollaborationOpenResult;
use crate::DocumentCollaborationPresence;
use crate::DocumentCollaborationPresenceReplay;
use crate::DocumentCollaborationPrincipal;
use crate::DocumentCollaborationRoomRole;
use crate::DocumentCollaborationSubmitParams;
use crate::DocumentCollaborationSubmitResult;
use crate::DocumentCollaborationUpdate;
use crate::room::DocumentCollaborationReplay;
use crate::room::MAX_JAVASCRIPT_SAFE_INTEGER;
use crate::room::MAX_ROOM_HISTORY;
use crate::room::random_access_token;
use crate::room::random_principal_id;
use crate::room::random_room_id;
use crate::room::replay;
use crate::room::replay_submit_result;
use crate::room::snapshot;
use crate::room::validate_document;
use crate::room::validate_identifier;
use crate::room::validate_javascript_safe_integer;
use crate::room::validate_presence_selection;
use crate::room::validate_transaction;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// SQLite-backed collaboration authority that survives remote-host restarts.
pub struct SqliteDocumentCollaborationRooms {
    connection: Mutex<Connection>,
}

struct PersistedRoom {
    schema_id: String,
    document: String,
    version: u64,
    presence_generation: u64,
}

impl SqliteDocumentCollaborationRooms {
    /// Opens or creates the collaboration authority at an explicit SQLite path.
    pub fn open_at(path: impl AsRef<Path>) -> Result<Self, String> {
        let mut connection = Connection::open(path).map_err(sqlite_error)?;
        configure(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn open(
        &self,
        params: DocumentCollaborationOpenParams,
    ) -> Result<DocumentCollaborationOpenResult, String> {
        self.open_inner(None, params)
    }

    /// Opens or creates a room while requiring the principal to be a room member.
    pub fn open_as(
        &self,
        principal: &DocumentCollaborationPrincipal,
        params: DocumentCollaborationOpenParams,
    ) -> Result<DocumentCollaborationOpenResult, String> {
        validate_principal(principal)?;
        self.open_inner(Some(principal), params)
    }

    /// Claims an older unowned room for the authenticated deployment bootstrap principal.
    ///
    /// This migration bridge is intentionally narrow: it only inserts an owner
    /// when the room has no member records at all, so it cannot elevate access
    /// to a room that already has persistent membership.
    pub fn initialize_owner_if_unowned(
        &self,
        room_id: &str,
        principal: &DocumentCollaborationPrincipal,
    ) -> Result<(), String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(principal)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        if load_room(&connection, room_id)?.is_none() {
            return Err("The collaboration room does not exist".into());
        }
        let member_count = count_room_members(&connection, room_id)?;
        if member_count > 0 {
            return Ok(());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        if load_room(&transaction, room_id)?.is_none() {
            return Err("The collaboration room does not exist".into());
        }
        if count_room_members(&transaction, room_id)? == 0 {
            insert_room_member(
                &transaction,
                room_id,
                principal,
                DocumentCollaborationRoomRole::Owner,
                None,
            )?;
            record_audit(
                &transaction,
                room_id,
                &principal.id,
                "room.owner_initialized",
                &principal.id,
            )?;
        }
        transaction.commit().map_err(sqlite_error)
    }

    fn open_inner(
        &self,
        principal: Option<&DocumentCollaborationPrincipal>,
        params: DocumentCollaborationOpenParams,
    ) -> Result<DocumentCollaborationOpenResult, String> {
        validate_identifier(&params.client_id, "clientId")?;
        validate_identifier(&params.schema_id, "schemaId")?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let room_id = match params.room_id {
            Some(room_id) => {
                validate_identifier(&room_id, "roomId")?;
                room_id
            }
            None => create_room_id(&transaction)?,
        };
        if let Some(room) = load_room(&transaction, &room_id)? {
            if room.schema_id != params.schema_id {
                return Err("The collaboration room uses a different document schema".into());
            }
            if let Some(principal) = principal {
                require_room_role(&transaction, &room_id, &principal.id)?;
            }
            let result = DocumentCollaborationOpenResult {
                client_id: params.client_id,
                schema_id: room.schema_id,
                snapshot: snapshot(&room_id, room.version, room.document),
            };
            transaction.commit().map_err(sqlite_error)?;
            return Ok(result);
        }
        validate_document(&params.document)?;
        transaction
            .execute(
                "INSERT INTO document_collaboration_rooms (room_id, schema_id, document, version) VALUES (?1, ?2, ?3, 0)",
                params![room_id, params.schema_id, params.document],
            )
            .map_err(sqlite_error)?;
        if let Some(principal) = principal {
            insert_room_member(
                &transaction,
                &room_id,
                principal,
                DocumentCollaborationRoomRole::Owner,
                None,
            )?;
            record_audit(
                &transaction,
                &room_id,
                &principal.id,
                "room.created",
                &principal.id,
            )?;
        }
        let result = DocumentCollaborationOpenResult {
            client_id: params.client_id,
            schema_id: params.schema_id,
            snapshot: snapshot(&room_id, 0, params.document),
        };
        transaction.commit().map_err(sqlite_error)?;
        Ok(result)
    }

    pub fn submit(
        &self,
        params: DocumentCollaborationSubmitParams,
    ) -> Result<DocumentCollaborationSubmitResult, String> {
        self.submit_inner(None, params)
    }

    /// Submits one update only when the principal has owner or editor authority.
    pub fn submit_as(
        &self,
        principal: &DocumentCollaborationPrincipal,
        params: DocumentCollaborationSubmitParams,
    ) -> Result<DocumentCollaborationSubmitResult, String> {
        validate_principal(principal)?;
        self.submit_inner(Some(principal), params)
    }

    /// Resolves the current room role for an authenticated principal.
    pub fn room_role_as(
        &self,
        principal: &DocumentCollaborationPrincipal,
        room_id: &str,
    ) -> Result<DocumentCollaborationRoomRole, String> {
        validate_principal(principal)?;
        validate_identifier(room_id, "roomId")?;
        let connection = self.connection.lock().map_err(lock_error)?;
        require_room_role(&connection, room_id, &principal.id)
    }

    fn submit_inner(
        &self,
        principal: Option<&DocumentCollaborationPrincipal>,
        params: DocumentCollaborationSubmitParams,
    ) -> Result<DocumentCollaborationSubmitResult, String> {
        validate_identifier(&params.room_id, "roomId")?;
        validate_identifier(&params.client_id, "clientId")?;
        validate_javascript_safe_integer(params.sequence, "sequence", 1)?;
        validate_javascript_safe_integer(params.base_version, "baseVersion", 0)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let Some(room) = load_room(&transaction, &params.room_id)? else {
            return Err("The collaboration room does not exist".into());
        };
        if let Some(principal) = principal {
            let role = require_room_role(&transaction, &params.room_id, &principal.id)?;
            if !role.can_submit() {
                return Err("The collaboration room member is read-only".into());
            }
        }
        if let Some(existing) = load_client_update(
            &transaction,
            &params.room_id,
            &params.client_id,
            params.sequence,
        )? {
            if existing.update.base_version != params.base_version
                || existing.update.transaction != params.transaction
                || existing.document != params.document
            {
                return Err("sequence has already been used by this collaboration client".into());
            }
            transaction.commit().map_err(sqlite_error)?;
            return Ok(DocumentCollaborationSubmitResult::Accepted {
                update: existing.update,
            });
        }
        if params.base_version > room.version {
            return Err("baseVersion cannot be newer than the collaboration room".into());
        }
        if params.base_version != room.version {
            let replay = replay_room(&transaction, &params.room_id, room, params.base_version)?;
            transaction.commit().map_err(sqlite_error)?;
            return Ok(replay_submit_result(replay));
        }
        validate_transaction(&params.transaction)?;
        validate_document(&params.document)?;
        let version = room
            .version
            .checked_add(1)
            .filter(|version| *version <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                "The collaboration room version exceeded JavaScript's safe integer range"
                    .to_string()
            })?;
        let update = DocumentCollaborationUpdate {
            room_id: params.room_id,
            client_id: params.client_id,
            sequence: params.sequence,
            base_version: params.base_version,
            version,
            transaction: params.transaction,
        };
        transaction
            .execute(
                "UPDATE document_collaboration_rooms SET document = ?2, version = ?3 WHERE room_id = ?1",
                params![&update.room_id, &params.document, to_sql_integer(version)?],
            )
            .map_err(sqlite_error)?;
        if let Some(principal) = principal {
            record_audit(
                &transaction,
                &update.room_id,
                &principal.id,
                "document.submitted",
                &update.client_id,
            )?;
        }
        transaction
            .execute(
                "INSERT INTO document_collaboration_updates (room_id, version, client_id, sequence, base_version, transaction_json, document) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &update.room_id,
                    to_sql_integer(update.version)?,
                    &update.client_id,
                    to_sql_integer(update.sequence)?,
                    to_sql_integer(update.base_version)?,
                    &update.transaction,
                    &params.document,
                ],
            )
            .map_err(sqlite_error)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(DocumentCollaborationSubmitResult::Accepted { update })
    }

    pub fn replay(
        &self,
        room_id: &str,
        after_version: u64,
    ) -> Result<DocumentCollaborationReplay, String> {
        self.replay_inner(None, room_id, after_version)
    }

    /// Reads room replay state only when the principal is a current member.
    pub fn replay_as(
        &self,
        principal: &DocumentCollaborationPrincipal,
        room_id: &str,
        after_version: u64,
    ) -> Result<DocumentCollaborationReplay, String> {
        validate_principal(principal)?;
        self.replay_inner(Some(principal), room_id, after_version)
    }

    fn replay_inner(
        &self,
        principal: Option<&DocumentCollaborationPrincipal>,
        room_id: &str,
        after_version: u64,
    ) -> Result<DocumentCollaborationReplay, String> {
        validate_identifier(room_id, "roomId")?;
        validate_javascript_safe_integer(after_version, "afterVersion", 0)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let Some(room) = load_room(&connection, room_id)? else {
            return Err("The collaboration room does not exist".into());
        };
        if let Some(principal) = principal {
            require_room_role(&connection, room_id, &principal.id)?;
        }
        if after_version > room.version {
            return Err("afterVersion cannot be newer than the collaboration room".into());
        }
        replay_room(&connection, room_id, room, after_version)
    }

    /// Creates a per-member room access token. Only owners may invite members.
    pub fn create_invite(
        &self,
        room_id: &str,
        owner: &DocumentCollaborationPrincipal,
        display_name: &str,
        role: DocumentCollaborationRoomRole,
    ) -> Result<DocumentCollaborationInvite, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        validate_display_name(display_name)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let owner_role = require_room_role(&transaction, room_id, &owner.id)?;
        if owner_role != DocumentCollaborationRoomRole::Owner {
            return Err("Only collaboration room owners may invite members".into());
        }
        let principal_id = create_principal_id(&transaction, room_id)?;
        let access_token = random_access_token()?;
        let principal = DocumentCollaborationPrincipal {
            id: principal_id.clone(),
            display_name: display_name.into(),
        };
        insert_room_member(&transaction, room_id, &principal, role, Some(&access_token))?;
        record_audit(
            &transaction,
            room_id,
            &owner.id,
            "member.invited",
            &principal_id,
        )?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(DocumentCollaborationInvite {
            room_id: room_id.into(),
            principal_id,
            display_name: display_name.into(),
            role,
            access_token,
        })
    }

    /// Resolves a room-scoped bearer credential to its persistent member identity.
    pub fn principal_for_access_token(
        &self,
        room_id: &str,
        access_token: &str,
    ) -> Result<Option<DocumentCollaborationPrincipal>, String> {
        validate_identifier(room_id, "roomId")?;
        if access_token.is_empty() {
            return Ok(None);
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        connection.query_row(
            "SELECT principal_id, display_name FROM document_collaboration_room_members WHERE room_id = ?1 AND token_hash = ?2 AND revoked_at_ms IS NULL",
            params![room_id, token_hash(access_token)],
            |row| Ok(DocumentCollaborationPrincipal { id: row.get(0)?, display_name: row.get(1)? }),
        ).optional().map_err(sqlite_error)
    }

    /// Lists the room's active members. Only owners may inspect membership.
    pub fn list_members(
        &self,
        room_id: &str,
        owner: &DocumentCollaborationPrincipal,
    ) -> Result<Vec<DocumentCollaborationMember>, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        if require_room_role(&connection, room_id, &owner.id)?
            != DocumentCollaborationRoomRole::Owner
        {
            return Err("Only collaboration room owners may inspect members".into());
        }
        let mut statement = connection
            .prepare(
                "SELECT principal_id, display_name, role FROM document_collaboration_room_members WHERE room_id = ?1 AND revoked_at_ms IS NULL ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, created_at_ms, principal_id",
            )
            .map_err(sqlite_error)?;
        let records = statement
            .query_map([room_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        records
            .into_iter()
            .map(|(principal_id, display_name, role)| {
                Ok(DocumentCollaborationMember {
                    principal_id,
                    display_name,
                    role: role_from_sql(&role)?,
                })
            })
            .collect()
    }

    /// Revokes one member credential and preserves an auditable membership history.
    pub fn revoke_member(
        &self,
        room_id: &str,
        owner: &DocumentCollaborationPrincipal,
        principal_id: &str,
    ) -> Result<(), String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        validate_identifier(principal_id, "principalId")?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        if require_room_role(&transaction, room_id, &owner.id)?
            != DocumentCollaborationRoomRole::Owner
        {
            return Err("Only collaboration room owners may revoke members".into());
        }
        if principal_id == owner.id {
            return Err("Collaboration room owners cannot revoke themselves".into());
        }
        let changed = transaction.execute(
            "UPDATE document_collaboration_room_members SET revoked_at_ms = ?3 WHERE room_id = ?1 AND principal_id = ?2 AND revoked_at_ms IS NULL",
            params![room_id, principal_id, unix_millis()?],
        ).map_err(sqlite_error)?;
        if changed == 0 {
            return Err("The collaboration room member does not exist".into());
        }
        record_audit(
            &transaction,
            room_id,
            &owner.id,
            "member.revoked",
            principal_id,
        )?;
        transaction.commit().map_err(sqlite_error)
    }

    /// Replaces a member's bearer credential without changing its room identity or role.
    pub fn rotate_member_access_token(
        &self,
        room_id: &str,
        owner: &DocumentCollaborationPrincipal,
        principal_id: &str,
    ) -> Result<DocumentCollaborationInvite, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        validate_identifier(principal_id, "principalId")?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        if require_room_role(&transaction, room_id, &owner.id)?
            != DocumentCollaborationRoomRole::Owner
        {
            return Err("Only collaboration room owners may rotate member credentials".into());
        }
        let (display_name, role) = transaction.query_row(
            "SELECT display_name, role FROM document_collaboration_room_members WHERE room_id = ?1 AND principal_id = ?2 AND revoked_at_ms IS NULL",
            params![room_id, principal_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional().map_err(sqlite_error)?
            .ok_or_else(|| "The collaboration room member does not exist".to_string())?;
        let role = role_from_sql(&role)?;
        let access_token = random_access_token()?;
        transaction.execute(
            "UPDATE document_collaboration_room_members SET token_hash = ?3 WHERE room_id = ?1 AND principal_id = ?2",
            params![room_id, principal_id, token_hash(&access_token)],
        ).map_err(sqlite_error)?;
        record_audit(
            &transaction,
            room_id,
            &owner.id,
            "member.token_rotated",
            principal_id,
        )?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(DocumentCollaborationInvite {
            room_id: room_id.into(),
            principal_id: principal_id.into(),
            display_name,
            role,
            access_token,
        })
    }

    /// Lists immutable security events for a room. Only owners may inspect the audit log.
    pub fn audit_events(
        &self,
        room_id: &str,
        owner: &DocumentCollaborationPrincipal,
    ) -> Result<Vec<DocumentCollaborationAuditEvent>, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        if require_room_role(&connection, room_id, &owner.id)?
            != DocumentCollaborationRoomRole::Owner
        {
            return Err("Only collaboration room owners may inspect the audit log".into());
        }
        let mut statement = connection.prepare(
            "SELECT event_id, actor_principal_id, event_type, subject_principal_id, occurred_at_ms FROM document_collaboration_audit_events WHERE room_id = ?1 ORDER BY event_id",
        ).map_err(sqlite_error)?;
        let events = statement
            .query_map([room_id], |row| {
                Ok(DocumentCollaborationAuditEvent {
                    room_id: room_id.into(),
                    event_id: from_sql_integer(row.get(0)?)?,
                    actor_principal_id: row.get(1)?,
                    event_type: row.get(2)?,
                    subject_principal_id: row.get(3)?,
                    occurred_at_ms: from_sql_integer(row.get(4)?)?,
                })
            })
            .map_err(sqlite_error)?;
        events.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
    }

    /// Publishes or clears one client selection without affecting document history.
    pub fn update_presence_as(
        &self,
        principal: &DocumentCollaborationPrincipal,
        room_id: &str,
        client_id: &str,
        selection: Option<&str>,
    ) -> Result<u64, String> {
        validate_principal(principal)?;
        validate_identifier(room_id, "roomId")?;
        validate_identifier(client_id, "clientId")?;
        if let Some(selection) = selection {
            validate_presence_selection(selection)?;
        }
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let Some(room) = load_room(&transaction, room_id)? else {
            return Err("The collaboration room does not exist".into());
        };
        require_room_role(&transaction, room_id, &principal.id)?;
        let generation = room.presence_generation.checked_add(1)
            .filter(|generation| *generation <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| "The collaboration room presence generation exceeded JavaScript's safe integer range".to_string())?;
        transaction.execute(
            "UPDATE document_collaboration_rooms SET presence_generation = ?2 WHERE room_id = ?1",
            params![room_id, to_sql_integer(generation)?],
        ).map_err(sqlite_error)?;
        match selection {
            Some(selection) => {
                transaction.execute(
                    "INSERT INTO document_collaboration_presence (room_id, client_id, principal_id, selection_json, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(room_id, client_id) DO UPDATE SET principal_id = excluded.principal_id, selection_json = excluded.selection_json, updated_at_ms = excluded.updated_at_ms",
                    params![room_id, client_id, &principal.id, selection, unix_millis()?],
                ).map_err(sqlite_error)?;
            }
            None => {
                transaction.execute(
                    "DELETE FROM document_collaboration_presence WHERE room_id = ?1 AND client_id = ?2 AND principal_id = ?3",
                    params![room_id, client_id, &principal.id],
                ).map_err(sqlite_error)?;
            }
        }
        transaction.commit().map_err(sqlite_error)?;
        Ok(generation)
    }

    /// Replays the current ephemeral selection set when its generation changed.
    pub fn replay_presence_as(
        &self,
        principal: &DocumentCollaborationPrincipal,
        room_id: &str,
        after_generation: u64,
    ) -> Result<DocumentCollaborationPresenceReplay, String> {
        validate_principal(principal)?;
        validate_identifier(room_id, "roomId")?;
        validate_javascript_safe_integer(after_generation, "afterGeneration", 0)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let Some(room) = load_room(&connection, room_id)? else {
            return Err("The collaboration room does not exist".into());
        };
        require_room_role(&connection, room_id, &principal.id)?;
        if after_generation > room.presence_generation {
            return Err(
                "afterGeneration cannot be newer than the collaboration room presence".into(),
            );
        }
        let stale_before = unix_millis()?.saturating_sub(PRESENCE_TTL_MILLIS);
        let mut statement = connection.prepare(
            "SELECT client_id, selection_json FROM document_collaboration_presence WHERE room_id = ?1 AND updated_at_ms >= ?2 ORDER BY client_id",
        ).map_err(sqlite_error)?;
        let presences = statement
            .query_map(params![room_id, stale_before], |row| {
                Ok(DocumentCollaborationPresence {
                    client_id: row.get(0)?,
                    selection: row.get(1)?,
                })
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        Ok(DocumentCollaborationPresenceReplay {
            generation: room.presence_generation,
            presences,
        })
    }
}

fn count_room_members(connection: &Connection, room_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM document_collaboration_room_members WHERE room_id = ?1",
            [room_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)
}

const PRESENCE_TTL_MILLIS: i64 = 60_000;

fn configure(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS document_collaboration_rooms (
                room_id TEXT PRIMARY KEY NOT NULL,
                schema_id TEXT NOT NULL,
                document TEXT NOT NULL,
                version INTEGER NOT NULL CHECK(version >= 0),
                presence_generation INTEGER NOT NULL DEFAULT 0 CHECK(presence_generation >= 0)
            );
            CREATE TABLE IF NOT EXISTS document_collaboration_updates (
                room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
                version INTEGER NOT NULL CHECK(version > 0),
                client_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK(sequence > 0),
                base_version INTEGER NOT NULL CHECK(base_version >= 0),
                transaction_json TEXT NOT NULL,
                document TEXT NOT NULL,
                PRIMARY KEY (room_id, version),
                UNIQUE (room_id, client_id, sequence)
            );
            CREATE INDEX IF NOT EXISTS document_collaboration_updates_replay
                ON document_collaboration_updates (room_id, version);
            CREATE TABLE IF NOT EXISTS document_collaboration_room_members (
                room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
                principal_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
                token_hash TEXT,
                created_at_ms INTEGER NOT NULL,
                revoked_at_ms INTEGER,
                PRIMARY KEY (room_id, principal_id),
                UNIQUE (room_id, token_hash)
            );
            CREATE INDEX IF NOT EXISTS document_collaboration_room_member_tokens
                ON document_collaboration_room_members (room_id, token_hash);
            CREATE TABLE IF NOT EXISTS document_collaboration_audit_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
                actor_principal_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                subject_principal_id TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS document_collaboration_audit_room
                ON document_collaboration_audit_events (room_id, event_id);
            CREATE TABLE IF NOT EXISTS document_collaboration_presence (
                room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
                client_id TEXT NOT NULL,
                principal_id TEXT NOT NULL,
                selection_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (room_id, client_id)
            );
            CREATE INDEX IF NOT EXISTS document_collaboration_presence_active
                ON document_collaboration_presence (room_id, updated_at_ms);
            ",
        )
        .map_err(sqlite_error)?;
    ensure_rooms_presence_generation(connection)
}

fn ensure_rooms_presence_generation(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(document_collaboration_rooms)")
        .map_err(sqlite_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    if !columns.iter().any(|column| column == "presence_generation") {
        connection.execute("ALTER TABLE document_collaboration_rooms ADD COLUMN presence_generation INTEGER NOT NULL DEFAULT 0 CHECK(presence_generation >= 0)", []).map_err(sqlite_error)?;
    }
    Ok(())
}

fn insert_room_member(
    connection: &Connection,
    room_id: &str,
    principal: &DocumentCollaborationPrincipal,
    role: DocumentCollaborationRoomRole,
    access_token: Option<&str>,
) -> Result<(), String> {
    connection.execute(
        "INSERT INTO document_collaboration_room_members (room_id, principal_id, display_name, role, token_hash, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![room_id, principal.id, principal.display_name, role_to_sql(role), access_token.map(token_hash), unix_millis()?],
    ).map_err(sqlite_error)?;
    Ok(())
}

fn require_room_role(
    connection: &Connection,
    room_id: &str,
    principal_id: &str,
) -> Result<DocumentCollaborationRoomRole, String> {
    connection.query_row(
        "SELECT role FROM document_collaboration_room_members WHERE room_id = ?1 AND principal_id = ?2 AND revoked_at_ms IS NULL",
        params![room_id, principal_id],
        |row| row.get::<_, String>(0),
    ).optional().map_err(sqlite_error)?
        .ok_or_else(|| "The collaboration principal is not a room member".to_string())
        .and_then(|role| role_from_sql(&role))
}

fn record_audit(
    connection: &Connection,
    room_id: &str,
    actor_principal_id: &str,
    event_type: &str,
    subject_principal_id: &str,
) -> Result<(), String> {
    connection.execute(
        "INSERT INTO document_collaboration_audit_events (room_id, actor_principal_id, event_type, subject_principal_id, occurred_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![room_id, actor_principal_id, event_type, subject_principal_id, unix_millis()?],
    ).map_err(sqlite_error)?;
    Ok(())
}

fn create_principal_id(connection: &Connection, room_id: &str) -> Result<String, String> {
    loop {
        let principal_id = random_principal_id()?;
        let exists = connection.query_row(
            "SELECT 1 FROM document_collaboration_room_members WHERE room_id = ?1 AND principal_id = ?2",
            params![room_id, principal_id],
            |_| Ok(()),
        ).optional().map_err(sqlite_error)?;
        if exists.is_none() {
            return Ok(principal_id);
        }
    }
}

fn token_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn validate_principal(principal: &DocumentCollaborationPrincipal) -> Result<(), String> {
    validate_identifier(&principal.id, "principalId")?;
    validate_display_name(&principal.display_name)
}

fn validate_display_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("displayName must contain between 1 and 128 non-control characters".into());
    }
    Ok(())
}

fn unix_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch".to_string())?;
    i64::try_from(duration.as_millis())
        .map_err(|_| "System clock exceeds SQLite timestamp range".into())
}

// SQLite's stored role spelling belongs to storage, not the shared wire contract.
fn role_to_sql(role: DocumentCollaborationRoomRole) -> &'static str {
    match role {
        DocumentCollaborationRoomRole::Owner => "owner",
        DocumentCollaborationRoomRole::Editor => "editor",
        DocumentCollaborationRoomRole::Viewer => "viewer",
    }
}

fn role_from_sql(value: &str) -> Result<DocumentCollaborationRoomRole, String> {
    match value {
        "owner" => Ok(DocumentCollaborationRoomRole::Owner),
        "editor" => Ok(DocumentCollaborationRoomRole::Editor),
        "viewer" => Ok(DocumentCollaborationRoomRole::Viewer),
        _ => Err("The collaboration room contains an invalid member role".into()),
    }
}

fn create_room_id(transaction: &Transaction<'_>) -> Result<String, String> {
    loop {
        let room_id = random_room_id()?;
        if load_room(transaction, &room_id)?.is_none() {
            return Ok(room_id);
        }
    }
}

fn load_room(connection: &Connection, room_id: &str) -> Result<Option<PersistedRoom>, String> {
    connection
        .query_row(
            "SELECT schema_id, document, version, presence_generation FROM document_collaboration_rooms WHERE room_id = ?1",
            [room_id],
            |row| {
                Ok(PersistedRoom {
                    schema_id: row.get(0)?,
                    document: row.get(1)?,
                    version: from_sql_integer(row.get(2)?)?,
                    presence_generation: from_sql_integer(row.get(3)?)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
}

struct PersistedUpdate {
    update: DocumentCollaborationUpdate,
    document: String,
}

fn load_client_update(
    connection: &Connection,
    room_id: &str,
    client_id: &str,
    sequence: u64,
) -> Result<Option<PersistedUpdate>, String> {
    connection
        .query_row(
            "SELECT version, base_version, transaction_json, document FROM document_collaboration_updates WHERE room_id = ?1 AND client_id = ?2 AND sequence = ?3",
            params![room_id, client_id, to_sql_integer(sequence)?],
            |row| {
                Ok(PersistedUpdate {
                    update: DocumentCollaborationUpdate {
                        room_id: room_id.into(),
                        client_id: client_id.into(),
                        sequence,
                        base_version: from_sql_integer(row.get(1)?)?,
                        version: from_sql_integer(row.get(0)?)?,
                        transaction: row.get(2)?,
                    },
                    document: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
}

fn replay_room(
    connection: &Connection,
    room_id: &str,
    room: PersistedRoom,
    after_version: u64,
) -> Result<DocumentCollaborationReplay, String> {
    let updates = load_updates(connection, room_id)?;
    Ok(replay(
        room_id,
        room.version,
        room.document,
        updates,
        after_version,
    ))
}

fn load_updates(
    connection: &Connection,
    room_id: &str,
) -> Result<Vec<DocumentCollaborationUpdate>, String> {
    let mut statement = connection
        .prepare(
            "SELECT version, client_id, sequence, base_version, transaction_json FROM document_collaboration_updates WHERE room_id = ?1 ORDER BY version DESC LIMIT ?2",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![room_id, MAX_ROOM_HISTORY as i64], |row| {
            Ok(DocumentCollaborationUpdate {
                room_id: room_id.into(),
                version: from_sql_integer(row.get(0)?)?,
                client_id: row.get(1)?,
                sequence: from_sql_integer(row.get(2)?)?,
                base_version: from_sql_integer(row.get(3)?)?,
                transaction: row.get(4)?,
            })
        })
        .map_err(sqlite_error)?;
    let mut updates = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)?;
    updates.reverse();
    Ok(updates)
}

fn to_sql_integer(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "Collaboration version exceeded SQLite's integer range".into())
}

fn from_sql_integer(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Collaboration database lock poisoned".into()
}

fn sqlite_error(error: rusqlite::Error) -> String {
    format!("Collaboration database error: {error}")
}
