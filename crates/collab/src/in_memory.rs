use crate::RoomOpenParams;
use crate::RoomOpenResult;
use crate::RoomPresence;
use crate::RoomPresenceParams;
use crate::RoomPresenceReadParams;
use crate::RoomPresenceSnapshot;
use crate::RoomSubmitParams;
use crate::RoomSubmitResult;
use crate::RoomUpdate;
use crate::room::MAX_JAVASCRIPT_SAFE_INTEGER;
use crate::room::MAX_ROOM_HISTORY;
use crate::room::RoomReplay;
use crate::room::random_room_id;
use crate::room::replay;
use crate::room::replay_submit_result;
use crate::room::snapshot;
use crate::room::submit_profile;
use crate::room::validate_identifier;
use crate::room::validate_javascript_safe_integer;
use crate::room::validate_presence_selection;
use crate::room::validate_profile_document;
use std::collections::BTreeMap;
use std::collections::VecDeque;

/// In-memory authority for clients connected to one App Server process.
#[derive(Default)]
pub struct MemoryRoomStore {
    rooms: BTreeMap<String, Room>,
}

struct Room {
    epoch: String,
    clients: BTreeMap<String, ClientLease>,
    schema_id: String,
    document: String,
    version: u64,
    presence_generation: u64,
    presences: BTreeMap<String, String>,
    updates: VecDeque<RoomUpdate>,
    submitted_operations: BTreeMap<(String, u64), SubmittedOperation>,
}

struct SubmittedOperation {
    update: RoomUpdate,
    digest: String,
}

struct ClientLease {
    expires: u64,
    sequence: u64,
}

impl MemoryRoomStore {
    pub fn open(&mut self, params: RoomOpenParams) -> Result<RoomOpenResult, String> {
        validate_identifier(&params.client_id, "clientId")?;
        validate_identifier(&params.schema_id, "schemaId")?;
        let room_id = match params.room_id {
            Some(room_id) => {
                validate_identifier(&room_id, "roomId")?;
                room_id
            }
            None => self.create_room_id()?,
        };
        if let Some(room) = self.rooms.get_mut(&room_id) {
            if room.schema_id != params.schema_id {
                return Err("The collaboration room uses a different document schema".into());
            }
            if params.lease == Some(true) {
                renew_client(room, &params.client_id)?;
            }
            return Ok(RoomOpenResult {
                client_id: params.client_id,
                schema_id: room.schema_id.clone(),
                snapshot: room_snapshot(&room_id, room),
            });
        }
        validate_profile_document(&params.schema_id, &params.document)?;
        let mut room = Room {
            epoch: crate::room::random_room_id()?,
            clients: BTreeMap::new(),
            schema_id: params.schema_id.clone(),
            document: params.document,
            version: 0,
            presence_generation: 0,
            presences: BTreeMap::new(),
            updates: VecDeque::new(),
            submitted_operations: BTreeMap::new(),
        };
        if params.lease == Some(true) {
            renew_client(&mut room, &params.client_id)?;
        }
        let result = RoomOpenResult {
            client_id: params.client_id,
            schema_id: room.schema_id.clone(),
            snapshot: room_snapshot(&room_id, &room),
        };
        self.rooms.insert(room_id, room);
        Ok(result)
    }

    pub fn submit(&mut self, params: RoomSubmitParams) -> Result<RoomSubmitResult, String> {
        validate_identifier(&params.room_id, "roomId")?;
        validate_identifier(&params.client_id, "clientId")?;
        validate_javascript_safe_integer(params.sequence, "sequence", 1)?;
        validate_javascript_safe_integer(params.base_version, "baseVersion", 0)?;
        let Some(room) = self.rooms.get_mut(&params.room_id) else {
            return Err("The collaboration room does not exist".into());
        };
        if params
            .epoch
            .as_deref()
            .is_some_and(|epoch| epoch != room.epoch)
        {
            return Ok(RoomSubmitResult::Resync {
                snapshot: room_snapshot(&params.room_id, room),
            });
        }
        if let Some(client) = room.clients.get(&params.client_id) {
            if client.expires <= crate::room::now_millis()? {
                return Err("collab.leaseExpired".into());
            }
            if params.sequence <= client.sequence
                && !room
                    .submitted_operations
                    .contains_key(&(params.client_id.clone(), params.sequence))
            {
                return Err("collab.leaseExpired".into());
            }
        }
        let digest = crate::room::request_digest(&params);
        let operation_key = (params.client_id.clone(), params.sequence);
        if let Some(operation) = room.submitted_operations.get(&operation_key) {
            if operation.digest != digest {
                return Err("sequence has already been used by this collaboration client".into());
            }
            return Ok(RoomSubmitResult::Accepted {
                update: operation.update.clone(),
            });
        }
        if params.base_version > room.version {
            return Err("baseVersion cannot be newer than the collaboration room".into());
        }
        if params.base_version != room.version {
            return Ok(replay_submit_result(replay(
                &params.room_id,
                room.version,
                room.document.clone(),
                room.updates.iter().cloned().collect(),
                params.base_version,
            )));
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
            room_id: params.room_id,
            client_id: params.client_id,
            sequence: params.sequence,
            base_version: params.base_version,
            version,
            transaction: params.transaction,
        };
        room.version = version;
        room.document = canonical_document;
        room.updates.push_back(update.clone());
        room.submitted_operations.insert(
            operation_key,
            SubmittedOperation {
                update: update.clone(),
                digest,
            },
        );
        if let Some(client) = room.clients.get_mut(&update.client_id) {
            client.sequence = update.sequence;
            client.expires = crate::room::now_millis()? + crate::room::LEASE_MILLIS;
            let floor = update
                .sequence
                .saturating_sub(crate::room::RECEIPTS_PER_CLIENT);
            room.submitted_operations
                .retain(|(id, seq), _| id != &update.client_id || *seq > floor);
        }
        while room.updates.len() > MAX_ROOM_HISTORY {
            room.updates.pop_front();
        }
        Ok(RoomSubmitResult::Accepted { update })
    }

