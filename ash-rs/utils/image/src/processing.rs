use std::fmt;
use std::io::BufReader;
use std::io::Cursor;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;
use std::sync::LazyLock;

use ash_utils_cache::BlockingLruCache;
use image::AnimationDecoder;
use image::ColorType;
use image::DynamicImage;
use image::ImageDecoder;
use image::ImageEncoder;
use image::ImageFormat;
use image::ImageReader;
use image::codecs::gif::GifDecoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngDecoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPDecoder;
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use sha2::Digest;
use sha2::Sha256;

use crate::MAX_DIMENSION;
use crate::MAX_PROMPT_IMAGE_INPUT_BYTES;
use crate::PROMPT_IMAGE_PATCH_SIZE;
use crate::error::ImageProcessingError;

const MAX_IMAGE_CACHE_ENTRIES: usize = 32;
const MAX_IMAGE_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// Image encodings accepted as prompt input.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SupportedImageFormat {
    Png,
    Jpeg,
    Gif,
    WebP,
}

impl SupportedImageFormat {
    /// Returns the canonical MIME type for this encoding.
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::WebP => "image/webp",
        }
    }

    pub(crate) fn from_mime_type(mime: &str) -> Option<Self> {
        if mime.eq_ignore_ascii_case("image/png") {
            Some(Self::Png)
        } else if mime.eq_ignore_ascii_case("image/jpeg") {
            Some(Self::Jpeg)
        } else if mime.eq_ignore_ascii_case("image/gif") {
            Some(Self::Gif)
        } else if mime.eq_ignore_ascii_case("image/webp") {
            Some(Self::WebP)
        } else {
            None
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Gif => ImageFormat::Gif,
            Self::WebP => ImageFormat::WebP,
        }
    }
}

impl fmt::Display for SupportedImageFormat {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.mime_type())
    }
}

/// Detects a supported image encoding from its signature.
pub fn detect_image_format(bytes: &[u8]) -> Option<SupportedImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(SupportedImageFormat::Png)
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(SupportedImageFormat::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(SupportedImageFormat::Gif)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(SupportedImageFormat::WebP)
    } else {
        None
    }
}

/// Hard resource limits applied before pixels become model-visible.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ImageSafetyLimits {
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub max_dimension: u32,
    pub max_pixels: u64,
    pub max_decoded_bytes: u64,
    pub max_frames: u32,
}

impl Default for ImageSafetyLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: MAX_PROMPT_IMAGE_INPUT_BYTES,
            max_output_bytes: MAX_PROMPT_IMAGE_INPUT_BYTES,
            max_dimension: 32_768,
            max_pixels: 100_000_000,
            max_decoded_bytes: 512 * 1024 * 1024,
            max_frames: 64,
        }
    }
}

/// Resize behavior applied after safety validation.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PromptImageMode {
    ResizeToFit,
    Original,
    ResizeWithLimits(PromptImageResizeLimits),
}

/// Output limits for a model-specific image budget.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PromptImageResizeLimits {
    pub max_dimension: u32,
    pub max_patches: usize,
}

/// Metadata retained when transcoding an image.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ImageMetadataPolicy {
    PreserveColorAndOrientation,
    Strip,
}

/// Behavior for a supported encoding that contains multiple frames.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ImageAnimationPolicy {
    Reject,
    FirstFrame,
}

/// Complete caller-selected policy for preparing one prompt image.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PromptImagePolicy {
    pub mode: PromptImageMode,
    pub safety_limits: ImageSafetyLimits,
    pub metadata_policy: ImageMetadataPolicy,
    pub animation_policy: ImageAnimationPolicy,
}

impl PromptImagePolicy {
    /// Constructs the default prompt policy for the requested resize mode.
    pub fn for_mode(mode: PromptImageMode) -> Self {
        Self {
            mode,
            safety_limits: ImageSafetyLimits::default(),
            metadata_policy: ImageMetadataPolicy::PreserveColorAndOrientation,
            animation_policy: ImageAnimationPolicy::FirstFrame,
        }
    }
}

/// Encoded model-ready image and observable preparation dimensions.
#[derive(Clone, Debug)]
pub struct EncodedImage {
    pub bytes: Arc<[u8]>,
    pub mime: &'static str,
    pub source_width: u32,
    pub source_height: u32,
    pub source_frames: u32,
    pub width: u32,
    pub height: u32,
}

impl EncodedImage {
    /// Consumes the image and returns a Base64 data URL.
    pub fn into_data_url(self) -> String {
        crate::data_url_from_bytes(self.mime, &self.bytes)
    }
}

