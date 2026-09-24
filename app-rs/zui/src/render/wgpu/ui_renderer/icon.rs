use std::collections::HashMap;
use std::mem;
use std::ops::Range;

use crate::ui::foundation::{Icon, Rect};
use crate::ui::presentation::{PaintIcon, UiScene};
use bytemuck::{Pod, Zeroable};

use super::rect::linear_color;
use super::{UiRenderError, UiViewport};

mod support;

use support::{rasterize_icon, scaled_rect, validate_paint_icon};

const ATLAS_SIZE: u32 = 2_048;
const ATLAS_PADDING: u32 = 1;
const INSTANCE_ATTRIBUTES: [wgpu::VertexAttribute; 5] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x4,
    4 => Float32x4
];

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct IconInstance {
    bounds: [f32; 4],
    uv_bounds: [f32; 4],
    color: [f32; 4],
    clip_bounds: [f32; 4],
    viewport: [f32; 4],
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct RasterKey {
    icon: Icon,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AtlasRegion {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
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

pub(crate) struct IconRenderer {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    mask_atlas: wgpu::Texture,
    color_atlas: wgpu::Texture,
    instance_buffer: wgpu::Buffer,
    instance_capacity: usize,
    instances: Vec<IconInstance>,
    primitive_ranges: Vec<Range<u32>>,
    source_icons: Vec<PaintIcon>,
    target: Option<UiViewport>,
    allocator: ShelfAllocator,
    regions: HashMap<RasterKey, AtlasRegion>,
}

impl IconRenderer {
    pub(super) fn cache_entries(&self) -> usize {
        self.regions.len()
    }

    pub(crate) fn new(
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        depth_stencil: wgpu::DepthStencilState,
    ) -> Self {
        let mask_atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ash-ui icon symbolic-mask atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let color_atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ash-ui icon fixed-color atlas"),
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
        let mask_atlas_view = mask_atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let color_atlas_view = color_atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ash-ui icon sampler"),
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ash-ui icon bind group layout"),
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
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ash-ui icon bind group"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&mask_atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&color_atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ash-ui icon shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("icon.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ash-ui icon pipeline layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ash-ui icon pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: mem::size_of::<IconInstance>() as wgpu::BufferAddress,
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
        let instance_capacity = 1;
        Self {
            pipeline,
            bind_group,
            mask_atlas,
            color_atlas,
            instance_buffer: create_instance_buffer(device, instance_capacity),
            instance_capacity,
            instances: Vec::new(),
            primitive_ranges: Vec::new(),
            source_icons: Vec::new(),
            target: None,
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
        if self.target == Some(target) && self.source_icons.len() == scene.icons().len() {
            let mut changed = Vec::new();
            let mut can_update_in_place = true;
            for (index, icon) in scene.icons().iter().copied().enumerate() {
                if self.source_icons[index] == icon {
                    continue;
                }
                let instance = self.prepare_icon_instance(queue, index, icon, target)?;
                let range = &self.primitive_ranges[index];
                if instance.is_some() != (range.len() == 1) {
                    can_update_in_place = false;
                    break;
                }
                changed.push((index, instance));
            }
            if can_update_in_place {
                for (index, instance) in changed {
                    let range = self.primitive_ranges[index].clone();
                    if let Some(instance) = instance {
                        self.instances[range.start as usize] = instance;
                        let offset = u64::from(range.start) * mem::size_of::<IconInstance>() as u64;
                        queue.write_buffer(
                            &self.instance_buffer,
                            offset,
                            bytemuck::bytes_of(&instance),
                        );
                    }
                    self.source_icons[index] = scene.icons()[index];
                }
                return Ok(());
            }
        }

        let prepared = self.prepare_instances(queue, scene, target)?;
        let instances = prepared.instances;
        self.instances = instances.clone();
        self.primitive_ranges = prepared.primitive_ranges;
        self.source_icons = scene.icons().to_vec();
        self.target = Some(target);
        if instances.is_empty() {
            return Ok(());
        }
        if instances.len() > self.instance_capacity {
            self.instance_capacity = instances.len().next_power_of_two();
            self.instance_buffer = create_instance_buffer(device, self.instance_capacity);
        }
        queue.write_buffer(&self.instance_buffer, 0, bytemuck::cast_slice(&instances));
        Ok(())
    }

    fn prepare_instances(
        &mut self,
        queue: &wgpu::Queue,
        scene: &UiScene,
        target: UiViewport,
    ) -> Result<PreparedIconInstances, UiRenderError> {
        let mut instances = Vec::with_capacity(scene.icons().len());
        let mut primitive_ranges = Vec::with_capacity(scene.icons().len());
        for (index, icon) in scene.icons().iter().copied().enumerate() {
            let start = instances.len() as u32;
            if let Some(instance) = self.prepare_icon_instance(queue, index, icon, target)? {
                instances.push(instance);
            }
            primitive_ranges.push(start..instances.len() as u32);
        }
        Ok(PreparedIconInstances {
            instances,
            primitive_ranges,
        })
    }

    fn prepare_icon_instance(
        &mut self,
        queue: &wgpu::Queue,
        index: usize,
        icon: PaintIcon,
        target: UiViewport,
    ) -> Result<Option<IconInstance>, UiRenderError> {
        let scale_factor = target.scale_factor();
        let viewport = [target.width() as f32, target.height() as f32, 0.0, 0.0];
        let logical_viewport = Rect::from_xywh(
            0.0,
            0.0,
            target.width() as f32 / scale_factor,
            target.height() as f32 / scale_factor,
        );
        validate_paint_icon(index, icon)?;
        let bounds = icon.bounds();
        let clip_bounds = icon
            .clip_bounds()
            .map(|clip| clip.intersection(logical_viewport))
            .unwrap_or(logical_viewport);
        if bounds.is_empty() || bounds.intersection(clip_bounds).is_empty() {
            return Ok(None);
        }
        let width = (bounds.size.width * scale_factor).ceil() as u32;
        let height = (bounds.size.height * scale_factor).ceil() as u32;
        let region = self.region_for(queue, icon.icon(), width, height)?;
        Ok(Some(IconInstance {
            bounds: scaled_rect(bounds, scale_factor),
            uv_bounds: region.uv_bounds(),
            color: linear_color(icon.color()),
            clip_bounds: scaled_rect(clip_bounds, scale_factor),
            viewport,
        }))
    }

    fn region_for(
        &mut self,
        queue: &wgpu::Queue,
        icon: Icon,
        width: u32,
        height: u32,
    ) -> Result<AtlasRegion, UiRenderError> {
        let key = RasterKey {
            icon,
            width,
            height,
        };
        if let Some(region) = self.regions.get(&key) {
            return Ok(*region);
        }
        let raster = rasterize_icon(icon, width, height)?;
        let Some(region) = self.allocator.allocate(width, height) else {
            return Err(UiRenderError::IconAtlasFull {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
            });
        };
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.mask_atlas,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: region.x,
                    y: region.y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            &raster.mask,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.color_atlas,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: region.x,
                    y: region.y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            &raster.color,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.regions.insert(key, region);
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

struct PreparedIconInstances {
    instances: Vec<IconInstance>,
    primitive_ranges: Vec<Range<u32>>,
}

impl AtlasRegion {
    fn uv_bounds(self) -> [f32; 4] {
        let atlas_size = ATLAS_SIZE as f32;
        [
            self.x as f32 / atlas_size,
            self.y as f32 / atlas_size,
            self.width as f32 / atlas_size,
            self.height as f32 / atlas_size,
        ]
    }
}

fn create_instance_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ash-ui symbolic icon instances"),
        size: (capacity * mem::size_of::<IconInstance>()) as wgpu::BufferAddress,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

#[cfg(test)]
#[path = "icon_tests.rs"]
mod tests;
