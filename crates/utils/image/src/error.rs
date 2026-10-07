use std::path::PathBuf;

use thiserror::Error;

use crate::SupportedImageFormat;

/// Stable failures produced while validating or preparing a prompt image.
#[derive(Debug, Error)]
pub enum ImageProcessingError {
    #[error("invalid image processing limits: {reason}")]
    InvalidLimits { reason: &'static str },
    #[error("invalid image data URL: {reason}")]
    InvalidDataUrl { reason: String },
    #[error("unsupported image format")]
    UnsupportedImageFormat,
    #[error("image MIME type `{declared}` does not match encoded `{actual}` content")]
    MimeMismatch {
        declared: String,
        actual: &'static str,
    },
    #[error("image {representation} is too large ({size} bytes; max {max} bytes)")]
    InputTooLarge {
        representation: &'static str,
        size: usize,
        max: usize,
    },
    #[error("prepared image is too large ({size} bytes; max {max} bytes)")]
    OutputTooLarge { size: usize, max: usize },
    #[error("image dimensions {width}x{height} exceed the {max_dimension}px safety limit")]
    DimensionsExceeded {
        width: u32,
        height: u32,
        max_dimension: u32,
    },
    #[error("image contains {pixels} pixels; max {max_pixels}")]
    PixelLimitExceeded { pixels: u64, max_pixels: u64 },
    #[error("decoded image requires {bytes} bytes; max {max_bytes}")]
    DecodedBytesExceeded { bytes: u64, max_bytes: u64 },
    #[error("image contains more than {max_frames} frames")]
    FrameLimitExceeded { max_frames: u32 },
    #[error("animated images are rejected by the selected image policy")]
    AnimatedImageUnsupported,
    #[error("failed to decode image at {path}: {source}")]
    Decode {
        path: PathBuf,
        #[source]
        source: image::ImageError,
    },
    #[error("failed to encode image as {format}: {source}")]
    Encode {
        format: SupportedImageFormat,
        #[source]
        source: image::ImageError,
    },
}

impl ImageProcessingError {
    pub(crate) fn decode(path: &std::path::Path, source: image::ImageError) -> Self {
        Self::Decode {
            path: path.to_path_buf(),
            source,
        }
    }

    /// Returns whether the encoded input was recognized but could not be decoded.
    pub fn is_invalid_image(&self) -> bool {
        matches!(self, Self::Decode { .. })
    }
}