struct ImageMetadata {
    icc_profile: Option<Vec<u8>>,
    exif: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ImageCacheKey {
    digest: [u8; 32],
    policy: PromptImagePolicy,
}

type ImageCache = BlockingLruCache<ImageCacheKey, EncodedImage>;

static IMAGE_CACHE: LazyLock<ImageCache> = LazyLock::new(|| {
    ImageCache::new(
        NonZeroUsize::new(MAX_IMAGE_CACHE_ENTRIES).expect("image cache capacity is non-zero"),
    )
});

/// Validates, decodes, optionally resizes, and encodes image bytes for a prompt.
pub fn load_for_prompt_bytes(
    path: &Path,
    file_bytes: Vec<u8>,
    policy: PromptImagePolicy,
) -> Result<EncodedImage, ImageProcessingError> {
    validate_policy(policy)?;
    if file_bytes.len() > policy.safety_limits.max_input_bytes {
        return Err(ImageProcessingError::InputTooLarge {
            representation: "encoded input",
            size: file_bytes.len(),
            max: policy.safety_limits.max_input_bytes,
        });
    }

    let key = ImageCacheKey {
        digest: Sha256::digest(&file_bytes).into(),
        policy,
    };
    if let Some(image) = IMAGE_CACHE.get(&key) {
        return Ok(image);
    }

    let format =
        detect_image_format(&file_bytes).ok_or(ImageProcessingError::UnsupportedImageFormat)?;
    let mut decoder = ImageReader::with_format(Cursor::new(&file_bytes), format.image_format())
        .into_decoder()
        .map_err(|source| ImageProcessingError::decode(path, source))?;
    let (source_width, source_height) = decoder.dimensions();
    let decoded_bytes_per_frame = decoder.total_bytes();
    // Validate one decoded frame before animation inspection so frame counting cannot allocate a
    // pathological logical screen that the caller's dimension or memory policy would reject.
    validate_decoded_shape(
        source_width,
        source_height,
        decoded_bytes_per_frame,
        1,
        policy.safety_limits,
    )?;
    let frame_count = frame_count(path, &file_bytes, format, policy.safety_limits.max_frames)?;
    validate_decoded_shape(
        source_width,
        source_height,
        decoded_bytes_per_frame,
        frame_count,
        policy.safety_limits,
    )?;
    if frame_count > 1 && policy.animation_policy == ImageAnimationPolicy::Reject {
        return Err(ImageProcessingError::AnimatedImageUnsupported);
    }
    let metadata = match policy.metadata_policy {
        ImageMetadataPolicy::PreserveColorAndOrientation => ImageMetadata {
            icc_profile: decoder
                .icc_profile()
                .ok()
                .flatten()
                .filter(|profile| profile.get(16..20) == Some(b"RGB ")),
            exif: decoder.exif_metadata().ok().flatten(),
        },
        ImageMetadataPolicy::Strip => ImageMetadata {
            icc_profile: None,
            exif: None,
        },
    };
    let dynamic = DynamicImage::from_decoder(decoder)
        .map_err(|source| ImageProcessingError::decode(path, source))?;

    let target_dimensions = output_dimensions(source_width, source_height, policy.mode);
    let resized = target_dimensions
        .filter(|dimensions| *dimensions != (source_width, source_height))
        .map(|(width, height)| dynamic.resize_exact(width, height, FilterType::Triangle));
    let must_transcode = resized.is_some()
        || format == SupportedImageFormat::Gif
        || frame_count > 1
        || policy.metadata_policy == ImageMetadataPolicy::Strip;
    let encoded = if must_transcode {
        let prepared = resized.as_ref().unwrap_or(&dynamic);
        let target_format = transcode_format(format);
        let bytes = encode_image(prepared, target_format, metadata)?;
        EncodedImage {
            bytes: bytes.into(),
            mime: target_format.mime_type(),
            source_width,
            source_height,
            source_frames: frame_count,
            width: prepared.width(),
            height: prepared.height(),
        }
    } else {
        EncodedImage {
            bytes: file_bytes.into(),
            mime: format.mime_type(),
            source_width,
            source_height,
            source_frames: frame_count,
            width: source_width,
            height: source_height,
        }
    };

    if encoded.bytes.len() > policy.safety_limits.max_output_bytes {
        return Err(ImageProcessingError::OutputTooLarge {
            size: encoded.bytes.len(),
            max: policy.safety_limits.max_output_bytes,
        });
    }
    cache_image(&IMAGE_CACHE, key, encoded.clone(), MAX_IMAGE_CACHE_BYTES);
    Ok(encoded)
}

fn cache_image(cache: &ImageCache, key: ImageCacheKey, image: EncodedImage, byte_capacity: usize) {
    if image.bytes.len() > byte_capacity {
        return;
    }

    cache.with_mut(|cache| {
        cache.put(key, image);
        let mut cached_bytes = cache
            .iter()
            .map(|(_, image)| image.bytes.len())
            .sum::<usize>();
        while cached_bytes > byte_capacity {
            let Some((_, evicted)) = cache.pop_lru() else {
                break;
            };
            cached_bytes -= evicted.bytes.len();
        }
    });
}

fn validate_policy(policy: PromptImagePolicy) -> Result<(), ImageProcessingError> {
    let limits = policy.safety_limits;
    if limits.max_input_bytes == 0
        || limits.max_output_bytes == 0
        || limits.max_dimension == 0
        || limits.max_pixels == 0
        || limits.max_decoded_bytes == 0
        || limits.max_frames == 0
    {
        return Err(ImageProcessingError::InvalidLimits {
            reason: "safety limits must be non-zero",
        });
    }
    if let PromptImageMode::ResizeWithLimits(limits) = policy.mode
        && (limits.max_dimension == 0 || limits.max_patches == 0)
    {
        return Err(ImageProcessingError::InvalidLimits {
            reason: "resize limits must be non-zero",
        });
    }
    Ok(())
}

fn validate_decoded_shape(
    width: u32,
    height: u32,
    decoded_bytes_per_frame: u64,
    frame_count: u32,
    limits: ImageSafetyLimits,
) -> Result<(), ImageProcessingError> {
    if width > limits.max_dimension || height > limits.max_dimension {
        return Err(ImageProcessingError::DimensionsExceeded {
            width,
            height,
            max_dimension: limits.max_dimension,
        });
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > limits.max_pixels {
        return Err(ImageProcessingError::PixelLimitExceeded {
            pixels,
            max_pixels: limits.max_pixels,
        });
    }
    let decoded_bytes = decoded_bytes_per_frame.saturating_mul(u64::from(frame_count));
    if decoded_bytes > limits.max_decoded_bytes {
        return Err(ImageProcessingError::DecodedBytesExceeded {
            bytes: decoded_bytes,
            max_bytes: limits.max_decoded_bytes,
        });
    }
    Ok(())
}

fn frame_count(
    path: &Path,
    bytes: &[u8],
    format: SupportedImageFormat,
    max_frames: u32,
) -> Result<u32, ImageProcessingError> {
    let take = usize::try_from(max_frames)
        .unwrap_or(usize::MAX)
        .saturating_add(1);
    let count = match format {
        SupportedImageFormat::Jpeg => 1,
        SupportedImageFormat::Gif => count_frames(
            GifDecoder::new(BufReader::new(Cursor::new(bytes)))
                .map_err(|source| ImageProcessingError::decode(path, source))?
                .into_frames(),
            take,
            path,
        )?,
        SupportedImageFormat::WebP => {
            let decoder = WebPDecoder::new(BufReader::new(Cursor::new(bytes)))
                .map_err(|source| ImageProcessingError::decode(path, source))?;
            if decoder.has_animation() {
                count_frames(decoder.into_frames(), take, path)?
            } else {
                1
            }
        }
        SupportedImageFormat::Png => {
            let decoder = PngDecoder::new(BufReader::new(Cursor::new(bytes)))
                .map_err(|source| ImageProcessingError::decode(path, source))?;
            if decoder
                .is_apng()
                .map_err(|source| ImageProcessingError::decode(path, source))?
            {
                let frames = decoder
                    .apng()
                    .map_err(|source| ImageProcessingError::decode(path, source))?
                    .into_frames();
                count_frames(frames, take, path)?
            } else {
                1
            }
        }
    };
    if count > max_frames {
        Err(ImageProcessingError::FrameLimitExceeded { max_frames })
    } else {
        Ok(count.max(1))
    }
}

fn count_frames(
    frames: image::Frames<'_>,
    take: usize,
    path: &Path,
) -> Result<u32, ImageProcessingError> {
    let mut count = 0u32;
    for frame in frames.take(take) {
        frame.map_err(|source| ImageProcessingError::decode(path, source))?;
        count = count.saturating_add(1);
    }
    Ok(count)
}

fn output_dimensions(width: u32, height: u32, mode: PromptImageMode) -> Option<(u32, u32)> {
    match mode {
        PromptImageMode::Original => None,
        PromptImageMode::ResizeToFit if width > MAX_DIMENSION || height > MAX_DIMENSION => {
            Some(fit_within(width, height, MAX_DIMENSION))
        }
        PromptImageMode::ResizeWithLimits(limits) => {
            Some(output_dimensions_for_limits(width, height, limits))
        }
        PromptImageMode::ResizeToFit => None,
    }
}

fn fit_within(width: u32, height: u32, max_dimension: u32) -> (u32, u32) {
    let scale = (f64::from(max_dimension) / f64::from(width.max(height))).min(1.0);
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}

fn output_dimensions_for_limits(
    width: u32,
    height: u32,
    limits: PromptImageResizeLimits,
) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    if dimensions_fit(width, height, limits) {
        return (width, height);
    }

    let (width, height) = fit_within(width, height, limits.max_dimension);
    if dimensions_fit(width, height, limits) {
        return (width, height);
    }

    let width_f64 = f64::from(width);
    let height_f64 = f64::from(height);
    let patch_size = f64::from(PROMPT_IMAGE_PATCH_SIZE);
    let mut scale =
        (patch_size * patch_size * limits.max_patches as f64 / width_f64 / height_f64).sqrt();
    let scaled_patches_wide = width_f64 * scale / patch_size;
    let scaled_patches_high = height_f64 * scale / patch_size;
    scale *= (scaled_patches_wide.floor() / scaled_patches_wide)
        .min(scaled_patches_high.floor() / scaled_patches_high);

    (
        ((width_f64 * scale).floor() as u32).max(1),
        ((height_f64 * scale).floor() as u32).max(1),
    )
}

fn dimensions_fit(width: u32, height: u32, limits: PromptImageResizeLimits) -> bool {
    let patches_wide = width.div_ceil(PROMPT_IMAGE_PATCH_SIZE);
    let patches_high = height.div_ceil(PROMPT_IMAGE_PATCH_SIZE);
    let patch_count = u64::from(patches_wide) * u64::from(patches_high);
    width <= limits.max_dimension
        && height <= limits.max_dimension
        && patch_count <= limits.max_patches as u64
}

fn transcode_format(source: SupportedImageFormat) -> SupportedImageFormat {
    match source {
        SupportedImageFormat::Jpeg => SupportedImageFormat::Jpeg,
        SupportedImageFormat::WebP => SupportedImageFormat::WebP,
        SupportedImageFormat::Png | SupportedImageFormat::Gif => SupportedImageFormat::Png,
    }
}

fn encode_image(
    image: &DynamicImage,
    format: SupportedImageFormat,
    metadata: ImageMetadata,
) -> Result<Vec<u8>, ImageProcessingError> {
    let mut buffer = Vec::new();
    let ImageMetadata { icc_profile, exif } = metadata;
    match format {
        SupportedImageFormat::Png => {
            let rgba = image.to_rgba8();
            let mut encoder = PngEncoder::new(&mut buffer);
            apply_metadata(&mut encoder, icc_profile, exif, format)?;
            encoder
                .write_image(
                    rgba.as_raw(),
                    image.width(),
                    image.height(),
                    ColorType::Rgba8.into(),
                )
                .map_err(|source| ImageProcessingError::Encode { format, source })?;
        }
        SupportedImageFormat::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 85);
            apply_metadata(&mut encoder, icc_profile, exif, format)?;
            encoder
                .encode_image(image)
                .map_err(|source| ImageProcessingError::Encode { format, source })?;
        }
        SupportedImageFormat::WebP => {
            let rgba = image.to_rgba8();
            let mut encoder = WebPEncoder::new_lossless(&mut buffer);
            apply_metadata(&mut encoder, icc_profile, exif, format)?;
            encoder
                .write_image(
                    rgba.as_raw(),
                    image.width(),
                    image.height(),
                    ColorType::Rgba8.into(),
                )
                .map_err(|source| ImageProcessingError::Encode { format, source })?;
        }
        SupportedImageFormat::Gif => unreachable!("GIF output is normalized to PNG"),
    }
    Ok(buffer)
}

fn apply_metadata(
    encoder: &mut impl ImageEncoder,
    icc_profile: Option<Vec<u8>>,
    exif: Option<Vec<u8>>,
    format: SupportedImageFormat,
) -> Result<(), ImageProcessingError> {
    if let Some(profile) = icc_profile {
        encoder
            .set_icc_profile(profile)
            .map_err(|source| ImageProcessingError::Encode {
                format,
                source: image::ImageError::Unsupported(source),
            })?;
    }
    if let Some(exif) = exif {
        encoder
            .set_exif_metadata(exif)
            .map_err(|source| ImageProcessingError::Encode {
                format,
                source: image::ImageError::Unsupported(source),
            })?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "processing_cache_tests.rs"]
mod cache_tests;
