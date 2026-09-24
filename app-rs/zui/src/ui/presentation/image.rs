use std::sync::Arc;

use thiserror::Error;

use crate::ui::foundation::Rect;

/// Stable identity for immutable image pixels cached by the UI renderer.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ImageId(u64);

impl ImageId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
}

/// Immutable, decoded sRGB image pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageData {
    id: ImageId,
    width: u32,
    height: u32,
    rgba8: Arc<[u8]>,
}

impl ImageData {
    pub fn from_rgba8(
        id: ImageId,
        width: u32,
        height: u32,
        rgba8: impl Into<Arc<[u8]>>,
    ) -> Result<Self, ImageDataError> {
        let rgba8 = rgba8.into();
        if width == 0 || height == 0 {
            return Err(ImageDataError::Empty);
        }
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(ImageDataError::DimensionsTooLarge)?;
        if rgba8.len() != expected {
            return Err(ImageDataError::InvalidByteLength {
                actual: rgba8.len(),
                expected,
            });
        }
        Ok(Self {
            id,
            width,
            height,
            rgba8,
        })
    }

    pub const fn id(&self) -> ImageId {
        self.id
    }

    pub const fn width(&self) -> u32 {
        self.width
    }

    pub const fn height(&self) -> u32 {
        self.height
    }

    pub fn rgba8(&self) -> &[u8] {
        &self.rgba8
    }
}

/// Invalid decoded image input.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ImageDataError {
    #[error("image dimensions must be non-zero")]
    Empty,
    #[error("image dimensions exceed addressable memory")]
    DimensionsTooLarge,
    #[error("RGBA8 byte length is {actual}, expected {expected}")]
    InvalidByteLength { actual: usize, expected: usize },
}

/// A decoded image placed in logical UI coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct PaintImage {
    image: ImageData,
    bounds: Rect,
    clip_bounds: Option<Rect>,
}

impl PaintImage {
    pub const fn new(image: ImageData, bounds: Rect) -> Self {
        Self {
            image,
            bounds,
            clip_bounds: None,
        }
    }

    pub const fn image(&self) -> &ImageData {
        &self.image
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    /// Returns the resolved scene clip consumed by renderer backends.
    pub const fn clip_bounds(&self) -> Option<Rect> {
        self.clip_bounds
    }

    pub(crate) fn apply_clip(&mut self, clip_bounds: Rect) {
        self.clip_bounds = Some(match self.clip_bounds {
            Some(current) => current.intersection(clip_bounds),
            None => clip_bounds,
        });
    }
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
