use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::EncodedImage;
use crate::ImageProcessingError;
use crate::PromptImagePolicy;
use crate::SupportedImageFormat;
use crate::detect_image_format;
use crate::load_for_prompt_bytes;

const DATA_URL_PREFIX: &str = "data:";

/// Wraps bytes in a Base64 data URL without decoding or validating them.
pub fn data_url_from_bytes(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// Parses, validates, and prepares a Base64 image data URL for a model prompt.
pub fn load_data_url_for_prompt(
    image_url: &str,
    policy: PromptImagePolicy,
) -> Result<EncodedImage, ImageProcessingError> {
    let rest = image_url
        .get(..DATA_URL_PREFIX.len())
        .filter(|prefix| prefix.eq_ignore_ascii_case(DATA_URL_PREFIX))
        .and_then(|_| image_url.get(DATA_URL_PREFIX.len()..))
        .ok_or_else(|| ImageProcessingError::InvalidDataUrl {
            reason: "missing data: prefix".into(),
        })?;
    let (metadata, encoded) =
        rest.split_once(',')
            .ok_or_else(|| ImageProcessingError::InvalidDataUrl {
                reason: "missing comma separator".into(),
            })?;
    let mut metadata_parts = metadata.split(';');
    let declared_mime = metadata_parts
        .next()
        .and_then(SupportedImageFormat::from_mime_type)
        .ok_or_else(|| ImageProcessingError::InvalidDataUrl {
            reason: "unsupported image MIME type".into(),
        })?;
    if !metadata_parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return Err(ImageProcessingError::InvalidDataUrl {
            reason: "only base64 data URLs are supported".into(),
        });
    }

    let max_input_bytes = policy.safety_limits.max_input_bytes;
    let max_encoded_bytes = max_input_bytes.div_ceil(3).saturating_mul(4);
    if encoded.is_empty() || encoded.len() > max_encoded_bytes {
        return Err(ImageProcessingError::InputTooLarge {
            representation: "base64 payload",
            size: encoded.len(),
            max: max_encoded_bytes,
        });
    }
    let file_bytes =
        STANDARD
            .decode(encoded)
            .map_err(|source| ImageProcessingError::InvalidDataUrl {
                reason: format!("invalid base64 payload: {source}"),
            })?;
    if file_bytes.len() > max_input_bytes {
        return Err(ImageProcessingError::InputTooLarge {
            representation: "decoded input",
            size: file_bytes.len(),
            max: max_input_bytes,
        });
    }
    if let Some(actual) = detect_image_format(&file_bytes)
        && actual != declared_mime
    {
        return Err(ImageProcessingError::MimeMismatch {
            declared: declared_mime.mime_type().into(),
            actual: actual.mime_type(),
        });
    }

    load_for_prompt_bytes(Path::new("<data-url-image>"), file_bytes, policy)
}
