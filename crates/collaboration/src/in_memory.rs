use crate::DocumentCollaborationOpenParams;
use crate::DocumentCollaborationOpenResult;
use crate::DocumentCollaborationPresence;
use crate::DocumentCollaborationPresenceParams;
use crate::DocumentCollaborationPresenceReadParams;
use crate::DocumentCollaborationPresenceSnapshot;
use crate::DocumentCollaborationSubmitParams;
use crate::DocumentCollaborationSubmitResult;
use crate::DocumentCollaborationUpdate;
use crate::room::DocumentCollaborationReplay;
use crate::room::MAX_JAVASCRIPT_SAFE_INTEGER;
use crate::room::MAX_ROOM_HISTORY;
use crate::room::random_room_id;
use crate::room::replay;
use crate::room::replay_submit_result;
use crate::room::snapshot;
use crate::room::validate_document;
use crate::room::validate_identifier;
use crate::room::validate_javascript_safe_integer;
use crate::room::validate_presence_selection;
use crate::room::validate_transaction;
use std::collections::BTreeMap;
use std::collections::VecDeque;

/// In-memory authority for clients connected to one App Server process.
#[derive(Default)]
pub struct InMemoryDocumentCollaborationRooms {
    rooms: BTreeMap<String, DocumentCollaborationRoom>,
}

struct DocumentCollaborationRoom {
    schema_id: String,
    document: String,
    version: u64,
    presence_generation: u64,
    presences: BTreeMap<String, String>,
    updates: VecDeque<DocumentCollaborationUpdate>,
    submitted_operations: BTreeMap<(String, u64), SubmittedOperation>,
}

struct SubmittedOperation {
    update: DocumentCollaborationUpdate,
    document: String,
}

impl InMemoryDocumentCollaborationRooms {
    pub fn open(
        &mut self,
        params: DocumentCollaborationOpenParams,
    ) -> Result<DocumentCollaborationOpenResult, String> {
        validate_identifier(&params.client_id, "clientId")?;
        validate_identifier(&params.schema_id, "schemaId")?;
        let room_id = match params.room_id {
            Some(room_id) => {
                validate_identifier(&room_id, "roomId")?;
                room_id
            }
            None => self.create_room_id()?,
        };
        if let Some(room) = self.rooms.get(&room_id) {
            if room.schema_id != params.schema_id {
                return Err("The collaboration room uses a different document schema".into());
            }
            return Ok(DocumentCollaborationOpenResult {
                client_id: params.client_id,
                schema_id: room.schema_id.clone(),
                snapshot: snapshot(&room_id, room.version, room.document.clone()),
            });
        }
        validate_document(&params.document)?;
        let room = DocumentCollaborationRoom {
            schema_id: params.schema_id.clone(),
            document: params.document,
            version: 0,
            presence_generation: 0,
            presences: BTreeMap::new(),
            updates: VecDeque::new(),
            submitted_operations: BTreeMap::new(),
        };
        let result = DocumentCollaborationOpenResult {
            client_id: params.client_id,
            schema_id: room.schema_id.clone(),
            snapshot: snapshot(&room_id, room.version, room.document.clone()),
        };
        self.rooms.insert(room_id, room);
        Ok(result)
    }

    pub fn submit(
        &mut self,
        params: DocumentCollaborationSubmitParams,
    ) -> Result<DocumentCollaborationSubmitResult, String> {
        validate_identifier(&params.room_id, "roomId")?;
        validate_identifier(&params.client_id, "clientId")?;
        validate_javascript_safe_integer(params.sequence, "sequence", 1)?;
        validate_javascript_safe_integer(params.base_version, "baseVersion", 0)?;
        let Some(room) = self.rooms.get_mut(&params.room_id) else {
            return Err("The collaboration room does not exist".into());
        };
        let operation_key = (params.client_id.clone(), params.sequence);
        if let Some(operation) = room.submitted_operations.get(&operation_key) {
            if operation.update.base_version != params.base_version
                || operation.update.transaction != params.transaction
                || operation.document != params.document
            {
                return Err("sequence has already been used by this collaboration client".into());
            }
            return Ok(DocumentCollaborationSubmitResult::Accepted {
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
        room.version = version;
        room.document = params.document.clone();
        room.updates.push_back(update.clone());
        room.submitted_operations.insert(
            operation_key,
            SubmittedOperation {
                update: update.clone(),
                document: params.document,
            },
        );
        while room.updates.len() > MAX_ROOM_HISTORY {
            room.updates.pop_front();
        }
        Ok(DocumentCollaborationSubmitResult::Accepted { update })
    }

    pub fn replay(
        &self,
        room_id: &str,
        after_version: u64,
    ) -> Result<DocumentCollaborationReplay, String> {
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
        params: DocumentCollaborationPresenceParams,
    ) -> Result<DocumentCollaborationPresenceSnapshot, String> {
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
        params: DocumentCollaborationPresenceReadParams,
    ) -> Result<DocumentCollaborationPresenceSnapshot, String> {
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

fn presence_snapshot(
    room_id: &str,
    room: &DocumentCollaborationRoom,
) -> DocumentCollaborationPresenceSnapshot {
    DocumentCollaborationPresenceSnapshot {
        room_id: room_id.into(),
        generation: room.presence_generation,
        presences: room
            .presences
            .iter()
            .map(|(client_id, selection)| DocumentCollaborationPresence {
                client_id: client_id.clone(),
                selection: selection.clone(),
            })
            .collect(),
    }
}
