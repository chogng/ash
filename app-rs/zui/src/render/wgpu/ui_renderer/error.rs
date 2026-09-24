#[derive(Debug, thiserror::Error)]
pub(crate) enum UiRenderError {
    #[error("UI scale factor must be finite and positive, got {0}")]
    InvalidScaleFactor(f32),
    #[error("rounded clip {index} is invalid: {reason}")]
    InvalidClip { index: usize, reason: &'static str },
    #[error("paint rect {index} is invalid: {reason}")]
    InvalidPaintRect { index: usize, reason: &'static str },
    #[error("paint icon {index} is invalid: {reason}")]
    InvalidPaintIcon { index: usize, reason: &'static str },
    #[error("paint image {index} is invalid: {reason}")]
    InvalidPaintImage { index: usize, reason: &'static str },
    #[error("SVG icon {name} is invalid: {reason}")]
    InvalidSvgIcon { name: &'static str, reason: String },
    #[error("SVG icon {name} cannot be rasterized at {width}x{height}")]
    IconRasterTooLarge {
        name: &'static str,
        width: u32,
        height: u32,
    },
    #[error("icon atlas is full at {width}x{height}")]
    IconAtlasFull { width: u32, height: u32 },
    #[error("image atlas is full at {width}x{height}")]
    ImageAtlasFull { width: u32, height: u32 },
    #[error("text block {index} is invalid: {reason}")]
    InvalidTextBlock { index: usize, reason: &'static str },
    #[error("failed to prepare UI text: {0}")]
    Prepare(#[from] glyphon::PrepareError),
    #[error("failed to render UI text: {0}")]
    Render(#[from] glyphon::RenderError),
}
