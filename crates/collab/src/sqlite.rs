use crate::RoomAuditEvent;
use crate::RoomInvite;
use crate::RoomMember;
use crate::RoomOpenParams;
use crate::RoomOpenResult;
use crate::RoomPresence;
use crate::RoomPresenceReplay;
use crate::RoomPrincipal;
use crate::RoomRole;
use crate::RoomSubmitParams;
use crate::RoomSubmitResult;
use crate::RoomUpdate;
use crate::room::MAX_JAVASCRIPT_SAFE_INTEGER;
use crate::room::MAX_ROOM_HISTORY;
use crate::room::RoomReplay;
use crate::room::random_access_token;
use crate::room::random_principal_id;
use crate::room::random_room_id;
use crate::room::replay;
use crate::room::replay_submit_result;
use crate::room::snapshot;
use crate::room::submit_profile;
use crate::room::validate_identifier;
use crate::room::validate_javascript_safe_integer;
use crate::room::validate_presence_selection;
use crate::room::validate_profile_document;
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
pub struct SqliteRoomStore {
    connection: Mutex<Connection>,
}

struct PersistedRoom {
    epoch: String,
    checkpoint: u64,
    schema_id: String,
    document: String,
    version: u64,
    presence_generation: u64,
}

impl SqliteRoomStore {
    /// Opens or creates the collaboration authority at an explicit SQLite path.
    pub fn open_at(path: impl AsRef<Path>) -> Result<Self, String> {
        let mut connection =
            ash_sqlite::open_sqlite_database(path.as_ref(), ash_sqlite::SqliteDurability::Durable)?;
        ROOM_MIGRATOR.run(&mut connection)?;
        crate::channels::configure_resources(&mut connection).map_err(|e| e.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn open(&self, params: RoomOpenParams) -> Result<RoomOpenResult, String> {
        self.open_inner(None, params)
    }

    /// Opens or creates a room while requiring the principal to be a room member.
    pub fn open_as(
        &self,
        principal: &RoomPrincipal,
        params: RoomOpenParams,
    ) -> Result<RoomOpenResult, String> {
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
        principal: &RoomPrincipal,
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
            insert_room_member(&transaction, room_id, principal, RoomRole::Owner, None)?;
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
        principal: Option<&RoomPrincipal>,
        mut params: RoomOpenParams,
    ) -> Result<RoomOpenResult, String> {
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
        let channel_notes = room_id.starts_with("channel-notes-");
        if channel_notes {
            let principal = principal.ok_or("Channel notes require a channel member")?;
            require_room_role(&transaction, &room_id, &principal.id)?;
            if params.schema_id != "stanza-document-v1" {
                return Err("Channel notes require the document schema".into());
            }
            params.document = r#"{"format":"ash.document","version":2,"documentType":"general","document":{"id":"channel-notes","type":"doc","attrs":{},"marks":[],"content":[{"id":"channel-notes-paragraph","type":"paragraph","attrs":{},"marks":[],"content":[]}]}}"#.into();
        }
        if let Some(room) = load_room(&transaction, &room_id)? {
            if room.schema_id != params.schema_id {
                return Err("The collaboration room uses a different document schema".into());
            }
            if let Some(principal) = principal {
                require_room_role(&transaction, &room_id, &principal.id)?;
            }
            if params.lease == Some(true) {
                renew_lease(&transaction, &room_id, &params.client_id)?;
            }
            let result = RoomOpenResult {
                client_id: params.client_id.clone(),
                schema_id: room.schema_id.clone(),
                snapshot: persisted_snapshot(&room_id, &room),
            };
            transaction.commit().map_err(sqlite_error)?;
            return Ok(result);
        }
        validate_profile_document(&params.schema_id, &params.document)?;
        transaction
            .execute(
                "INSERT INTO document_collaboration_rooms (room_id, schema_id, document, version, epoch) VALUES (?1, ?2, ?3, 0, lower(hex(randomblob(16))))",
                params![room_id, params.schema_id, params.document],
            )
            .map_err(sqlite_error)?;
        if let Some(principal) = principal.filter(|_| !channel_notes) {
            insert_room_member(&transaction, &room_id, principal, RoomRole::Owner, None)?;
            record_audit(
                &transaction,
                &room_id,
                &principal.id,
                "room.created",
                &principal.id,
            )?;
        }
        if params.lease == Some(true) {
            renew_lease(&transaction, &room_id, &params.client_id)?;
        }
        let mut initial = snapshot(&room_id, 0, params.document);
        initial.epoch = Some(room_epoch(&transaction, &room_id)?);
        let result = RoomOpenResult {
            client_id: params.client_id.clone(),
            schema_id: params.schema_id,
            snapshot: initial,
        };
        transaction.commit().map_err(sqlite_error)?;
        Ok(result)
    }

    pub fn submit(&self, params: RoomSubmitParams) -> Result<RoomSubmitResult, String> {
        self.submit_inner(None, params)
    }

    /// Submits one update only when the principal has owner or editor authority.
    pub fn submit_as(
        &self,
        principal: &RoomPrincipal,
        params: RoomSubmitParams,
    ) -> Result<RoomSubmitResult, String> {
        validate_principal(principal)?;
        self.submit_inner(Some(principal), params)
    }

    /// Resolves the current room role for an authenticated principal.
    pub fn room_role_as(
        &self,
        principal: &RoomPrincipal,
        room_id: &str,
    ) -> Result<RoomRole, String> {
        validate_principal(principal)?;
        validate_identifier(room_id, "roomId")?;
        let connection = self.connection.lock().map_err(lock_error)?;
        require_room_role(&connection, room_id, &principal.id)
    }

    fn submit_inner(
        &self,
        principal: Option<&RoomPrincipal>,
        params: RoomSubmitParams,
    ) -> Result<RoomSubmitResult, String> {
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
        if params
            .epoch
            .as_deref()
            .is_some_and(|epoch| epoch != room.epoch)
        {
            return Ok(RoomSubmitResult::Resync {
                snapshot: persisted_snapshot(&params.room_id, &room),
            });
        }
        let lease = transaction.query_row("SELECT expires, last_sequence FROM collaboration_clients WHERE room_id=?1 AND client_id=?2", params![params.room_id, params.client_id], |row| Ok((from_sql_integer(row.get(0)?)?,from_sql_integer(row.get(1)?)?))).optional().map_err(sqlite_error)?;
        let now = crate::room::now_millis()?;
        if lease.is_some_and(|(expires, _)| expires <= now) {
            return Err("collab.leaseExpired".into());
        }
        if let Some(update) = load_client_update(&transaction, &params)? {
            transaction.commit().map_err(sqlite_error)?;
            return Ok(RoomSubmitResult::Accepted { update });
        }
        if lease.is_some_and(|(_, sequence)| params.sequence <= sequence) {
            return Err("collab.leaseExpired".into());
        }
        if params.base_version > room.version {
            return Err("baseVersion cannot be newer than the collaboration room".into());
        }
        if params.base_version != room.version {
            let replay = replay_room(&transaction, &params.room_id, room, params.base_version)?;
            transaction.commit().map_err(sqlite_error)?;
            return Ok(replay_submit_result(replay));
        }
        let canonical_document = submit_profile(
            &room.schema_id,
            &room.document,
            &params.transaction,
            &params.document,
        )?;
        let version = room
            .version
            .checked_add(1)
            .filter(|version| *version <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                "The collaboration room version exceeded JavaScript's safe integer range"
                    .to_string()
            })?;
        let update = RoomUpdate {
            epoch: Some(room.epoch.clone()),
            room_id: params.room_id.clone(),
            client_id: params.client_id.clone(),
            sequence: params.sequence,
            base_version: params.base_version,
            version,
            transaction: params.transaction.clone(),
        };
        let checkpoint = room.schema_id != crate::markdown::SCHEMA || version % 64 == 0;
        transaction.execute("UPDATE document_collaboration_rooms SET document=CASE WHEN ?4 THEN ?2 ELSE document END, checkpoint_version=CASE WHEN ?4 THEN ?3 ELSE checkpoint_version END, version=?3 WHERE room_id=?1", params![&update.room_id, &canonical_document, to_sql_integer(version)?, checkpoint]).map_err(sqlite_error)?;
        if let Some(principal) = principal {
            record_audit(
                &transaction,
                &update.room_id,
                &principal.id,
                "document.submitted",
                &update.client_id,
            )?;
        }
        transaction.execute("INSERT INTO document_collaboration_updates (room_id, version, client_id, sequence, base_version, transaction_json) VALUES (?1,?2,?3,?4,?5,?6)", params![update.room_id, to_sql_integer(version)?, update.client_id, to_sql_integer(update.sequence)?, to_sql_integer(update.base_version)?, update.transaction]).map_err(sqlite_error)?;
        transaction
            .execute(
                "INSERT INTO collaboration_receipts VALUES (?1,?2,?3,?4,?5)",
                params![
                    update.room_id,
                    update.client_id,
                    to_sql_integer(update.sequence)?,
                    to_sql_integer(version)?,
                    crate::room::request_digest(&params)
                ],
            )
            .map_err(sqlite_error)?;
        if lease.is_some() {
            transaction.execute("UPDATE collaboration_clients SET last_sequence=?3, expires=?4 WHERE room_id=?1 AND client_id=?2", params![update.room_id, update.client_id, to_sql_integer(update.sequence)?, unix_millis()? + crate::room::LEASE_MILLIS as i64]).map_err(sqlite_error)?;
            transaction.execute("DELETE FROM collaboration_receipts WHERE room_id=?1 AND client_id=?2 AND sequence <= ?3", params![update.room_id, update.client_id, to_sql_integer(update.sequence.saturating_sub(crate::room::RECEIPTS_PER_CLIENT))?]).map_err(sqlite_error)?;
        }
        transaction
            .execute(
                "DELETE FROM document_collaboration_updates WHERE room_id=?1 AND version <= ?2",
                params![
                    update.room_id,
                    to_sql_integer(version.saturating_sub(MAX_ROOM_HISTORY as u64))?
                ],
            )
            .map_err(sqlite_error)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(RoomSubmitResult::Accepted { update })
    }

    pub fn status_as(
        &self,
        principal: Option<&RoomPrincipal>,
        params: crate::RoomStatusParams,
    ) -> Result<crate::RoomStatus, String> {
        validate_identifier(&params.room_id, "roomId")?;
        validate_identifier(&params.client_id, "clientId")?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let can_edit = if let Some(principal) = principal {
            require_room_role(&tx, &params.room_id, &principal.id)?.can_submit()
        } else {
            true
        };
        let (epoch, version) = tx
            .query_row(
                "SELECT epoch, version FROM document_collaboration_rooms WHERE room_id=?1",
                [&params.room_id],
                |row| Ok((row.get::<_, String>(0)?, from_sql_integer(row.get(1)?)?)),
            )
            .optional()
            .map_err(sqlite_error)?
            .ok_or("The collaboration room does not exist")?;
        let leased: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_clients WHERE room_id=?1 AND client_id=?2)", params![params.room_id,params.client_id], |row| row.get(0)).map_err(sqlite_error)?;
        if leased {
            renew_lease(&tx, &params.room_id, &params.client_id)?;
        }
        tx.commit().map_err(sqlite_error)?;
        Ok(crate::RoomStatus {
            room_id: params.room_id,
            epoch,
            version,
            can_edit,
        })
    }

