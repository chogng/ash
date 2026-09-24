use std::error::Error;
use std::fmt;

/// Validated 32-bit RGBA artwork for a native window icon.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowIcon {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

impl WindowIcon {
    /// Creates an icon when the byte count exactly matches `width * height * 4`.
    pub fn from_rgba(rgba: Vec<u8>, width: u32, height: u32) -> Result<Self, WindowIconError> {
        let expected = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            .and_then(|bytes| usize::try_from(bytes).ok());
        if width == 0 || height == 0 || expected != Some(rgba.len()) {
            return Err(WindowIconError);
        }
        Ok(Self {
            rgba,
            width,
            height,
        })
    }

    /// Returns the icon's physical pixel dimensions.
    pub const fn extent(&self) -> super::PhysicalExtent {
        super::PhysicalExtent::new(self.width, self.height)
    }

    /// Returns the owned icon's non-premultiplied RGBA8 pixels.
    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    /// Returns the physical pixel width.
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// Returns the physical pixel height.
    pub const fn height(&self) -> u32 {
        self.height
    }

    pub(crate) fn into_native(self) -> winit::window::Icon {
        winit::window::Icon::from_rgba(self.rgba, self.width, self.height)
            .expect("validated ZUI window icon remains valid for winit")
    }
}

/// Invalid dimensions or RGBA byte length supplied for a window icon.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowIconError;

impl fmt::Display for WindowIconError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("window icon must contain width * height RGBA pixels")
    }
}

impl Error for WindowIconError {}

#[cfg(test)]
#[path = "icon_tests.rs"]
mod tests;
