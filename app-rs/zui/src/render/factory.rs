use crate::render::Renderer;
use crate::render::RendererError;
#[cfg(feature = "wgpu")]
use crate::render::wgpu::WgpuRenderer;
use crate::window::RenderWindow;

/// Creates one renderer for each native window opened by the application runtime.
///
/// Applications normally use `WgpuRendererFactory`. Tests and alternative backends implement
/// this contract without changing window lifecycle or product scene construction.
pub trait RendererFactory {
    /// Creates a backend-neutral renderer that owns presentation resources for `window`.
    fn create(&mut self, window: RenderWindow) -> Result<Box<dyn Renderer>, RendererError>;
}

/// Default renderer factory backed by zui's private wgpu implementation.
#[cfg(feature = "wgpu")]
#[derive(Clone, Copy, Debug, Default)]
pub struct WgpuRendererFactory;

#[cfg(feature = "wgpu")]
impl RendererFactory for WgpuRendererFactory {
    fn create(&mut self, window: RenderWindow) -> Result<Box<dyn Renderer>, RendererError> {
        WgpuRenderer::initialize(window)
            .map(|renderer| Box::new(renderer) as Box<dyn Renderer>)
            .map_err(RendererError::backend)
    }
}
