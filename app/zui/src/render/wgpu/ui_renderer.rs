use crate::render::support::create_font_system;
use crate::ui::presentation::{SceneBatch, TextBlock, UiScene};
use glyphon::{Buffer, Cache, Resolution, SwashCache, TextArea, TextAtlas, TextRenderer, Viewport};
use std::sync::Arc;

use self::clip::{ClipRenderer, PreparedBatch, content_depth_stencil};
use self::icon::IconRenderer;
use self::image::ImageRenderer;
use self::rect::RectRenderer;
use self::text::{
    PreparedArea, prepare_text_buffer, prepared_area, same_text_buffer_layout, validate_text_block,
};

mod clip;
mod error;
mod icon;
mod image;
mod rect;
mod target;
mod text;

pub(super) use clip::CLIP_FORMAT;
pub(super) use error::UiRenderError;
pub use target::UiViewport;

struct TextLayer {
    renderer: TextRenderer,
    buffers: Vec<Arc<Buffer>>,
    areas: Vec<PreparedArea>,
}

struct CachedTextBuffer {
    block: TextBlock,
    scale_factor_bits: u32,
    buffer: Arc<Buffer>,
}

impl CachedTextBuffer {
    fn matches(&self, block: &TextBlock, scale_factor: f32) -> bool {
        self.scale_factor_bits == scale_factor.to_bits()
            && same_text_buffer_layout(&self.block, block)
    }
}

impl TextLayer {
    fn new(atlas: &mut TextAtlas, device: &wgpu::Device) -> Self {
        Self {
            renderer: TextRenderer::new(
                atlas,
                device,
                wgpu::MultisampleState::default(),
                Some(content_depth_stencil()),
            ),
            buffers: Vec::new(),
            areas: Vec::new(),
        }
    }
}

/// Owns the font shaping, glyph cache, atlas, and GPU pipeline for a native UI surface.
pub struct UiRenderer {
    cache_entries: Arc<std::sync::atomic::AtomicUsize>,
    clip_renderer: ClipRenderer,
    rect_renderer: RectRenderer,
    icon_renderer: IconRenderer,
    image_renderer: ImageRenderer,
    font_system: glyphon::FontSystem,
    swash_cache: SwashCache,
    viewport: Viewport,
    atlas: TextAtlas,
    text_batches: Vec<TextLayer>,
    text_buffer_cache: Vec<CachedTextBuffer>,
    prepared_batches: Vec<PreparedBatch>,
    prepared_scene_batches: Vec<SceneBatch>,
    prepared_text_blocks: Vec<TextBlock>,
    prepared_target: Option<UiViewport>,
}

