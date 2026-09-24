use std::error::Error;
use std::fmt;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use super::SystemServiceError;
use super::blocking::BlockingServiceExecutor;

#[path = "file_icon/platform.rs"]
mod platform;

const FILE_ICON_SERVICE: &str = "file icon";

/// Owned asynchronous result returned by a file-icon request.
pub type FileIconFuture =
    Pin<Box<dyn Future<Output = Result<FileIconImage, SystemServiceError>> + Send + 'static>>;

/// Electron-compatible logical size requested from the operating system.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum FileIconSize {
    /// A 16-by-16 pixel icon.
    Small,
    /// A 32-by-32 pixel icon.
    #[default]
    Normal,
    /// A 48-by-48 pixel icon on Linux and 32-by-32 pixel icon on Windows.
    ///
    /// The system macOS backend returns an explicit unsupported error for this size.
    Large,
}

/// One validated request for an operating-system file or file-type icon.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIconRequest {
    path: PathBuf,
    size: FileIconSize,
}

impl FileIconRequest {
    /// Creates a normal-size request for `path`.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            size: FileIconSize::Normal,
        }
    }

    /// Selects the logical icon size.
    pub fn with_size(mut self, size: FileIconSize) -> Self {
        self.size = size;
        self
    }

    /// Returns the path whose icon or file-type association is requested.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns the requested logical icon size.
    pub const fn size(&self) -> FileIconSize {
        self.size
    }

    /// Validates path content before native or injected backend dispatch.
    pub fn validate(&self) -> Result<(), FileIconRequestError> {
        if self.path.as_os_str().is_empty() {
            return Err(FileIconRequestError::EmptyPath);
        }
        if self.path.to_string_lossy().contains('\0') {
            return Err(FileIconRequestError::NullPath);
        }
        Ok(())
    }
}

/// Invalid backend-independent file-icon request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileIconRequestError {
    /// The requested path is empty.
    EmptyPath,
    /// The requested path contains a null code point that native APIs cannot represent.
    NullPath,
}

impl fmt::Display for FileIconRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPath => formatter.write_str("file icon path cannot be empty"),
            Self::NullPath => formatter.write_str("file icon path cannot contain a null byte"),
        }
    }
}

impl Error for FileIconRequestError {}

/// Owned non-premultiplied RGBA8 file-icon pixels.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIconImage {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

impl FileIconImage {
    /// Creates validated RGBA8 icon pixels.
    pub fn from_rgba(
        rgba: impl Into<Vec<u8>>,
        width: u32,
        height: u32,
    ) -> Result<Self, FileIconImageError> {
        if width == 0 || height == 0 {
            return Err(FileIconImageError::ZeroDimensions);
        }
        let expected = usize::try_from(width)
            .ok()
            .and_then(|width| {
                usize::try_from(height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(FileIconImageError::DimensionsOverflow)?;
        let rgba = rgba.into();
        if rgba.len() != expected {
            return Err(FileIconImageError::InvalidRgbaLength {
                expected,
                actual: rgba.len(),
            });
        }
        Ok(Self {
            rgba,
            width,
            height,
        })
    }

    /// Returns non-premultiplied pixels in RGBA order.
    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    /// Returns the pixel width.
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// Returns the pixel height.
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// Consumes the image and returns its RGBA pixels.
    pub fn into_rgba(self) -> Vec<u8> {
        self.rgba
    }
}

/// Invalid RGBA8 file-icon storage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileIconImageError {
    /// At least one image dimension is zero.
    ZeroDimensions,
    /// The dimensions cannot be represented as one RGBA8 allocation length.
    DimensionsOverflow,
    /// The supplied byte count does not equal `width * height * 4`.
    InvalidRgbaLength { expected: usize, actual: usize },
}

impl fmt::Display for FileIconImageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDimensions => formatter.write_str("file icon dimensions must be non-zero"),
            Self::DimensionsOverflow => {
                formatter.write_str("file icon dimensions overflow the RGBA allocation length")
            }
            Self::InvalidRgbaLength { expected, actual } => write!(
                formatter,
                "file icon RGBA length must be {expected} bytes, received {actual}"
            ),
        }
    }
}

impl Error for FileIconImageError {}

/// Synchronous backend executed through an injectable asynchronous [`FileIconHandle`].
pub trait FileIconService: Send + Sync {
    /// Loads one exact-size, non-premultiplied RGBA8 icon.
    fn load(&self, request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError>;
}

/// Cloneable asynchronous capability for retrieving operating-system file icons.
#[derive(Clone)]
pub struct FileIconHandle {
    service: Arc<dyn FileIconService>,
    executor: BlockingServiceExecutor,
}

impl FileIconHandle {
    pub(crate) fn new(service: impl FileIconService + 'static) -> Self {
        Self {
            service: Arc::new(service),
            executor: BlockingServiceExecutor,
        }
    }

    /// Loads a normal-size icon without blocking the calling thread.
    pub fn get(&self, path: impl Into<PathBuf>) -> FileIconFuture {
        self.get_with(FileIconRequest::new(path))
    }

    /// Loads one explicitly sized icon without blocking the calling thread.
    pub fn get_with(&self, request: FileIconRequest) -> FileIconFuture {
        if let Err(error) = request.validate() {
            return Box::pin(async move {
                Err(SystemServiceError::invalid_input(FILE_ICON_SERVICE, error))
            });
        }
        let service = Arc::clone(&self.service);
        self.executor
            .spawn(FILE_ICON_SERVICE, move || service.load(&request))
    }
}

/// Default operating-system file-icon backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemFileIcons;

impl FileIconService for SystemFileIcons {
    fn load(&self, request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
        platform::load(request)
    }
}

#[cfg(test)]
#[path = "file_icon_tests.rs"]
mod tests;
