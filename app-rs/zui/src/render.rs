//! Backend-neutral rendering boundary between UI scenes and graphics implementations.

use std::error::Error;
use std::sync::Arc;

use crate::ui::presentation::UiScene;
use thiserror::Error;

#[cfg(feature = "native")]
mod factory;
#[cfg(feature = "wgpu")]
pub(crate) mod support;
#[cfg(feature = "wgpu")]
pub(crate) mod wgpu;

#[cfg(feature = "native")]
pub use crate::window::RenderWindow;
#[cfg(feature = "native")]
pub use factory::RendererFactory;
#[cfg(feature = "wgpu")]
pub use factory::WgpuRendererFactory;

/// Physical dimensions of the renderer's current presentation target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RenderTargetSize {
    width: u32,
    height: u32,
}

impl RenderTargetSize {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    pub const fn width(self) -> u32 {
        self.width
    }

    pub const fn height(self) -> u32 {
        self.height
    }
}

/// Result of attempting to present one renderer frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderOutcome {
    Presented,
    Skipped,
    Retry,
}

/// A graphics-backend failure crossing the backend-neutral renderer boundary.
#[derive(Debug, Error)]
#[error("render backend failed: {source}")]
pub struct RendererError {
    #[source]
    source: Box<dyn Error + Send + Sync>,
}

impl RendererError {
    /// Preserves a concrete backend error as the source of a renderer failure.
    pub fn backend(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

/// Counts retained rendering handles and image/icon/text-buffer cache entries, not driver bytes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RendererMemory {
    pub gpu_resources: usize,
    pub cache_entries: usize,
}

/// A thread-safe diagnostic reader owned by one renderer's window registration.
#[derive(Clone)]
pub struct RendererMemoryReader(Arc<dyn Fn() -> RendererMemory + Send + Sync>);

impl RendererMemoryReader {
    pub fn new(read: impl Fn() -> RendererMemory + Send + Sync + 'static) -> Self {
        Self(Arc::new(read))
    }

    pub fn read(&self) -> RendererMemory {
        self.0()
    }
}

/// Executes backend-neutral [`UiScene`] frames on one presentation target.
///
/// Implementations own graphics resources and surface lifecycle. Product components only emit
/// scene primitives; they must never receive a concrete graphics device, queue, encoder, or render
/// pass. Hosts may replace an implementation without changing component or scene construction.
pub trait Renderer {
    /// Returns an explicit diagnostic capability when this renderer exposes resource counts.
    fn memory_reader(&self) -> Option<RendererMemoryReader> {
        None
    }

    /// Reconfigures the physical presentation target.
    fn resize(&mut self, size: RenderTargetSize);

    /// Records the logical-to-physical scale used for subsequent frames.
    fn set_scale_factor(&mut self, scale_factor: f64);

    /// Clears and presents one frame without UI scene content.
    fn render(&mut self) -> Result<RenderOutcome, RendererError>;

    /// Renders and presents one immutable backend-neutral UI scene.
    fn render_scene(&mut self, scene: &UiScene) -> Result<RenderOutcome, RendererError>;
}

#[cfg(test)]
#[path = "render/render_tests.rs"]
mod tests;