impl UiRenderer {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut atlas = TextAtlas::new(device, queue, &cache, surface_format);
        let text_batches = vec![TextLayer::new(&mut atlas, device)];
        Self {
            cache_entries: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            clip_renderer: ClipRenderer::new(device, surface_format),
            rect_renderer: RectRenderer::new(device, surface_format, content_depth_stencil()),
            icon_renderer: IconRenderer::new(device, surface_format, content_depth_stencil()),
            image_renderer: ImageRenderer::new(device, surface_format, content_depth_stencil()),
            font_system: create_font_system(),
            swash_cache: SwashCache::new(),
            viewport,
            atlas,
            text_batches,
            text_buffer_cache: Vec::new(),
            prepared_batches: Vec::new(),
            prepared_scene_batches: Vec::new(),
            prepared_text_blocks: Vec::new(),
            prepared_target: None,
        }
    }

    pub(super) fn cache_entries(&self) -> Arc<std::sync::atomic::AtomicUsize> {
        Arc::clone(&self.cache_entries)
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &UiScene,
        target: UiViewport,
    ) -> Result<(), UiRenderError> {
        let scale_factor = target.scale_factor();
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return Err(UiRenderError::InvalidScaleFactor(scale_factor));
        }
        let target_changed = self.prepared_target != Some(target);
        if target_changed {
            self.viewport.update(
                queue,
                Resolution {
                    width: target.width(),
                    height: target.height(),
                },
            );
        }
        self.clip_renderer.prepare(device, queue, scene, target)?;
        self.rect_renderer.prepare(device, queue, scene, target)?;
        self.icon_renderer.prepare(device, queue, scene, target)?;
        self.image_renderer.prepare(device, queue, scene, target)?;
        let scene_batches = scene.batches().collect::<Vec<_>>();
        let text_changed = target_changed
            || self.prepared_scene_batches != scene_batches
            || self.prepared_text_blocks != scene.text_blocks();
        if text_changed {
            self.refresh_text_buffer_cache(scene, scale_factor)?;
            self.prepared_batches.clear();
            let mut text_batch_index = 0;
            for batch in &scene_batches {
                match batch {
                    SceneBatch::ClipStart { index, depth, .. } => {
                        self.prepared_batches.push(PreparedBatch::ClipStart {
                            index: *index,
                            depth: *depth,
                        });
                    }
                    SceneBatch::ClipEnd { index, depth, .. } => {
                        self.prepared_batches.push(PreparedBatch::ClipEnd {
                            index: *index,
                            depth: *depth,
                        });
                    }
                    SceneBatch::Rects {
                        range, clip_depth, ..
                    } => {
                        self.prepared_batches.push(PreparedBatch::Rects {
                            range: range.clone(),
                            clip_depth: *clip_depth,
                        });
                    }
                    SceneBatch::Icons {
                        range, clip_depth, ..
                    } => {
                        self.prepared_batches.push(PreparedBatch::Icons {
                            range: range.clone(),
                            clip_depth: *clip_depth,
                        });
                    }
                    SceneBatch::Images {
                        range, clip_depth, ..
                    } => {
                        self.prepared_batches.push(PreparedBatch::Images {
                            range: range.clone(),
                            clip_depth: *clip_depth,
                        });
                    }
                    SceneBatch::Text {
                        range, clip_depth, ..
                    } => {
                        if text_batch_index == self.text_batches.len() {
                            self.text_batches
                                .push(TextLayer::new(&mut self.atlas, device));
                        }
                        let text_batch = &mut self.text_batches[text_batch_index];
                        text_batch.buffers.clear();
                        text_batch.areas.clear();
                        for index in range.clone() {
                            let block = &scene.text_blocks()[index];
                            text_batch
                                .buffers
                                .push(self.text_buffer_cache[index].buffer.clone());
                            text_batch.areas.push(prepared_area(
                                block,
                                scale_factor,
                                block.style().color(),
                            ));
                        }
                        let text_areas =
                            text_batch.buffers.iter().zip(text_batch.areas.iter()).map(
                                |(buffer, area)| TextArea {
                                    buffer,
                                    left: area.left,
                                    top: area.top,
                                    scale: 1.0,
                                    bounds: area.bounds,
                                    default_color: area.color,
                                    custom_glyphs: &[],
                                },
                            );
                        text_batch.renderer.prepare(
                            device,
                            queue,
                            &mut self.font_system,
                            &mut self.atlas,
                            &self.viewport,
                            text_areas,
                            &mut self.swash_cache,
                        )?;
                        self.prepared_batches.push(PreparedBatch::Text {
                            index: text_batch_index,
                            clip_depth: *clip_depth,
                        });
                        text_batch_index += 1;
                    }
                }
            }
            for unused_batch in self.text_batches.iter_mut().skip(text_batch_index) {
                unused_batch.buffers.clear();
                unused_batch.areas.clear();
            }
        }
        self.prepared_scene_batches = scene_batches;
        self.prepared_text_blocks = scene.text_blocks().to_vec();
        self.prepared_target = Some(target);
        self.cache_entries.store(
            self.image_renderer.cache_entries()
                + self.icon_renderer.cache_entries()
                + self.text_buffer_cache.len(),
            std::sync::atomic::Ordering::Relaxed,
        );
        Ok(())
    }

    fn refresh_text_buffer_cache(
        &mut self,
        scene: &UiScene,
        scale_factor: f32,
    ) -> Result<(), UiRenderError> {
        for (index, block) in scene.text_blocks().iter().enumerate() {
            validate_text_block(index, block)?;
            if self
                .text_buffer_cache
                .get(index)
                .is_some_and(|cached| cached.matches(block, scale_factor))
            {
                continue;
            }
            let cached = CachedTextBuffer {
                block: block.clone(),
                scale_factor_bits: scale_factor.to_bits(),
                buffer: Arc::new(prepare_text_buffer(
                    &mut self.font_system,
                    block,
                    scale_factor,
                )),
            };
            if let Some(slot) = self.text_buffer_cache.get_mut(index) {
                *slot = cached;
            } else {
                self.text_buffer_cache.push(cached);
            }
        }
        self.text_buffer_cache.truncate(scene.text_blocks().len());
        Ok(())
    }

    pub fn render<'pass>(
        &'pass self,
        render_pass: &mut wgpu::RenderPass<'pass>,
    ) -> Result<(), UiRenderError> {
        for batch in &self.prepared_batches {
            match batch {
                PreparedBatch::ClipStart { index, depth } => {
                    self.clip_renderer.render_start(render_pass, *index, *depth);
                }
                PreparedBatch::ClipEnd { index, depth } => {
                    self.clip_renderer.render_end(render_pass, *index, *depth);
                }
                PreparedBatch::Rects { range, clip_depth } => {
                    render_pass.set_stencil_reference(*clip_depth);
                    self.rect_renderer.render_range(render_pass, range.clone());
                }
                PreparedBatch::Icons { range, clip_depth } => {
                    render_pass.set_stencil_reference(*clip_depth);
                    self.icon_renderer.render_range(render_pass, range.clone());
                }
                PreparedBatch::Images { range, clip_depth } => {
                    render_pass.set_stencil_reference(*clip_depth);
                    self.image_renderer.render_range(render_pass, range.clone());
                }
                PreparedBatch::Text { index, clip_depth } => {
                    render_pass.set_stencil_reference(*clip_depth);
                    self.text_batches[*index].renderer.render(
                        &self.atlas,
                        &self.viewport,
                        render_pass,
                    )?;
                }
            }
        }
        Ok(())
    }

    pub fn trim(&mut self) {
        self.atlas.trim();
    }
}

#[cfg(test)]
#[path = "ui_renderer_tests.rs"]
mod tests;
