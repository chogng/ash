//! Durable image and audio attachment admission, storage, remote import, and model materialization.

mod audio;
mod error;
mod remote;
mod service;

pub use error::AttachmentError;
pub use remote::RemoteImageFetcher;
pub use remote::SafeRemoteImageFetcher;
pub use service::Attachments;

/// Maximum encoded bytes accepted for one product image attachment.
pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = attachment_store::MAX_ATTACHMENT_BYTES;
pub const MAX_AUDIO_ATTACHMENT_BYTES: usize = ::audio::MAX_AUDIO_BYTES;

#[cfg(test)]
#[path = "attachment_tests.rs"]
mod tests;