    pub fn status(&mut self, params: crate::RoomStatusParams) -> Result<crate::RoomStatus, String> {
        validate_identifier(&params.room_id, "roomId")?;
        validate_identifier(&params.client_id, "clientId")?;
        let room = self
            .rooms
            .get_mut(&params.room_id)
            .ok_or("The collaboration room does not exist")?;
        if room.clients.contains_key(&params.client_id) {
            renew_client(room, &params.client_id)?;
        }
        Ok(crate::RoomStatus {
            room_id: params.room_id,
            epoch: room.epoch.clone(),
            version: room.version,
            can_edit: true,
        })
    }

    pub fn replay(&self, room_id: &str, after_version: u64) -> Result<RoomReplay, String> {
        validate_identifier(room_id, "roomId")?;
        validate_javascript_safe_integer(after_version, "afterVersion", 0)?;
        let Some(room) = self.rooms.get(room_id) else {
            return Err("The collaboration room does not exist".into());
        };
        if after_version > room.version {
            return Err("afterVersion cannot be newer than the collaboration room".into());
        }
        Ok(replay(
            room_id,
            room.version,
            room.document.clone(),
            room.updates.iter().cloned().collect(),
            after_version,
        ))
    }

    /// Publishes or clears one room-local client selection without changing document history.
    pub fn publish_presence(
        &mut self,
        params: RoomPresenceParams,
    ) -> Result<RoomPresenceSnapshot, String> {
        validate_identifier(&params.room_id, "roomId")?;
        validate_identifier(&params.client_id, "clientId")?;
        if let Some(selection) = &params.selection {
            validate_presence_selection(selection)?;
        }
        let Some(room) = self.rooms.get_mut(&params.room_id) else {
            return Err("The collaboration room does not exist".into());
        };
        room.presence_generation = room
            .presence_generation
            .checked_add(1)
            .filter(|generation| *generation <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                "The collaboration room presence generation exceeded JavaScript's safe integer range"
                    .to_string()
            })?;
        match params.selection {
            Some(selection) => {
                room.presences.insert(params.client_id, selection);
            }
            None => {
                room.presences.remove(&params.client_id);
            }
        }
        Ok(presence_snapshot(&params.room_id, room))
    }

    /// Reads the current room-local presence set after a client has subscribed to the room.
    pub fn read_presence(
        &self,
        params: RoomPresenceReadParams,
    ) -> Result<RoomPresenceSnapshot, String> {
        validate_identifier(&params.room_id, "roomId")?;
        let Some(room) = self.rooms.get(&params.room_id) else {
            return Err("The collaboration room does not exist".into());
        };
        Ok(presence_snapshot(&params.room_id, room))
    }

    fn create_room_id(&self) -> Result<String, String> {
        loop {
            let room_id = random_room_id()?;
            if !self.rooms.contains_key(&room_id) {
                return Ok(room_id);
            }
        }
    }
}

fn presence_snapshot(room_id: &str, room: &Room) -> RoomPresenceSnapshot {
    RoomPresenceSnapshot {
        room_id: room_id.into(),
        generation: room.presence_generation,
        presences: room
            .presences
            .iter()
            .map(|(client_id, selection)| RoomPresence {
                client_id: client_id.clone(),
                selection: selection.clone(),
            })
            .collect(),
    }
}

fn room_snapshot(id: &str, room: &Room) -> crate::RoomSnapshot {
    let mut value = snapshot(id, room.version, room.document.clone());
    value.epoch = Some(room.epoch.clone());
    value
}
fn renew_client(room: &mut Room, id: &str) -> Result<(), String> {
    let now = crate::room::now_millis()?;
    if room
        .clients
        .get(id)
        .is_some_and(|client| client.expires <= now)
    {
        return Err("collab.leaseExpired".into());
    }
    room.submitted_operations.retain(|(id, _), _| {
        room.clients
            .get(id)
            .is_none_or(|client| client.expires > now)
    });
    room.clients
        .entry(id.into())
        .or_insert(ClientLease {
            expires: now + crate::room::LEASE_MILLIS,
            sequence: 0,
        })
        .expires = now + crate::room::LEASE_MILLIS;
    Ok(())
}
