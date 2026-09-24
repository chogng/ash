//! Native GPU presentation backend for Rust products.

mod gpu;
mod ui_renderer;
mod viewport;

pub(crate) use gpu::WgpuRenderer;