    pub fn replay(&self, room_id: &str, after_version: u64) -> Result<RoomReplay, String> {
        self.replay_inner(None, room_id, after_version)
    }

    /// Reads room replay state only when the principal is a current member.
    pub fn replay_as(
        &self,
        principal: &RoomPrincipal,
        room_id: &str,
        after_version: u64,
    ) -> Result<RoomReplay, String> {
        validate_principal(principal)?;
        self.replay_inner(Some(principal), room_id, after_version)
    }

    fn replay_inner(
        &self,
        principal: Option<&RoomPrincipal>,
        room_id: &str,
        after_version: u64,
    ) -> Result<RoomReplay, String> {
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
        owner: &RoomPrincipal,
        display_name: &str,
        role: RoomRole,
    ) -> Result<RoomInvite, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        validate_display_name(display_name)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let owner_role = require_room_role(&transaction, room_id, &owner.id)?;
        if owner_role != RoomRole::Owner {
            return Err("Only collaboration room owners may invite members".into());
        }
        let principal_id = create_principal_id(&transaction, room_id)?;
        let access_token = random_access_token()?;
        let principal = RoomPrincipal {
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
        Ok(RoomInvite {
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
    ) -> Result<Option<RoomPrincipal>, String> {
        validate_identifier(room_id, "roomId")?;
        if access_token.is_empty() {
            return Ok(None);
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        if room_id.starts_with("channel-notes-") {
            return crate::channels::resource_identity(
                &connection,
                &token_hash(access_token),
                crate::channels::ChannelResourceKind::Notes,
            )
            .map(|identity| {
                identity
                    .filter(|(id, _)| id == room_id)
                    .map(|(_, member)| RoomPrincipal {
                        id: member.id,
                        display_name: member.name,
                    })
            })
            .or_else(|error| match error {
                crate::channels::ChannelError::Denied => Ok(None),
                _ => Err(format!("Collaboration database error: {error}")),
            });
        }
        connection.query_row(
            "SELECT principal_id, display_name FROM document_collaboration_room_members WHERE room_id = ?1 AND token_hash = ?2 AND revoked_at_ms IS NULL",
            params![room_id, token_hash(access_token)],
            |row| Ok(RoomPrincipal { id: row.get(0)?, display_name: row.get(1)? }),
        ).optional().map_err(sqlite_error)
    }

    /// Lists the room's active members. Only owners may inspect membership.
    pub fn list_members(
        &self,
        room_id: &str,
        owner: &RoomPrincipal,
    ) -> Result<Vec<RoomMember>, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        if require_room_role(&connection, room_id, &owner.id)? != RoomRole::Owner {
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
                Ok(RoomMember {
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
        owner: &RoomPrincipal,
        principal_id: &str,
    ) -> Result<(), String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        validate_identifier(principal_id, "principalId")?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        if require_room_role(&transaction, room_id, &owner.id)? != RoomRole::Owner {
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
        owner: &RoomPrincipal,
        principal_id: &str,
    ) -> Result<RoomInvite, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        validate_identifier(principal_id, "principalId")?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        if require_room_role(&transaction, room_id, &owner.id)? != RoomRole::Owner {
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
        Ok(RoomInvite {
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
        owner: &RoomPrincipal,
    ) -> Result<Vec<RoomAuditEvent>, String> {
        validate_identifier(room_id, "roomId")?;
        validate_principal(owner)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        if require_room_role(&connection, room_id, &owner.id)? != RoomRole::Owner {
            return Err("Only collaboration room owners may inspect the audit log".into());
        }
        let mut statement = connection.prepare(
            "SELECT event_id, actor_principal_id, event_type, subject_principal_id, occurred_at_ms FROM document_collaboration_audit_events WHERE room_id = ?1 ORDER BY event_id",
        ).map_err(sqlite_error)?;
        let events = statement
            .query_map([room_id], |row| {
                Ok(RoomAuditEvent {
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
        principal: &RoomPrincipal,
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
        principal: &RoomPrincipal,
        room_id: &str,
        after_generation: u64,
    ) -> Result<RoomPresenceReplay, String> {
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
                Ok(RoomPresence {
                    client_id: row.get(0)?,
                    selection: row.get(1)?,
                })
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        Ok(RoomPresenceReplay {
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

const ROOM_MIGRATOR: ash_sqlite::Migrator<'_> = ash_sqlite::Migrator::new(
    "document-rooms",
    &[ash_sqlite::Migration::legacy_baseline(2, adopt_rooms_v2)],
);

fn adopt_rooms_v2(
    transaction: &rusqlite::Transaction<'_>,
    _version: Option<u32>,
) -> Result<(), String> {
    adopt_rooms_schema(transaction).map_err(sqlite_error)?;
    upgrade_rooms_v2(transaction)
}

fn adopt_rooms_schema(transaction: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(include_str!("../migrations/document-rooms/0001_rooms.sql"))?;
    let has_presence_generation = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('document_collaboration_rooms')
         WHERE name = 'presence_generation')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !has_presence_generation {
        transaction.execute_batch(include_str!(
            "../migrations/document-rooms/legacy/add_presence_generation.sql"
        ))?;
    }
    Ok(())
}

fn insert_room_member(
    connection: &Connection,
    room_id: &str,
    principal: &RoomPrincipal,
    role: RoomRole,
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
) -> Result<RoomRole, String> {
    if room_id.starts_with("channel-notes-") {
        let member = crate::channels::resource_members(connection, room_id)
            .map_err(|e| e.to_string())?
            .unwrap_or_default()
            .into_iter()
            .find(|m| m.id == principal_id)
            .ok_or("The collaboration principal is not a room member")?;
        // Channel owners administer membership through the channel authority. A note
        // must never mint an independent invitation that bypasses channel revocation.
        return Ok(match member.role {
            crate::channels::ChannelRole::Owner | crate::channels::ChannelRole::Editor => {
                RoomRole::Editor
            }
            crate::channels::ChannelRole::Viewer => RoomRole::Viewer,
        });
    }
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

fn validate_principal(principal: &RoomPrincipal) -> Result<(), String> {
    validate_identifier(&principal.id, "principalId")?;
    validate_display_name(&principal.display_name)
}

fn validate_display_name(value: &str) -> Result<(), String> {
    if !crate::room::valid_display_name(value, 128) {
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
fn role_to_sql(role: RoomRole) -> &'static str {
    match role {
        RoomRole::Owner => "owner",
        RoomRole::Editor => "editor",
        RoomRole::Viewer => "viewer",
    }
}

fn role_from_sql(value: &str) -> Result<RoomRole, String> {
    match value {
        "owner" => Ok(RoomRole::Owner),
        "editor" => Ok(RoomRole::Editor),
        "viewer" => Ok(RoomRole::Viewer),
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
    let mut room = connection.query_row("SELECT schema_id, document, version, presence_generation, epoch, checkpoint_version FROM document_collaboration_rooms WHERE room_id=?1", [room_id], |row| Ok(PersistedRoom { schema_id: row.get(0)?, document: row.get(1)?, version: from_sql_integer(row.get(2)?)?, presence_generation: from_sql_integer(row.get(3)?)?, epoch: row.get(4)?, checkpoint: from_sql_integer(row.get(5)?)? })).optional().map_err(sqlite_error)?;
    if let Some(room) = &mut room {
        if room.schema_id == crate::markdown::SCHEMA && room.checkpoint < room.version {
            let mut statement = connection.prepare("SELECT transaction_json FROM document_collaboration_updates WHERE room_id=?1 AND version>?2 ORDER BY version").map_err(sqlite_error)?;
            let updates = statement
                .query_map(params![room_id, to_sql_integer(room.checkpoint)?], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(sqlite_error)?;
            for update in updates {
                room.document =
                    crate::markdown::merge(&room.document, &update.map_err(sqlite_error)?)?;
            }
        }
    }
    Ok(room)
}

fn load_client_update(
    connection: &Connection,
    params: &RoomSubmitParams,
) -> Result<Option<RoomUpdate>, String> {
    let receipt = connection.query_row("SELECT version, digest FROM collaboration_receipts WHERE room_id=?1 AND client_id=?2 AND sequence=?3", params![params.room_id, params.client_id, to_sql_integer(params.sequence)?], |row| Ok((from_sql_integer(row.get(0)?)?,row.get::<_,String>(1)?))).optional().map_err(sqlite_error)?;
    match receipt {
        None => Ok(None),
        Some((version, digest)) => {
            if digest != crate::room::request_digest(params) {
                return Err("sequence has already been used by this collaboration client".into());
            }
            Ok(Some(RoomUpdate {
                epoch: Some(room_epoch(connection, &params.room_id)?),
                room_id: params.room_id.clone(),
                client_id: params.client_id.clone(),
                sequence: params.sequence,
                base_version: params.base_version,
                version,
                transaction: params.transaction.clone(),
            }))
        }
    }
}

fn replay_room(
    connection: &Connection,
    room_id: &str,
    room: PersistedRoom,
    after_version: u64,
) -> Result<RoomReplay, String> {
    let updates = load_updates(connection, room_id)?;
    Ok(replay(
        room_id,
        room.version,
        room.document,
        updates,
        after_version,
    ))
}

fn load_updates(connection: &Connection, room_id: &str) -> Result<Vec<RoomUpdate>, String> {
    let mut statement = connection
        .prepare(
            "SELECT version, client_id, sequence, base_version, transaction_json FROM document_collaboration_updates WHERE room_id = ?1 ORDER BY version DESC LIMIT ?2",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![room_id, MAX_ROOM_HISTORY as i64], |row| {
            Ok(RoomUpdate {
                epoch: None,
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

fn persisted_snapshot(id: &str, room: &PersistedRoom) -> crate::RoomSnapshot {
    crate::RoomSnapshot {
        room_id: id.into(),
        epoch: Some(room.epoch.clone()),
        version: room.version,
        document: room.document.clone(),
    }
}
fn room_epoch(connection: &Connection, id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT epoch FROM document_collaboration_rooms WHERE room_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)
}
fn renew_lease(connection: &Connection, room: &str, client: &str) -> Result<(), String> {
    let now = unix_millis()?;
    let expires = connection
        .query_row(
            "SELECT expires FROM collaboration_clients WHERE room_id=?1 AND client_id=?2",
            params![room, client],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(sqlite_error)?;
    if expires.is_some_and(|expires| expires <= now) {
        return Err("collab.leaseExpired".into());
    }
    if expires.is_some_and(|expires| expires - now > crate::room::LEASE_MILLIS as i64 / 2) {
        return Ok(());
    }
    connection.execute("INSERT INTO collaboration_clients VALUES (?1,?2,?3,0) ON CONFLICT(room_id,client_id) DO UPDATE SET expires=excluded.expires", params![room,client, now + crate::room::LEASE_MILLIS as i64]).map_err(sqlite_error)?;
    // Expired clients can never reuse their identities, so their receipts can be reclaimed.
    connection.execute("DELETE FROM collaboration_receipts WHERE room_id=?1 AND client_id IN (SELECT client_id FROM collaboration_clients WHERE room_id=?1 AND expires<=?2)", params![room,now]).map_err(sqlite_error)?;
    Ok(())
}
fn upgrade_rooms_v2(tx: &Transaction<'_>) -> Result<(), String> {
    let upgraded: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('document_collaboration_rooms') WHERE name='epoch')", [], |row| row.get(0)).map_err(sqlite_error)?;
    if upgraded {
        return Ok(());
    }
    tx.execute_batch(include_str!(
        "../migrations/document-rooms/0002_checkpoints.sql"
    ))
    .map_err(sqlite_error)?;
    let mut statement = tx.prepare("SELECT room_id,client_id,sequence,version,base_version,transaction_json,document FROM document_collaboration_updates").map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                RoomSubmitParams {
                    epoch: None,
                    room_id: row.get(0)?,
                    client_id: row.get(1)?,
                    sequence: from_sql_integer(row.get(2)?)?,
                    base_version: from_sql_integer(row.get(4)?)?,
                    transaction: row.get(5)?,
                    document: row.get(6)?,
                },
                from_sql_integer(row.get(3)?)?,
            ))
        })
        .map_err(sqlite_error)?;
    for row in rows {
        let (params, version) = row.map_err(sqlite_error)?;
        tx.execute(
            "INSERT INTO collaboration_receipts VALUES (?1,?2,?3,?4,?5)",
            params![
                params.room_id,
                params.client_id,
                to_sql_integer(params.sequence)?,
                to_sql_integer(version)?,
                crate::room::request_digest(&params)
            ],
        )
        .map_err(sqlite_error)?;
    }
    drop(statement);
    tx.execute_batch("ALTER TABLE document_collaboration_updates DROP COLUMN document;")
        .map_err(sqlite_error)
}
