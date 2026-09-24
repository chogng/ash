#[cfg(not(target_os = "android"))]
use std::borrow::Cow;
use std::cell::RefCell;
use std::fmt::Display;
use std::rc::Rc;

use thiserror::Error;

/// Failure while using a platform clipboard capability.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ClipboardError {
    /// The current target has no system clipboard implementation.
    #[error("system clipboard is unsupported on this platform")]
    Unsupported,
    /// The platform clipboard rejected an operation.
    #[error("system clipboard {operation} failed: {message}")]
    Backend {
        /// Stable operation label.
        operation: &'static str,
        /// Backend diagnostic without exposing backend types in the public contract.
        message: String,
    },
    /// RGBA bytes did not match the declared image dimensions.
    #[error(
        "clipboard image {width}x{height} requires four RGBA bytes per pixel, got {byte_length}"
    )]
    InvalidImage {
        width: usize,
        height: usize,
        byte_length: usize,
    },
}

/// HTML clipboard content with an optional plain-text representation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClipboardHtml {
    html: String,
    plain_text: Option<String>,
}

impl ClipboardHtml {
    /// Creates HTML content without a separate plain-text representation.
    pub fn new(html: impl Into<String>) -> Self {
        Self {
            html: html.into(),
            plain_text: None,
        }
    }

    /// Attaches the plain-text representation exposed to non-HTML consumers.
    pub fn with_plain_text(mut self, plain_text: impl Into<String>) -> Self {
        self.plain_text = Some(plain_text.into());
        self
    }

    /// Returns the HTML markup.
    pub fn html(&self) -> &str {
        &self.html
    }

    /// Returns the optional plain-text representation.
    pub fn plain_text(&self) -> Option<&str> {
        self.plain_text.as_deref()
    }
}

/// Owned RGBA8 image transferred through the platform clipboard.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClipboardImage {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

impl ClipboardImage {
    /// Validates and creates an image containing four RGBA bytes per pixel.
    pub fn from_rgba(rgba: Vec<u8>, width: u32, height: u32) -> Result<Self, ClipboardError> {
        validate_image(width as usize, height as usize, rgba.len())?;
        Ok(Self {
            rgba,
            width,
            height,
        })
    }

    /// Returns the row-major RGBA8 bytes.
    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    /// Returns the image width in physical pixels.
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// Returns the image height in physical pixels.
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// Consumes the image and returns its row-major RGBA8 bytes.
    pub fn into_rgba(self) -> Vec<u8> {
        self.rgba
    }

    #[cfg(not(target_os = "android"))]
    fn from_native(image: arboard::ImageData<'static>) -> Result<Self, ClipboardError> {
        let width = u32::try_from(image.width).map_err(|_| ClipboardError::InvalidImage {
            width: image.width,
            height: image.height,
            byte_length: image.bytes.len(),
        })?;
        let height = u32::try_from(image.height).map_err(|_| ClipboardError::InvalidImage {
            width: image.width,
            height: image.height,
            byte_length: image.bytes.len(),
        })?;
        Self::from_rgba(image.bytes.into_owned(), width, height)
    }
}

fn validate_image(width: usize, height: usize, byte_length: usize) -> Result<(), ClipboardError> {
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(byte_length) {
        return Err(ClipboardError::InvalidImage {
            width,
            height,
            byte_length,
        });
    }
    Ok(())
}

impl ClipboardError {
    #[cfg(not(target_os = "android"))]
    fn backend(operation: &'static str, error: impl Display) -> Self {
        Self::Backend {
            operation,
            message: error.to_string(),
        }
    }
}

/// Main-thread clipboard capability supplied to an application.
///
/// Platform implementations own backend handles. Products consume this small contract and do not
/// construct a second clipboard backend or depend on platform clipboard libraries directly.
pub trait Clipboard {
    /// Replaces the system clipboard text.
    fn write_text(&mut self, text: String) -> Result<(), ClipboardError>;

    /// Reads the current system clipboard text.
    fn read_text(&mut self) -> Result<String, ClipboardError>;

    /// Replaces the system clipboard with HTML content.
    fn write_html(&mut self, _content: ClipboardHtml) -> Result<(), ClipboardError> {
        Err(ClipboardError::Unsupported)
    }

    /// Reads HTML markup from the system clipboard.
    fn read_html(&mut self) -> Result<String, ClipboardError> {
        Err(ClipboardError::Unsupported)
    }

