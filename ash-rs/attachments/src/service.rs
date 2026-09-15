use std::path::Path;
use std::sync::Arc;

use ash_protocol::ContentDigest;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;
use ash_utils_image::EncodedImage;
use ash_utils_image::ImageAnimationPolicy;
use ash_utils_image::ImageMetadataPolicy;
use ash_utils_image::ImageSafetyLimits;
use ash_utils_image::PromptImageMode;
use ash_utils_image::PromptImagePolicy;
use ash_utils_image::PromptImageResizeLimits;
use ash_utils_image::SupportedImageFormat;
use ash_utils_image::data_url_from_bytes;
use ash_utils_image::detect_image_format;
use ash_utils_image::load_data_url_for_prompt;
use ash_utils_image::load_for_prompt_bytes;

use crate::AttachmentError;
use crate::AttachmentStore;
use crate::MAX_IMAGE_ATTACHMENT_BYTES;
use crate::MemoryAttachmentStore;
use crate::RemoteImageFetcher;

const MAX_PRODUCT_IMAGE_DIMENSION: u32 = 32_768;
const MAX_PRODUCT_IMAGE_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_FRAMES: u32 = 32;

/// Canonical service that validates untrusted images before they enter durable storage.
pub struct Attachments {
    pub(super) store: Arc<dyn AttachmentStore>,
    remote: Option<Arc<dyn RemoteImageFetcher>>,
}

impl Attachments {
    pub fn new(store: Arc<dyn AttachmentStore>) -> Self {
        Self {
            store,
            remote: None,
        }
    }

    pub fn in_memory() -> Self {
        Self::new(Arc::new(MemoryAttachmentStore::default()))
    }

    pub fn with_remote_fetcher(mut self, remote: Arc<dyn RemoteImageFetcher>) -> Self {
        self.remote = Some(remote);
        self
    }

    pub fn import_data_url(
        &self,
        data_url: &str,
        _detail: ImageDetail,
    ) -> Result<ImageAttachmentRef, AttachmentError> {
        let image = load_data_url_for_prompt(data_url, storage_policy())
            .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
        let reference = reference_for_image(&image)?;
        self.store.put(Arc::clone(&image.bytes))?;
        Ok(reference)
    }

    pub fn import_bytes(
        &self,
        bytes: Vec<u8>,
        _detail: ImageDetail,
    ) -> Result<ImageAttachmentRef, AttachmentError> {
        let image =
            load_for_prompt_bytes(Path::new("<attachment-upload>"), bytes, storage_policy())
                .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
        let reference = reference_for_image(&image)?;
        self.store.put(Arc::clone(&image.bytes))?;
        Ok(reference)
    }

    pub fn import_remote_url(
        &self,
        url: &str,
        detail: ImageDetail,
    ) -> Result<ImageAttachmentRef, AttachmentError> {
        let bytes = self
            .remote
            .as_ref()
            .ok_or(AttachmentError::RemoteUnavailable)?
            .fetch(url)?;
        self.import_bytes(bytes, detail)
    }

    pub fn verify(&self, reference: &ImageAttachmentRef) -> Result<(), AttachmentError> {
        self.read_verified(reference).map(|_| ())
    }

    pub fn materialize_data_url(
        &self,
        reference: &ImageAttachmentRef,
    ) -> Result<String, AttachmentError> {
        let bytes = self.read_verified(reference)?;
        Ok(data_url_from_bytes(
            reference.media_type.mime_type(),
            &bytes,
        ))
    }

    /// Materializes a provider-bound clone without changing the durable attachment object.
    pub fn materialize_data_url_with_limits(
        &self,
        reference: &ImageAttachmentRef,
        limits: PromptImageResizeLimits,
    ) -> Result<String, AttachmentError> {
        let bytes = self.read_verified(reference)?;
        let image = load_for_prompt_bytes(
            Path::new("<provider-bound-attachment>"),
            bytes.to_vec(),
            prompt_policy(PromptImageMode::ResizeWithLimits(limits)),
        )
        .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
        Ok(image.into_data_url())
    }

    /// Applies the same provider-bound policy to a legacy inline data URL.
    pub fn prepare_data_url_with_limits(
        &self,
        data_url: &str,
        limits: PromptImageResizeLimits,
    ) -> Result<String, AttachmentError> {
        let image = load_data_url_for_prompt(
            data_url,
            prompt_policy(PromptImageMode::ResizeWithLimits(limits)),
        )
        .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
        Ok(image.into_data_url())
    }

