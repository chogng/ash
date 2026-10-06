//! Provider-neutral preparation of untrusted images for model prompts.

mod data_url;
mod error;
mod processing;

pub use data_url::data_url_from_bytes;
pub use data_url::load_data_url_for_prompt;
pub use error::ImageProcessingError;
pub use processing::EncodedImage;
pub use processing::ImageAnimationPolicy;
pub use processing::ImageMetadataPolicy;
pub use processing::ImageSafetyLimits;
pub use processing::PromptImageDetailLimits;
pub use processing::PromptImageMode;
pub use processing::PromptImagePolicy;
pub use processing::PromptImageResizeLimits;
pub use processing::SupportedImageFormat;
pub use processing::detect_image_format;
pub use processing::load_for_prompt_bytes;

/// Patch edge length used by Responses-compatible image budgets.
pub const PROMPT_IMAGE_PATCH_SIZE: u32 = 32;

/// Default maximum output width or height for resized prompt images.
pub const MAX_DIMENSION: u32 = 2048;

/// Absolute sanity guard for an encoded prompt-image representation.
///
/// Product input limits should normally be lower and are supplied through
/// [`ImageSafetyLimits`].
pub const MAX_PROMPT_IMAGE_INPUT_BYTES: usize = 1024 * 1024 * 1024;

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
