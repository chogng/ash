use std::collections::HashMap;

use thiserror::Error;
use zui::ui::{ImageData, ImageId};

const MAX_DECODED_PIXELS: u64 = 16_777_216;

/// Parsed image reference. Loading remains an explicit host action.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MarkdownImageSource {
    destination: String,
    title: String,
    alt: String,
}

impl MarkdownImageSource {
    pub(crate) fn new(destination: String, title: String, alt: String) -> Self {
        Self {
            destination,
            title,
            alt,
        }
    }

    pub fn destination(&self) -> &str {
        &self.destination
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn alt(&self) -> &str {
        &self.alt
    }
}

/// Decoded image snapshots supplied to one Markdown layout.
#[derive(Clone, Debug, Default)]
pub struct MarkdownImages {
    loaded: HashMap<String, ImageData>,
}

impl MarkdownImages {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, destination: impl Into<String>, image: ImageData) {
        self.loaded.insert(destination.into(), image);
    }

    pub(crate) fn get(&self, destination: &str) -> Option<&ImageData> {
        self.loaded.get(destination)
    }
}

/// Decodes host-authorized bytes without performing file or network access.
pub fn decode_markdown_image(
    id: ImageId,
    encoded: &[u8],
) -> Result<ImageData, MarkdownImageDecodeError> {
    let decoded = image::load_from_memory(encoded).map_err(MarkdownImageDecodeError::Decode)?;
    let width = decoded.width();
    let height = decoded.height();
    if u64::from(width) * u64::from(height) > MAX_DECODED_PIXELS {
        return Err(MarkdownImageDecodeError::TooManyPixels {
            width,
            height,
            limit: MAX_DECODED_PIXELS,
        });
    }
    ImageData::from_rgba8(id, width, height, decoded.into_rgba8().into_raw())
        .map_err(MarkdownImageDecodeError::Pixels)
}

#[derive(Debug, Error)]
pub enum MarkdownImageDecodeError {
    #[error("image cannot be decoded: {0}")]
    Decode(image::ImageError),
    #[error("decoded image is {width}x{height}, exceeding the {limit}-pixel limit")]
    TooManyPixels { width: u32, height: u32, limit: u64 },
    #[error("decoded image pixels are invalid: {0}")]
    Pixels(zui::ui::ImageDataError),
}