    fn read_verified(&self, reference: &ImageAttachmentRef) -> Result<Arc<[u8]>, AttachmentError> {
        validate_reference_shape(reference)?;
        let bytes = self
            .store
            .read(&reference.content_digest, reference.encoded_bytes)?;
        verify_reference_bytes(reference, &bytes)?;
        Ok(bytes)
    }
}

pub fn image_media_type(bytes: &[u8]) -> Option<ImageMediaType> {
    detect_image_format(bytes).map(media_type_for_format)
}

pub(crate) fn reference_for_image(
    image: &EncodedImage,
) -> Result<ImageAttachmentRef, AttachmentError> {
    let encoded_bytes = u64::try_from(image.bytes.len()).map_err(|_| AttachmentError::TooLarge)?;
    if image.bytes.is_empty() || image.bytes.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(AttachmentError::TooLarge);
    }
    if image.width == 0 || image.height == 0 {
        return Err(AttachmentError::Corrupt);
    }
    let media_type = media_type_for_mime(image.mime).ok_or(AttachmentError::Corrupt)?;
    Ok(ImageAttachmentRef {
        content_digest: ContentDigest::sha256(&image.bytes),
        media_type,
        encoded_bytes,
        width: image.width,
        height: image.height,
    })
}

pub(crate) fn verify_reference_bytes(
    reference: &ImageAttachmentRef,
    bytes: &[u8],
) -> Result<(), AttachmentError> {
    validate_reference_shape(reference)?;
    if usize::try_from(reference.encoded_bytes).ok() != Some(bytes.len())
        || ContentDigest::sha256(bytes) != reference.content_digest
        || image_media_type(bytes) != Some(reference.media_type)
    {
        return Err(AttachmentError::Corrupt);
    }
    let image = load_for_prompt_bytes(
        Path::new("<stored-attachment>"),
        bytes.to_vec(),
        storage_policy(),
    )
    .map_err(|_| AttachmentError::Corrupt)?;
    if image.width != reference.width || image.height != reference.height {
        return Err(AttachmentError::Corrupt);
    }
    Ok(())
}

fn validate_reference_shape(reference: &ImageAttachmentRef) -> Result<(), AttachmentError> {
    if reference.encoded_bytes == 0
        || reference.encoded_bytes > MAX_IMAGE_ATTACHMENT_BYTES as u64
        || reference.width == 0
        || reference.height == 0
        || reference.width > MAX_PRODUCT_IMAGE_DIMENSION
        || reference.height > MAX_PRODUCT_IMAGE_DIMENSION
    {
        return Err(AttachmentError::Corrupt);
    }
    Ok(())
}

fn media_type_for_format(format: SupportedImageFormat) -> ImageMediaType {
    match format {
        SupportedImageFormat::Png => ImageMediaType::Png,
        SupportedImageFormat::Jpeg => ImageMediaType::Jpeg,
        SupportedImageFormat::Gif => ImageMediaType::Gif,
        SupportedImageFormat::WebP => ImageMediaType::WebP,
    }
}

fn media_type_for_mime(mime: &str) -> Option<ImageMediaType> {
    match mime {
        "image/png" => Some(ImageMediaType::Png),
        "image/jpeg" => Some(ImageMediaType::Jpeg),
        "image/gif" => Some(ImageMediaType::Gif),
        "image/webp" => Some(ImageMediaType::WebP),
        _ => None,
    }
}

fn storage_policy() -> PromptImagePolicy {
    prompt_policy(PromptImageMode::Original)
}

fn prompt_policy(mode: PromptImageMode) -> PromptImagePolicy {
    PromptImagePolicy {
        mode,
        safety_limits: ImageSafetyLimits {
            max_input_bytes: MAX_IMAGE_ATTACHMENT_BYTES,
            max_output_bytes: MAX_IMAGE_ATTACHMENT_BYTES,
            max_dimension: MAX_PRODUCT_IMAGE_DIMENSION,
            max_pixels: MAX_PRODUCT_IMAGE_PIXELS,
            max_decoded_bytes: MAX_PRODUCT_IMAGE_DECODED_BYTES,
            max_frames: MAX_PRODUCT_IMAGE_FRAMES,
        },
        metadata_policy: ImageMetadataPolicy::PreserveColorAndOrientation,
        animation_policy: ImageAnimationPolicy::FirstFrame,
    }
}
