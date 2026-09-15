use std::collections::BTreeMap;
use std::time::Duration;
use std::time::Instant;

use ash_protocol::AudioMediaType;
use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;

pub const MAX_ATTACHMENT_UPLOAD_CHUNK_BYTES: usize = 192 * 1024;
const MAX_CONCURRENT_ATTACHMENT_UPLOADS: usize = 16;
const MAX_ATTACHMENT_UPLOADS_PER_CONNECTION: usize = 4;
const MAX_BUFFERED_ATTACHMENT_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_BUFFERED_ATTACHMENT_UPLOAD_BYTES_PER_CONNECTION: usize = 32 * 1024 * 1024;
const ATTACHMENT_UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct AttachmentUploadStore {
    next_id: u64,
    uploads: BTreeMap<String, AttachmentUpload>,
}

#[derive(Clone, Copy, Debug)]
pub enum AttachmentUploadContent {
    Image {
        media_type: ImageMediaType,
        detail: ImageDetail,
    },
    Audio {
        media_type: AudioMediaType,
    },
}

#[derive(Debug)]
pub struct CompletedAttachmentUpload {
    pub content: AttachmentUploadContent,
    pub bytes: Vec<u8>,
}

struct AttachmentUpload {
    owner_connection_id: u64,
    content: AttachmentUploadContent,
    expected_bytes: usize,
    bytes: Vec<u8>,
    last_activity: Instant,
}

impl AttachmentUploadStore {
    pub fn start(
        &mut self,
        owner_connection_id: u64,
        content: AttachmentUploadContent,
        expected_bytes: usize,
    ) -> Result<String, AttachmentUploadError> {
        self.expire_stale();
        if expected_bytes == 0 || expected_bytes > ash_attachments::MAX_ATTACHMENT_BYTES {
            return Err(AttachmentUploadError::InvalidSize);
        }
        if self.uploads.len() >= MAX_CONCURRENT_ATTACHMENT_UPLOADS
            || self
                .uploads
                .values()
                .filter(|upload| upload.owner_connection_id == owner_connection_id)
                .count()
                >= MAX_ATTACHMENT_UPLOADS_PER_CONNECTION
        {
            return Err(AttachmentUploadError::ResourceLimit);
        }
        self.next_id = self.next_id.saturating_add(1);
        let upload_id = format!("attachment-upload_{:016x}", self.next_id);
        self.uploads.insert(
            upload_id.clone(),
            AttachmentUpload {
                owner_connection_id,
                content,
                expected_bytes,
                bytes: Vec::new(),
                last_activity: Instant::now(),
            },
        );
        Ok(upload_id)
    }

    pub fn write(
        &mut self,
        owner_connection_id: u64,
        upload_id: &str,
        offset: usize,
        chunk: &[u8],
    ) -> Result<usize, AttachmentUploadError> {
        self.expire_stale();
        let upload = self.upload_ref(owner_connection_id, upload_id)?;
        if chunk.is_empty()
            || chunk.len() > MAX_ATTACHMENT_UPLOAD_CHUNK_BYTES
            || offset != upload.bytes.len()
            || upload.bytes.len().saturating_add(chunk.len()) > upload.expected_bytes
        {
            return Err(AttachmentUploadError::InvalidChunk);
        }
        let total_buffered = self
            .uploads
            .values()
            .map(|upload| upload.bytes.len())
            .sum::<usize>();
        let owner_buffered = self
            .uploads
            .values()
            .filter(|upload| upload.owner_connection_id == owner_connection_id)
            .map(|upload| upload.bytes.len())
            .sum::<usize>();
        if total_buffered.saturating_add(chunk.len()) > MAX_BUFFERED_ATTACHMENT_UPLOAD_BYTES
            || owner_buffered.saturating_add(chunk.len())
                > MAX_BUFFERED_ATTACHMENT_UPLOAD_BYTES_PER_CONNECTION
        {
            return Err(AttachmentUploadError::ResourceLimit);
        }
        let upload = self.upload_mut(owner_connection_id, upload_id)?;
        upload.bytes.extend_from_slice(chunk);
        upload.last_activity = Instant::now();
        Ok(upload.bytes.len())
    }

    pub fn finish(
        &mut self,
        owner_connection_id: u64,
        upload_id: &str,
    ) -> Result<CompletedAttachmentUpload, AttachmentUploadError> {
        self.expire_stale();
        let upload = self.upload_ref(owner_connection_id, upload_id)?;
        if upload.bytes.len() != upload.expected_bytes {
            return Err(AttachmentUploadError::Incomplete);
        }
        let upload = self
            .uploads
            .remove(upload_id)
            .expect("an upload validated immediately before removal exists");
        Ok(CompletedAttachmentUpload {
            content: upload.content,
            bytes: upload.bytes,
        })
    }

    pub fn cancel(
        &mut self,
        owner_connection_id: u64,
        upload_id: &str,
    ) -> Result<(), AttachmentUploadError> {
        self.expire_stale();
        self.upload_ref(owner_connection_id, upload_id)?;
        self.uploads.remove(upload_id);
        Ok(())
    }

    pub fn release_owner(&mut self, owner_connection_id: u64) {
        self.uploads
            .retain(|_, upload| upload.owner_connection_id != owner_connection_id);
    }

    fn upload_ref(
        &self,
        owner_connection_id: u64,
        upload_id: &str,
    ) -> Result<&AttachmentUpload, AttachmentUploadError> {
        let upload = self
            .uploads
            .get(upload_id)
            .ok_or(AttachmentUploadError::NotFound)?;
        if upload.owner_connection_id != owner_connection_id {
            return Err(AttachmentUploadError::NotOwner);
        }
        Ok(upload)
    }

    fn upload_mut(
        &mut self,
        owner_connection_id: u64,
        upload_id: &str,
    ) -> Result<&mut AttachmentUpload, AttachmentUploadError> {
        let upload = self
            .uploads
            .get_mut(upload_id)
            .ok_or(AttachmentUploadError::NotFound)?;
        if upload.owner_connection_id != owner_connection_id {
            return Err(AttachmentUploadError::NotOwner);
        }
        Ok(upload)
    }

    fn expire_stale(&mut self) {
        let now = Instant::now();
        self.uploads.retain(|_, upload| {
            now.saturating_duration_since(upload.last_activity) < ATTACHMENT_UPLOAD_IDLE_TIMEOUT
        });
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttachmentUploadError {
    NotFound,
    NotOwner,
    InvalidSize,
    InvalidChunk,
    Incomplete,
    ResourceLimit,
}

#[cfg(test)]
#[path = "attachment_upload_store_tests.rs"]
mod tests;
