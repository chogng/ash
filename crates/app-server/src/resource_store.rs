use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Cursor;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

pub const MAX_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_READ_CHUNK_BYTES: usize = 262_144;
const MAX_RESOURCES_PER_CONNECTION: usize = 128;
const MAX_RESOURCE_BYTES_PER_CONNECTION: usize = 64 * 1024 * 1024;

pub struct ResourceStore {
    next_id: AtomicU64,
    resources: BTreeMap<String, Resource>,
    usage_by_connection: BTreeMap<u64, ConnectionResourceUsage>,
}

pub struct ResourceMetadata {
    pub resource_id: String,
    pub mime_type: String,
    pub size: usize,
    pub sha256: String,
}
pub struct ResourceChunk {
    pub offset: usize,
    pub data: Vec<u8>,
    pub eof: bool,
}

struct Resource {
    owner_connection_id: u64,
    mime_type: String,
    payload: Payload,
    sha256: String,
    expires_at: Instant,
}

enum Payload {
    Memory(Vec<u8>),
    File { file: File, size: usize },
}

impl Payload {
    fn len(&self) -> usize {
        match self {
            Self::Memory(bytes) => bytes.len(),
            Self::File { size, .. } => *size,
        }
    }
    fn read(&self, start: usize, end: usize) -> Result<Vec<u8>, ResourceError> {
        match self {
            Self::Memory(bytes) => Ok(bytes[start..end].to_vec()),
            Self::File { file, .. } => {
                let mut reader = file;
                let mut bytes = vec![0; end - start];
                reader
                    .seek(SeekFrom::Start(start as u64))
                    .and_then(|_| reader.read_exact(&mut bytes))
                    .map_err(|_| ResourceError::ReadFailed)?;
                Ok(bytes)
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct ConnectionResourceUsage {
    count: usize,
    bytes: usize,
}

impl ConnectionResourceUsage {
    fn can_add(&self, incoming_bytes: usize) -> bool {
        self.count < MAX_RESOURCES_PER_CONNECTION
            && self
                .bytes
                .checked_add(incoming_bytes)
                .is_some_and(|total| total <= MAX_RESOURCE_BYTES_PER_CONNECTION)
    }
}

impl Default for ResourceStore {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            resources: BTreeMap::new(),
            usage_by_connection: BTreeMap::new(),
        }
    }
}

impl ResourceStore {
    pub fn create(
        &mut self,
        owner_connection_id: u64,
        mime_type: String,
        bytes: Vec<u8>,
        ttl: Duration,
    ) -> Result<ResourceMetadata, ResourceError> {
        self.create_with_limit(
            owner_connection_id,
            mime_type,
            bytes,
            ttl,
            MAX_RESOURCE_BYTES,
        )
    }

    /// Uses an owning domain's bounded read limit without bypassing connection quotas.
    pub(crate) fn create_with_limit(
        &mut self,
        owner_connection_id: u64,
        mime_type: String,
        bytes: Vec<u8>,
        ttl: Duration,
        max_bytes: usize,
    ) -> Result<ResourceMetadata, ResourceError> {
        if bytes.len() > max_bytes {
            return Err(ResourceError::TooLarge);
        }
        let sha256 = format!("sha256:{:x}", Sha256::digest(&bytes));
        self.create_payload(
            owner_connection_id,
            mime_type,
            Payload::Memory(bytes),
            sha256,
            ttl,
        )
    }

    /// Takes ownership of a private file already verified and hashed by the file service.
    pub(crate) fn create_file_snapshot(
        &mut self,
        owner_connection_id: u64,
        mime_type: String,
        file: File,
        size: usize,
        revision: &str,
        ttl: Duration,
    ) -> Result<ResourceMetadata, ResourceError> {
        self.create_payload(
            owner_connection_id,
            mime_type,
            Payload::File { file, size },
            format!("sha256:{revision}"),
            ttl,
        )
    }

    fn create_payload(
        &mut self,
        owner_connection_id: u64,
        mime_type: String,
        payload: Payload,
        sha256: String,
        ttl: Duration,
    ) -> Result<ResourceMetadata, ResourceError> {
        self.cleanup();
        let usage = self
            .usage_by_connection
            .get(&owner_connection_id)
            .copied()
            .unwrap_or_default();
        if !usage.can_add(payload.len()) {
            return Err(ResourceError::TooLarge);
        }
        let resource_id = format!(
            "resource_{:016x}",
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let metadata = ResourceMetadata {
            resource_id: resource_id.clone(),
            mime_type: mime_type.clone(),
            size: payload.len(),
            sha256: sha256.clone(),
        };
        self.resources.insert(
            resource_id,
            Resource {
                owner_connection_id,
                mime_type,
                payload,
                sha256,
                expires_at: Instant::now() + ttl,
            },
        );
        self.usage_by_connection.insert(
            owner_connection_id,
            ConnectionResourceUsage {
                count: usage.count + 1,
                bytes: usage.bytes + metadata.size,
            },
        );
        Ok(metadata)
    }

    pub fn metadata(
        &mut self,
        owner_connection_id: u64,
        resource_id: &str,
    ) -> Result<ResourceMetadata, ResourceError> {
        let resource = self.resource(owner_connection_id, resource_id)?;
        Ok(ResourceMetadata {
            resource_id: resource_id.into(),
            mime_type: resource.mime_type.clone(),
            size: resource.payload.len(),
            sha256: resource.sha256.clone(),
        })
    }

    pub fn read(
        &mut self,
        owner_connection_id: u64,
        resource_id: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<ResourceChunk, ResourceError> {
        if max_bytes == 0 || max_bytes > MAX_READ_CHUNK_BYTES {
            return Err(ResourceError::InvalidChunkSize);
        }
        let resource = self.resource(owner_connection_id, resource_id)?;
        let size = resource.payload.len();
        if offset > size {
            return Err(ResourceError::InvalidOffset);
        }
        let end = (offset + max_bytes).min(size);
        Ok(ResourceChunk {
            offset,
            data: resource.payload.read(offset, end)?,
            eof: end == size,
        })
    }

    pub fn release(
        &mut self,
        owner_connection_id: u64,
        resource_id: &str,
    ) -> Result<(), ResourceError> {
        self.resource(owner_connection_id, resource_id)?;
        if let Some(resource) = self.resources.remove(resource_id) {
            self.remove_usage(resource.owner_connection_id, resource.payload.len());
        }
        Ok(())
    }

    /// Transfers a connection-owned resource to a server-side consumer and releases its quota.
    pub(crate) fn take_reader(
        &mut self,
        owner_connection_id: u64,
        resource_id: &str,
    ) -> Result<(usize, Box<dyn Read>), ResourceError> {
        self.resource(owner_connection_id, resource_id)?;
        let resource = self
            .resources
            .remove(resource_id)
            .ok_or(ResourceError::NotFound)?;
        let size = resource.payload.len();
        self.remove_usage(owner_connection_id, size);
        let reader: Box<dyn Read> = match resource.payload {
            Payload::Memory(bytes) => Box::new(Cursor::new(bytes)),
            Payload::File { mut file, .. } => {
                file.rewind().map_err(|_| ResourceError::ReadFailed)?;
                Box::new(file)
            }
        };
        Ok((size, reader))
    }

    pub fn release_owner(&mut self, owner_connection_id: u64) {
        self.resources
            .retain(|_, resource| resource.owner_connection_id != owner_connection_id);
        self.usage_by_connection.remove(&owner_connection_id);
    }

    fn resource(
        &mut self,
        owner_connection_id: u64,
        resource_id: &str,
    ) -> Result<&Resource, ResourceError> {
        self.cleanup();
        let resource = self
            .resources
            .get(resource_id)
            .ok_or(ResourceError::NotFound)?;
        if resource.owner_connection_id != owner_connection_id {
            return Err(ResourceError::NotOwner);
        }
        Ok(resource)
    }

    fn remove_usage(&mut self, owner_connection_id: u64, bytes: usize) {
        let Some(usage) = self.usage_by_connection.get_mut(&owner_connection_id) else {
            return;
        };
        usage.count = usage.count.saturating_sub(1);
        usage.bytes = usage.bytes.saturating_sub(bytes);
        if usage.count == 0 {
            self.usage_by_connection.remove(&owner_connection_id);
        }
    }

    fn cleanup(&mut self) {
        let now = Instant::now();
        let expired = self
            .resources
            .iter()
            .filter(|(_, resource)| resource.expires_at <= now)
            .map(|(resource_id, _)| resource_id.clone())
            .collect::<Vec<_>>();
        for resource_id in expired {
            if let Some(resource) = self.resources.remove(&resource_id) {
                self.remove_usage(resource.owner_connection_id, resource.payload.len());
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceError {
    NotFound,
    NotOwner,
    TooLarge,
    InvalidChunkSize,
    InvalidOffset,
    ReadFailed,
}

#[cfg(test)]
#[path = "resource_store_tests.rs"]
mod tests;
