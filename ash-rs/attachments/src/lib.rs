//! Durable image and audio attachment admission, storage, remote import, and model materialization.

mod audio;
mod error;
mod remote;
mod service;
mod store;

pub use error::AttachmentError;
pub use remote::RemoteImageFetcher;
pub use remote::SafeRemoteImageFetcher;
pub use service::Attachments;
pub use service::image_media_type;
pub use store::AttachmentStore;
pub use store::FileAttachmentStore;
pub use store::MemoryAttachmentStore;

/// Maximum encoded bytes accepted for one product image attachment.
pub const MAX_ATTACHMENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = MAX_ATTACHMENT_BYTES;
pub const MAX_AUDIO_ATTACHMENT_BYTES: usize = ::audio::MAX_AUDIO_BYTES;

#[cfg(test)]
#[path = "attachment_tests.rs"]
mod tests;