    /// Replaces the system clipboard with an RGBA8 image.
    fn write_image(&mut self, _image: ClipboardImage) -> Result<(), ClipboardError> {
        Err(ClipboardError::Unsupported)
    }

    /// Reads and decodes an RGBA8 image from the system clipboard.
    fn read_image(&mut self) -> Result<ClipboardImage, ClipboardError> {
        Err(ClipboardError::Unsupported)
    }

    /// Clears all formats from the default system clipboard.
    fn clear(&mut self) -> Result<(), ClipboardError> {
        Err(ClipboardError::Unsupported)
    }
}

/// Cloneable main-thread handle to the runtime-owned clipboard capability.
#[derive(Clone)]
pub struct ClipboardHandle {
    clipboard: Rc<RefCell<Box<dyn Clipboard>>>,
}

impl ClipboardHandle {
    pub(crate) fn new(clipboard: impl Clipboard + 'static) -> Self {
        Self {
            clipboard: Rc::new(RefCell::new(Box::new(clipboard))),
        }
    }

    /// Replaces the platform clipboard text.
    pub fn write_text(&self, text: String) -> Result<(), ClipboardError> {
        self.clipboard.borrow_mut().write_text(text)
    }

    /// Reads the current platform clipboard text.
    pub fn read_text(&self) -> Result<String, ClipboardError> {
        self.clipboard.borrow_mut().read_text()
    }

    /// Replaces the platform clipboard with HTML and its optional plain-text representation.
    pub fn write_html(&self, content: ClipboardHtml) -> Result<(), ClipboardError> {
        self.clipboard.borrow_mut().write_html(content)
    }

    /// Reads the current platform clipboard HTML markup.
    pub fn read_html(&self) -> Result<String, ClipboardError> {
        self.clipboard.borrow_mut().read_html()
    }

    /// Replaces the platform clipboard with an RGBA8 image.
    pub fn write_image(&self, image: ClipboardImage) -> Result<(), ClipboardError> {
        self.clipboard.borrow_mut().write_image(image)
    }

    /// Reads and decodes an RGBA8 image from the platform clipboard.
    pub fn read_image(&self) -> Result<ClipboardImage, ClipboardError> {
        self.clipboard.borrow_mut().read_image()
    }

    /// Clears all formats from the default platform clipboard.
    pub fn clear(&self) -> Result<(), ClipboardError> {
        self.clipboard.borrow_mut().clear()
    }
}

/// Default platform text clipboard implementation.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClipboard;

#[cfg(not(target_os = "android"))]
impl Clipboard for SystemClipboard {
    fn write_text(&mut self, text: String) -> Result<(), ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        clipboard
            .set_text(text)
            .map_err(|error| ClipboardError::backend("write", error))
    }

    fn read_text(&mut self) -> Result<String, ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        clipboard
            .get_text()
            .map_err(|error| ClipboardError::backend("read", error))
    }

    fn write_html(&mut self, content: ClipboardHtml) -> Result<(), ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        clipboard
            .set_html(content.html, content.plain_text)
            .map_err(|error| ClipboardError::backend("HTML write", error))
    }

    fn read_html(&mut self) -> Result<String, ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        clipboard
            .get()
            .html()
            .map_err(|error| ClipboardError::backend("HTML read", error))
    }

    fn write_image(&mut self, image: ClipboardImage) -> Result<(), ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        clipboard
            .set_image(arboard::ImageData {
                width: image.width as usize,
                height: image.height as usize,
                bytes: Cow::Owned(image.rgba),
            })
            .map_err(|error| ClipboardError::backend("image write", error))
    }

    fn read_image(&mut self) -> Result<ClipboardImage, ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        let image = clipboard
            .get_image()
            .map_err(|error| ClipboardError::backend("image read", error))?;
        ClipboardImage::from_native(image)
    }

    fn clear(&mut self) -> Result<(), ClipboardError> {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| ClipboardError::backend("initialization", error))?;
        clipboard
            .clear()
            .map_err(|error| ClipboardError::backend("clear", error))
    }
}

#[cfg(target_os = "android")]
impl Clipboard for SystemClipboard {
    fn write_text(&mut self, _text: String) -> Result<(), ClipboardError> {
        Err(ClipboardError::Unsupported)
    }

    fn read_text(&mut self) -> Result<String, ClipboardError> {
        Err(ClipboardError::Unsupported)
    }
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
