use std::collections::HashMap;
use std::mem;
use std::ops::Range;

use bytemuck::{Pod, Zeroable};

use crate::ui::foundation::Rect;
use crate::ui::presentation::{ImageId, PaintImage, UiScene};

use super::{UiRenderError, UiViewport};

const ATLAS_SIZE: u32 = 4_096;
const ATLAS_PADDING: u32 = 1;
const INSTANCE_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x4
];

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ImageInstance {
    bounds: [f32; 4],
    uv_bounds: [f32; 4],
    clip_bounds: [f32; 4],
    viewport: [f32; 4],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AtlasRegion {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl AtlasRegion {
    fn uv_bounds(self) -> [f32; 4] {
        [
            self.x as f32 / ATLAS_SIZE as f32,
            self.y as f32 / ATLAS_SIZE as f32,
            self.width as f32 / ATLAS_SIZE as f32,
            self.height as f32 / ATLAS_SIZE as f32,
        ]
    }
}

struct ShelfAllocator {
    next_x: u32,
    next_y: u32,
    row_height: u32,
}

impl ShelfAllocator {
    fn new() -> Self {
        Self {
            next_x: ATLAS_PADDING,
            next_y: ATLAS_PADDING,
            row_height: 0,
        }
    }

    fn allocate(&mut self, width: u32, height: u32) -> Option<AtlasRegion> {
        if width + ATLAS_PADDING * 2 > ATLAS_SIZE || height + ATLAS_PADDING * 2 > ATLAS_SIZE {
            return None;
        }
        if self.next_x + width + ATLAS_PADDING > ATLAS_SIZE {
            self.next_x = ATLAS_PADDING;
            self.next_y += self.row_height + ATLAS_PADDING;
            self.row_height = 0;
        }
        if self.next_y + height + ATLAS_PADDING > ATLAS_SIZE {
            return None;
        }
        let region = AtlasRegion {
            x: self.next_x,
            y: self.next_y,
            width,
            height,
        };
        self.next_x += width + ATLAS_PADDING;
        self.row_height = self.row_height.max(height);
        Some(region)
    }
}

pub(crate) struct ImageRenderer {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    atlas: wgpu::Texture,
    instance_buffer: wgpu::Buffer,
    instance_capacity: usize,
    primitive_ranges: Vec<Range<u32>>,
    allocator: ShelfAllocator,
    regions: HashMap<ImageId, AtlasRegion>,
}

impl ImageRenderer {
    pub(super) fn cache_entries(&self) -> usize {
        self.regions.len()
    }

    pub(crate) fn new(
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        depth_stencil: wgpu::DepthStencilState,
    ) -> Self {
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ash-ui image atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ash-ui image sampler"),
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ash-ui image bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ash-ui image bind group"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ash-ui image shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("image.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ash-ui image pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ash-ui image pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: mem::size_of::<ImageInstance>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &INSTANCE_ATTRIBUTES,
                })],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(depth_stencil),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Self {
            pipeline,
            bind_group,
            atlas,
            instance_buffer: create_instance_buffer(device, 1),
            instance_capacity: 1,
            primitive_ranges: Vec::new(),
            allocator: ShelfAllocator::new(),
            regions: HashMap::new(),
        }
    }

    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &UiScene,
        target: UiViewport,
    ) -> Result<(), UiRenderError> {
        let scale = target.scale_factor();
        let logical_viewport = Rect::from_xywh(
            0.0,
            0.0,
            target.width() as f32 / scale,
            target.height() as f32 / scale,
        );
        let viewport = [target.width() as f32, target.height() as f32, 0.0, 0.0];
        let mut instances = Vec::with_capacity(scene.images().len());
        self.primitive_ranges.clear();
        for (index, image) in scene.images().iter().enumerate() {
            let start = instances.len() as u32;
            validate_image(index, image)?;
            let bounds = image.bounds();
            let clip = image
                .clip_bounds()
                .map(|clip| clip.intersection(logical_viewport))
                .unwrap_or(logical_viewport);
            if bounds.is_empty() || bounds.intersection(clip).is_empty() {
                self.primitive_ranges.push(start..start);
                continue;
            }
            let region = self.region_for(queue, image)?;
            instances.push(ImageInstance {
                bounds: scaled_rect(bounds, scale),
                uv_bounds: region.uv_bounds(),
                clip_bounds: scaled_rect(clip, scale),
                viewport,
            });
            self.primitive_ranges.push(start..instances.len() as u32);
        }
        if instances.len() > self.instance_capacity {
            self.instance_capacity = instances.len().next_power_of_two();
            self.instance_buffer = create_instance_buffer(device, self.instance_capacity);
        }
        if !instances.is_empty() {
            queue.write_buffer(&self.instance_buffer, 0, bytemuck::cast_slice(&instances));
        }
        Ok(())
    }

    fn region_for(
        &mut self,
        queue: &wgpu::Queue,
        paint: &PaintImage,
    ) -> Result<AtlasRegion, UiRenderError> {
        let image = paint.image();
        if let Some(region) = self.regions.get(&image.id()) {
            return Ok(*region);
        }
        let Some(region) = self.allocator.allocate(image.width(), image.height()) else {
            return Err(UiRenderError::ImageAtlasFull {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
            });
        };
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: region.x,
                    y: region.y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            image.rgba8(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(image.width() * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: image.width(),
                height: image.height(),
                depth_or_array_layers: 1,
            },
        );
        self.regions.insert(image.id(), region);
        Ok(region)
    }

    pub(crate) fn render_range<'pass>(
        &'pass self,
        pass: &mut wgpu::RenderPass<'pass>,
        primitive_range: Range<usize>,
    ) {
        let Some(range) = super::rect::instance_range(&self.primitive_ranges, primitive_range)
        else {
            return;
        };
        if range.is_empty() {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
        pass.draw(0..6, range.clone());
    }
}

fn validate_image(index: usize, image: &PaintImage) -> Result<(), UiRenderError> {
    let bounds = image.bounds();
    let values = [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
    ];
    if values.into_iter().any(|value| !value.is_finite())
        || bounds.size.width <= 0.0
        || bounds.size.height <= 0.0
    {
        return Err(UiRenderError::InvalidPaintImage {
            index,
            reason: "bounds must be finite and positive",
        });
    }
    Ok(())
}

fn create_instance_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ash-ui image instances"),
        size: (mem::size_of::<ImageInstance>() * capacity) as wgpu::BufferAddress,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn scaled_rect(rect: Rect, scale: f32) -> [f32; 4] {
    [
        rect.origin.x * scale,
        rect.origin.y * scale,
        rect.size.width * scale,
        rect.size.height * scale,
    ]
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
