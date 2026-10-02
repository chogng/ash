//! Immutable product assets, independent of conversations and editor windows.

use image::ImageDecoder;
use image::ImageReader;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

pub const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 192 * 1024;
const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportRequest {
    pub asset_id: String,
    pub version_id: String,
    pub name: String,
    pub source: String,
    pub size: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageType {
    Png,
    Jpeg,
    Webp,
}

impl ImageType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }
    pub fn from_mime(value: &str) -> Option<Self> {
        match value {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetVersion {
    pub asset_id: String,
    pub version_id: String,
    pub name: String,
    pub source: String,
    pub sha256: String,
    pub media_type: ImageType,
    pub size: usize,
    /// Display dimensions include the encoded image's orientation.
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("Invalid asset input")]
    Invalid,
    #[error("Unsupported or damaged image")]
    InvalidImage,
    #[error("Asset version or upload does not exist")]
    NotFound,
    #[error("Asset version or upload already exists with different content")]
    Conflict,
    #[error("Asset upload capacity exceeded")]
    Capacity,
    #[error("Asset storage failed: {0}")]
    Storage(String),
}

/// Atomically publishes immutable versions and exact original bytes. Implementations deduplicate
/// content without merging asset identities and reject changes to an existing version identity.
pub trait AssetStore: Send + Sync {
    fn publish(&self, version: &AssetVersion, bytes: &[u8]) -> Result<(), AssetError>;
    fn get(&self, asset_id: &str, version_id: &str) -> Result<AssetVersion, AssetError>;
    fn read(
        &self,
        asset_id: &str,
        version_id: &str,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, AssetError>;
}

struct Upload {
    request: ImportRequest,
    bytes: Vec<u8>,
    touched: Instant,
}

pub struct Assets {
    store: Arc<dyn AssetStore>,
    uploads: Mutex<BTreeMap<(u64, String), Upload>>,
}

impl Assets {
    pub fn new(store: Arc<dyn AssetStore>) -> Self {
        Self {
            store,
            uploads: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn start(&self, owner: u64, request: ImportRequest) -> Result<(), AssetError> {
        validate_identity(&request.asset_id, &request.version_id)?;
        if request.name.trim().is_empty()
            || request.name.len() > 512
            || request.source.len() > 8192
            || request.size == 0
            || request.size > MAX_ASSET_BYTES
        {
            return Err(AssetError::Invalid);
        }
        let mut uploads = self.uploads.lock().map_err(lock_error)?;
        expire(&mut uploads);
        let key = (owner, request.version_id.clone());
        if uploads.contains_key(&key) {
            return Err(AssetError::Conflict);
        }
        if uploads.len() >= 16
            || uploads.keys().filter(|(id, _)| *id == owner).count() >= 4
            || uploads
                .values()
                .map(|upload| upload.request.size)
                .sum::<usize>()
                + request.size
                > MAX_UPLOAD_BYTES
        {
            return Err(AssetError::Capacity);
        }
        uploads.insert(
            key,
            Upload {
                request,
                bytes: Vec::new(),
                touched: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn write(
        &self,
        owner: u64,
        version_id: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Result<usize, AssetError> {
        let mut uploads = self.uploads.lock().map_err(lock_error)?;
        expire(&mut uploads);
        let upload = uploads
            .get_mut(&(owner, version_id.into()))
            .ok_or(AssetError::NotFound)?;
        if bytes.is_empty()
            || bytes.len() > MAX_CHUNK_BYTES
            || offset != upload.bytes.len()
            || bytes.len() > upload.request.size - upload.bytes.len()
        {
            return Err(AssetError::Invalid);
        }
        upload.bytes.extend_from_slice(bytes);
        upload.touched = Instant::now();
        Ok(upload.bytes.len())
    }

    /// Finishing consumes the upload. Publication is atomic and cannot be cancelled once accepted;
    /// after an unknown result, the client reads its chosen asset/version identities to recover.
    pub fn finish(&self, owner: u64, version_id: &str) -> Result<AssetVersion, AssetError> {
        let upload = {
            let mut uploads = self.uploads.lock().map_err(lock_error)?;
            expire(&mut uploads);
            let key = (owner, version_id.into());
            let upload = uploads.get(&key).ok_or(AssetError::NotFound)?;
            if upload.bytes.len() != upload.request.size {
                return Err(AssetError::Invalid);
            }
            uploads
                .remove(&key)
                .expect("the complete upload is held under the same lock")
        };
        let format =
            ash_utils_image::detect_image_format(&upload.bytes).ok_or(AssetError::InvalidImage)?;
        let media_type = match format {
            ash_utils_image::SupportedImageFormat::Png => ImageType::Png,
            ash_utils_image::SupportedImageFormat::Jpeg => ImageType::Jpeg,
            ash_utils_image::SupportedImageFormat::WebP => ImageType::Webp,
            ash_utils_image::SupportedImageFormat::Gif => return Err(AssetError::InvalidImage),
        };
        let mut reader = ImageReader::new(Cursor::new(&upload.bytes))
            .with_guessed_format()
            .map_err(|_| AssetError::InvalidImage)?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let mut decoder = reader
            .into_decoder()
            .map_err(|_| AssetError::InvalidImage)?;
        let orientation = decoder
            .orientation()
            .map_err(|_| AssetError::InvalidImage)?;
        let mut decoded =
            image::DynamicImage::from_decoder(decoder).map_err(|_| AssetError::InvalidImage)?;
        decoded.apply_orientation(orientation);
        let version = AssetVersion {
            asset_id: upload.request.asset_id,
            version_id: upload.request.version_id,
            name: upload.request.name,
            source: upload.request.source,
            sha256: format!("{:x}", Sha256::digest(&upload.bytes)),
            media_type,
            size: upload.bytes.len(),
            width: decoded.width(),
            height: decoded.height(),
        };
        drop(decoded);
        self.store.publish(&version, &upload.bytes)?;
        Ok(version)
    }

    pub fn cancel(&self, owner: u64, version_id: &str) -> Result<(), AssetError> {
        self.uploads
            .lock()
            .map_err(lock_error)?
            .remove(&(owner, version_id.into()))
            .ok_or(AssetError::NotFound)?;
        Ok(())
    }

    pub fn close_owner(&self, owner: u64) {
        self.uploads
            .lock()
            .expect("asset upload lock")
            .retain(|(id, _), _| *id != owner);
    }

    pub fn get(&self, asset_id: &str, version_id: &str) -> Result<AssetVersion, AssetError> {
        validate_identity(asset_id, version_id)?;
        self.store.get(asset_id, version_id)
    }

    pub fn read(
        &self,
        asset_id: &str,
        version_id: &str,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, AssetError> {
        validate_identity(asset_id, version_id)?;
        if length == 0 || length > MAX_CHUNK_BYTES {
            return Err(AssetError::Invalid);
        }
        self.store.read(asset_id, version_id, offset, length)
    }
}

fn validate_identity(asset: &str, version: &str) -> Result<(), AssetError> {
    for id in [asset, version] {
        if id.len() != 36
            || !id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
                }
            })
        {
            return Err(AssetError::Invalid);
        }
    }
    Ok(())
}

fn expire(uploads: &mut BTreeMap<(u64, String), Upload>) {
    uploads.retain(|_, upload| upload.touched.elapsed() < UPLOAD_TIMEOUT);
}

fn lock_error(error: impl std::fmt::Display) -> AssetError {
    AssetError::Storage(error.to_string())
}
