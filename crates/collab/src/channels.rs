//! SQLite is the single authority for space membership and its inherited channel permissions.
use ash_secrets::SecretValue;
pub use contract::channels::*;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelError {
    Invalid,
    Denied,
    Conflict,
    Storage,
    Transport,
}
impl std::fmt::Display for ChannelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Channel operation failed: {self:?}")
    }
}
impl std::error::Error for ChannelError {}
impl From<rusqlite::Error> for ChannelError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

/// A member credential is never stored in the room database or included in snapshots.
#[derive(Debug)]
pub struct ChannelCredential(SecretValue);
impl ChannelCredential {
    pub fn generate() -> Result<Self, ChannelError> {
        Self::parse(identifier()?)
    }
    pub fn parse(value: String) -> Result<Self, ChannelError> {
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ChannelError::Invalid);
        }
        Ok(Self(SecretValue::new(value.into_bytes())))
    }
    pub fn expose(&self) -> &str {
        std::str::from_utf8(self.0.expose()).expect("hexadecimal credential")
    }
    fn digest(&self) -> String {
        format!("{:x}", Sha256::digest(self.0.expose()))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Space {
    id: String,
    name: String,
    revision: u64,
    channels: Vec<Channel>,
    members: Vec<ChannelMember>,
}
impl Space {
    fn snapshot(self, member_id: String) -> ChannelSnapshot {
        ChannelSnapshot {
            id: self.id,
            name: self.name,
            revision: self.revision,
            channels: self.channels,
            members: self.members,
            member_id,
        }
    }
}

pub struct ChannelStore {
    connection: Mutex<Connection>,
}
impl ChannelStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ChannelError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        configure_resources(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Issues a credential restricted to one channel resource. Membership is checked again
    /// by every resource operation; a saved grant never outlives channel access.
    pub fn resource(
        &self,
        credential: &ChannelCredential,
        params: ChannelResourceParams,
        kind: ChannelResourceKind,
    ) -> Result<ChannelResourceAccess, ChannelError> {
        let mut connection = self.connection.lock().map_err(|_| ChannelError::Storage)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (space, member) = load(&tx, credential)?;
        if space.id != params.space_id || !space.channels.iter().any(|c| c.id == params.channel_id)
        {
            return Err(ChannelError::Denied);
        }
        let resource = format!("{}{}", kind.prefix(), params.channel_id);
        // Domain separation makes a leaked resource token unusable as an account token
        // or as a grant for a different channel/resource. Only its hash is persisted.
        let token = format!(
            "{:x}",
            Sha256::digest(
                format!("ash-channel-resource-v1:{}:{resource}", credential.expose()).as_bytes()
            )
        );
        tx.execute(
            "INSERT OR IGNORE INTO collaboration_channel_resources VALUES(?1,?2,?3)",
            params![resource, space.id, params.channel_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO collaboration_resource_grants VALUES(?1,?2,?3)",
            params![
                ChannelCredential::parse(token.clone())?.digest(),
                resource,
                member
            ],
        )?;
        tx.commit()?;
        Ok(ChannelResourceAccess {
            server_url: String::new(),
            resource_id: resource,
            credential: token,
        })
    }

    /// Reusing the same owner credential recovers a create whose response was lost.
    pub fn create(
        &self,
        credential: &ChannelCredential,
        name: &str,
        member_name: &str,
    ) -> Result<ChannelSnapshot, ChannelError> {
        let name = validate_name(name)?;
        let member_name = validate_name(member_name)?;
        let mut connection = self.connection.lock().map_err(|_| ChannelError::Storage)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if identity(&tx, credential)?.is_some() {
            let (space, member) = load(&tx, credential)?;
            if space.name != name
                || !space.members.iter().any(|m| {
                    m.id == member && m.name == member_name && m.role == ChannelRole::Owner
                })
            {
                return Err(ChannelError::Conflict);
            }
            return Ok(space.snapshot(member));
        }
        let member = ChannelMember {
            id: identifier()?,
            name: member_name,
            role: ChannelRole::Owner,
        };
        let member_id = member.id.clone();
        let space = Space {
            id: identifier()?,
            name,
            revision: 0,
            channels: vec![],
            members: vec![member],
        };
        save(&tx, &space)?;
        tx.execute(
            "INSERT INTO collaboration_channel_members VALUES (?1,?2,?3)",
            params![credential.digest(), space.id, member_id],
        )?;
        tx.commit()?;
        Ok(space.snapshot(member_id))
    }

    pub fn read(&self, credential: &ChannelCredential) -> Result<ChannelSnapshot, ChannelError> {
        let mut connection = self.connection.lock().map_err(|_| ChannelError::Storage)?;
        let tx = connection.transaction()?;
        let (space, member) = load(&tx, credential)?;
        Ok(space.snapshot(member))
    }

    pub fn edit(
        &self,
        credential: &ChannelCredential,
        edit: ChannelEditParams,
    ) -> Result<ChannelSnapshot, ChannelError> {
        let mut connection = self.connection.lock().map_err(|_| ChannelError::Storage)?;
        // Role checks, revision checks and writes share one write transaction, including across hosts.
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (mut space, actor) = load(&tx, credential)?;
        let role = space
            .members
            .iter()
            .find(|m| m.id == actor)
            .ok_or(ChannelError::Denied)?
            .role;
        let managing = matches!(
            edit.change,
            ChannelChange::SetRole { .. } | ChannelChange::RemoveMember { .. }
        );
        if role == ChannelRole::Viewer || (managing && role != ChannelRole::Owner) {
            return Err(ChannelError::Denied);
        }
        if space.id != edit.space_id || space.revision != edit.revision {
            return Err(ChannelError::Conflict);
        }
        match edit.change {
            ChannelChange::Create { name, parent_id } => {
                let name = validate_name(&name)?;
                validate_sibling(&space, &name, parent_id.as_deref(), None)?;
                let mut parent = parent_id.as_deref();
                let mut depth = 0;
                while let Some(id) = parent {
                    let channel = space
                        .channels
                        .iter()
                        .find(|c| c.id == id)
                        .ok_or(ChannelError::Invalid)?;
                    depth += 1;
                    if depth >= 16 {
                        return Err(ChannelError::Invalid);
                    }
                    parent = channel.parent_id.as_deref();
                }
                if space.channels.len() >= 1000 {
                    return Err(ChannelError::Invalid);
                }
                space.channels.push(Channel {
                    id: identifier()?,
                    name,
                    parent_id,
                });
            }
            ChannelChange::Rename { channel_id, name } => {
                let name = validate_name(&name)?;
                let channel = space
                    .channels
                    .iter()
                    .find(|c| c.id == channel_id)
                    .ok_or(ChannelError::Conflict)?;
                validate_sibling(
                    &space,
                    &name,
                    channel.parent_id.as_deref(),
                    Some(&channel_id),
                )?;
                space
                    .channels
                    .iter_mut()
                    .find(|c| c.id == channel_id)
                    .ok_or(ChannelError::Conflict)?
                    .name = name;
            }
            ChannelChange::Remove { channel_id } => {
                if !space.channels.iter().any(|c| c.id == channel_id) {
                    return Err(ChannelError::Conflict);
                }
                let mut removed = std::collections::HashSet::from([channel_id]);
                loop {
                    let count = removed.len();
                    for channel in &space.channels {
                        if channel
                            .parent_id
                            .as_ref()
                            .is_some_and(|id| removed.contains(id))
                        {
                            removed.insert(channel.id.clone());
                        }
                    }
                    if removed.len() == count {
                        break;
                    }
                }
                space.channels.retain(|c| !removed.contains(&c.id));
            }
            ChannelChange::SetRole { member_id, role } => {
                protect_owner(&space, &member_id, Some(role))?;
                space
                    .members
                    .iter_mut()
                    .find(|m| m.id == member_id)
                    .ok_or(ChannelError::Conflict)?
                    .role = role;
            }
            ChannelChange::RemoveMember { member_id } => {
                protect_owner(&space, &member_id, None)?;
                // Self-removal would make the response inaccessible. Disconnect is a separate local action.
                if member_id == actor {
                    return Err(ChannelError::Invalid);
                }
                space.members.retain(|m| m.id != member_id);
                tx.execute(
                    "DELETE FROM collaboration_channel_members WHERE space_id=?1 AND member_id=?2",
                    params![space.id, member_id],
                )?;
            }
        }
        if space.revision >= 9_007_199_254_740_991 {
            return Err(ChannelError::Invalid);
        }
        space.revision += 1;
        save(&tx, &space)?;
        tx.commit()?;
        Ok(space.snapshot(actor))
    }

    pub fn invite(
        &self,
        credential: &ChannelCredential,
        invite: ChannelInvite,
    ) -> Result<ChannelSnapshot, ChannelError> {
        let member_credential = ChannelCredential::parse(invite.credential)?;
        let name = validate_name(&invite.params.name)?;
        let mut connection = self.connection.lock().map_err(|_| ChannelError::Storage)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (mut space, actor) = load(&tx, credential)?;
        if !space
            .members
            .iter()
            .any(|m| m.id == actor && m.role == ChannelRole::Owner)
        {
            return Err(ChannelError::Denied);
        }
        if space.id != invite.params.space_id || space.revision != invite.params.revision {
            return Err(ChannelError::Conflict);
        }
        if space.members.len() >= 256 || identity(&tx, &member_credential)?.is_some() {
            return Err(ChannelError::Invalid);
        }
        let member = ChannelMember {
            id: identifier()?,
            name,
            role: invite.params.role,
        };
        tx.execute(
            "INSERT INTO collaboration_channel_members VALUES (?1,?2,?3)",
            params![member_credential.digest(), space.id, member.id],
        )?;
        space.members.push(member);
        if space.revision >= 9_007_199_254_740_991 {
            return Err(ChannelError::Invalid);
        }
        space.revision += 1;
        save(&tx, &space)?;
        tx.commit()?;
        Ok(space.snapshot(actor))
    }
}

fn protect_owner(space: &Space, id: &str, role: Option<ChannelRole>) -> Result<(), ChannelError> {
    let member = space
        .members
        .iter()
        .find(|m| m.id == id)
        .ok_or(ChannelError::Conflict)?;
    if member.role == ChannelRole::Owner
        && role != Some(ChannelRole::Owner)
        && space
            .members
            .iter()
            .filter(|m| m.role == ChannelRole::Owner)
            .count()
            == 1
    {
        return Err(ChannelError::Invalid);
    }
    Ok(())
}
fn validate_sibling(
    space: &Space,
    name: &str,
    parent: Option<&str>,
    except: Option<&str>,
) -> Result<(), ChannelError> {
    if space.channels.iter().any(|c| {
        c.parent_id.as_deref() == parent
            && Some(c.id.as_str()) != except
            && c.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(ChannelError::Conflict);
    }
    Ok(())
}
pub(crate) fn validate_name(name: &str) -> Result<String, ChannelError> {
    let name = name.trim();
    if !crate::room::valid_display_name(name, 80) || name.contains('/') {
        return Err(ChannelError::Invalid);
    }
    Ok(name.into())
}
fn identifier() -> Result<String, ChannelError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| ChannelError::Storage)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn identity(
    connection: &Connection,
    credential: &ChannelCredential,
) -> Result<Option<(String, String)>, ChannelError> {
    Ok(connection
        .query_row(
            "SELECT space_id, member_id FROM collaboration_channel_members WHERE credential=?1",
            [credential.digest()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}
fn load(
    connection: &Connection,
    credential: &ChannelCredential,
) -> Result<(Space, String), ChannelError> {
    let (id, member) = identity(connection, credential)?.ok_or(ChannelError::Denied)?;
    let data: String = connection.query_row(
        "SELECT data FROM collaboration_spaces WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    if data.len() > 1_048_576 {
        return Err(ChannelError::Storage);
    }
    let space: Space = serde_json::from_str(&data).map_err(|_| ChannelError::Storage)?;
    if !space.members.iter().any(|m| m.id == member) {
        return Err(ChannelError::Denied);
    }
    validate_snapshot(&space.clone().snapshot(member.clone()))
        .map_err(|_| ChannelError::Storage)?;
    Ok((space, member))
}
fn save(connection: &Connection, space: &Space) -> Result<(), ChannelError> {
    let data = serde_json::to_string(space).map_err(|_| ChannelError::Storage)?;
    connection.execute("INSERT INTO collaboration_spaces VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![space.id, data])?;
    Ok(())
}

#[cfg(test)]
#[path = "channels_tests.rs"]
mod tests;

// Bound persisted and remote trees and reject cycles before they reach UI recursion.
pub(crate) fn validate_snapshot(snapshot: &ChannelSnapshot) -> Result<(), ChannelError> {
    if snapshot.channels.len() > 1000
        || snapshot.members.is_empty()
        || snapshot.members.len() > 256
        || snapshot.revision > 9_007_199_254_740_991
        || !snapshot
            .members
            .iter()
            .any(|m| m.role == ChannelRole::Owner)
        || !snapshot.members.iter().any(|m| m.id == snapshot.member_id)
    {
        return Err(ChannelError::Invalid);
    }
    let mut ids = std::collections::HashSet::new();
    for channel in &snapshot.channels {
        if !ids.insert(&channel.id)
            || !valid_id(&channel.id)
            || validate_name(&channel.name).is_err()
        {
            return Err(ChannelError::Invalid);
        }
        let mut parent = channel.parent_id.as_deref();
        let mut depth = 0;
        while let Some(id) = parent {
            depth += 1;
            if depth >= 16 {
                return Err(ChannelError::Invalid);
            }
            parent = snapshot
                .channels
                .iter()
                .find(|c| c.id == id)
                .ok_or(ChannelError::Invalid)?
                .parent_id
                .as_deref();
        }
    }
    let mut ids = std::collections::HashSet::new();
    if !valid_id(&snapshot.id) || validate_name(&snapshot.name).is_err() {
        return Err(ChannelError::Invalid);
    }
    for member in &snapshot.members {
        if !ids.insert(&member.id) || !valid_id(&member.id) || validate_name(&member.name).is_err()
        {
            return Err(ChannelError::Invalid);
        }
    }
    Ok(())
}
fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Resource kinds have distinct identities and credentials, even within the same channel.
#[derive(Clone, Copy)]
pub enum ChannelResourceKind {
    Notes,
    Call,
}
impl ChannelResourceKind {
    pub(crate) fn prefix(self) -> &'static str {
        match self {
            Self::Notes => "channel-notes-",
            Self::Call => "channel-call-",
        }
    }
}

/// Shared-database initialization allows notes and media to authorize inside their own
/// SQLite transactions, rather than checking a stale membership snapshot over an RPC.
pub fn configure_resources(connection: &Connection) -> Result<(), ChannelError> {
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS collaboration_spaces(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collaboration_channel_members(credential TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES collaboration_spaces(id), member_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS collaboration_channel_members_space ON collaboration_channel_members(space_id);
        CREATE TABLE IF NOT EXISTS collaboration_channel_resources(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES collaboration_spaces(id), channel_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collaboration_resource_grants(credential TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES collaboration_channel_resources(id), member_id TEXT NOT NULL);")?;
    Ok(())
}

/// Resolves the current inherited membership for a resource. None means an independent
/// resource; an empty list means a channel was deleted and all access has been revoked.
pub fn resource_members(
    connection: &Connection,
    resource: &str,
) -> Result<Option<Vec<ChannelMember>>, ChannelError> {
    let binding: Option<(String, String)> = connection
        .query_row(
            "SELECT space_id,channel_id FROM collaboration_channel_resources WHERE id=?1",
            [resource],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((space_id, channel_id)) = binding else {
        return Ok(None);
    };
    let data: String = connection.query_row(
        "SELECT data FROM collaboration_spaces WHERE id=?1",
        [space_id],
        |row| row.get(0),
    )?;
    if data.len() > 1_048_576 {
        return Err(ChannelError::Storage);
    }
    let space: Space = serde_json::from_str(&data).map_err(|_| ChannelError::Storage)?;
    let member = space
        .members
        .first()
        .ok_or(ChannelError::Storage)?
        .id
        .clone();
    validate_snapshot(&space.clone().snapshot(member)).map_err(|_| ChannelError::Storage)?;
    Ok(Some(if space.channels.iter().any(|c| c.id == channel_id) {
        space.members
    } else {
        vec![]
    }))
}

/// Authenticate a scoped credential in the caller's resource transaction.
pub fn resource_identity(
    connection: &Connection,
    digest: &str,
    kind: ChannelResourceKind,
) -> Result<Option<(String, ChannelMember)>, ChannelError> {
    let binding: Option<(String, String)> = connection
        .query_row(
            "SELECT resource_id,member_id FROM collaboration_resource_grants WHERE credential=?1",
            [digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((resource, member_id)) = binding else {
        return Ok(None);
    };
    if !resource.starts_with(kind.prefix()) {
        return Err(ChannelError::Denied);
    }
    let member = resource_members(connection, &resource)?
        .unwrap_or_default()
        .into_iter()
        .find(|m| m.id == member_id)
        .ok_or(ChannelError::Denied)?;
    Ok(Some((resource, member)))
}
