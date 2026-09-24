use std::{mem, ops::Range};

use bytemuck::{Pod, Zeroable};

use crate::ui::foundation::Color;
use crate::ui::foundation::CornerRadii;
use crate::ui::foundation::Rect;
use crate::ui::presentation::BoxShadow;
use crate::ui::presentation::PaintRect;
use crate::ui::presentation::UiScene;

use super::{UiRenderError, UiViewport};

// Treat the public blur radius as two standard deviations and retain a three-deviation tail.
const SHADOW_STANDARD_DEVIATION_SCALE: f32 = 0.5;
const SHADOW_VISIBLE_STANDARD_DEVIATIONS: f32 = 3.0;

const INSTANCE_ATTRIBUTES: [wgpu::VertexAttribute; 8] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x4,
    4 => Float32x4,
    5 => Float32x4,
    6 => Float32x4,
    7 => Float32x4
];

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct RectInstance {
    bounds: [f32; 4],
    fill: [f32; 4],
    border_color: [f32; 4],
    border_widths: [f32; 4],
    corner_radii: [f32; 4],
    clip_bounds: [f32; 4],
    viewport: [f32; 4],
    effect: [f32; 4],
}

pub(crate) struct RectRenderer {
    pipeline: wgpu::RenderPipeline,
    instance_buffer: wgpu::Buffer,
    instance_capacity: usize,
    instances: Vec<RectInstance>,
    primitive_ranges: Vec<Range<u32>>,
    source_rects: Vec<PaintRect>,
    target: Option<UiViewport>,
}

impl RectRenderer {
    pub(crate) fn new(
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        depth_stencil: wgpu::DepthStencilState,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ash-ui rect shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("rect.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ash-ui rect pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: mem::size_of::<RectInstance>() as wgpu::BufferAddress,
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
        let instance_buffer = create_instance_buffer(device, instance_capacity);
        Self {
            pipeline,
            instance_buffer,
            instance_capacity,
            instances: Vec::new(),
            primitive_ranges: Vec::new(),
            source_rects: Vec::new(),
            target: None,
        }
    }

    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &UiScene,
        target: UiViewport,
    ) -> Result<(), UiRenderError> {
        if self.target == Some(target) && self.source_rects.len() == scene.rects().len() {
            let mut changed = Vec::new();
            let mut can_update_in_place = true;
            for (index, rect) in scene.rects().iter().copied().enumerate() {
                if self.source_rects[index] == rect {
                    continue;
                }
                let instances = prepare_rect_instances(index, rect, target)?;
                let range = &self.primitive_ranges[index];
                if instances.len() != range.len() {
                    can_update_in_place = false;
                    break;
                }
                changed.push((index, instances));
            }
            if can_update_in_place {
                for (index, instances) in changed {
                    let range = self.primitive_ranges[index].clone();
                    self.instances[range.start as usize..range.end as usize]
                        .copy_from_slice(&instances);
                    write_instances(queue, &self.instance_buffer, range, &instances);
                    self.source_rects[index] = scene.rects()[index];
                }
                return Ok(());
            }
        }

        let prepared = prepare_instances(scene, target)?;
        let instances = prepared.instances;
        self.instances = instances.clone();
        self.primitive_ranges = prepared.primitive_ranges;
        self.source_rects = scene.rects().to_vec();
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

    pub(crate) fn render_range<'pass>(
        &'pass self,
        pass: &mut wgpu::RenderPass<'pass>,
        primitive_range: Range<usize>,
    ) {
        let Some(range) = instance_range(&self.primitive_ranges, primitive_range) else {
            return;
        };
        if range.is_empty() {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
        pass.draw(0..6, range.clone());
    }
}

fn create_instance_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ash-ui rect instances"),
        size: (capacity * mem::size_of::<RectInstance>()) as wgpu::BufferAddress,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn prepare_instances(
    scene: &UiScene,
    target: UiViewport,
) -> Result<PreparedRectInstances, UiRenderError> {
    let mut instances = Vec::with_capacity(scene.rects().len() * 2);
    let mut primitive_ranges = Vec::with_capacity(scene.rects().len());
    for (index, rect) in scene.rects().iter().copied().enumerate() {
        let start = instances.len() as u32;
        instances.extend(prepare_rect_instances(index, rect, target)?);
        primitive_ranges.push(start..instances.len() as u32);
    }
    Ok(PreparedRectInstances {
        instances,
        primitive_ranges,
    })
}

fn prepare_rect_instances(
    index: usize,
    rect: PaintRect,
    target: UiViewport,
) -> Result<Vec<RectInstance>, UiRenderError> {
    let scale_factor = target.scale_factor();
    let viewport = [target.width() as f32, target.height() as f32, 0.0, 0.0];
    let logical_viewport = Rect::from_xywh(
        0.0,
        0.0,
        target.width() as f32 / scale_factor,
        target.height() as f32 / scale_factor,
    );
    validate_paint_rect(index, rect)?;
    let clip_bounds = rect
        .clip_bounds()
        .map(|clip| clip.intersection(logical_viewport))
        .unwrap_or(logical_viewport);
    if rect.bounds().is_empty() || clip_bounds.is_empty() {
        return Ok(Vec::new());
    }
    let bounds = rect.bounds();
    let border = rect.border();
    let widths = border.widths();
    let radii = rect.corner_radii();
    let mut instances = Vec::with_capacity(if rect.shadow().is_some() { 2 } else { 1 });
    if let Some(shadow) = rect.shadow() {
        let blur_radius = shadow.blur_radius();
        let shadow_shape = shadow_shape_bounds(bounds, shadow);
        if !shadow_shape.is_empty() {
            let standard_deviation = shadow_standard_deviation(blur_radius);
            let shadow_extent = shadow_blur_extent(standard_deviation);
            let shadow_bounds = expanded_rect(shadow_shape, shadow_extent);
            let spread_radius = shadow.spread_radius();
            let shadow_radii = CornerRadii::new(
                (radii.top_left + spread_radius).max(0.0),
                (radii.top_right + spread_radius).max(0.0),
                (radii.bottom_right + spread_radius).max(0.0),
                (radii.bottom_left + spread_radius).max(0.0),
            )
            .clamped_for(shadow_shape.size);
            instances.push(RectInstance {
                bounds: scaled_rect(shadow_bounds, scale_factor),
                fill: linear_color(shadow.color()),
                border_color: linear_color(Color::TRANSPARENT),
                border_widths: [0.0; 4],
                corner_radii: [
                    shadow_radii.top_left * scale_factor,
                    shadow_radii.top_right * scale_factor,
                    shadow_radii.bottom_right * scale_factor,
                    shadow_radii.bottom_left * scale_factor,
                ],
                clip_bounds: scaled_rect(clip_bounds, scale_factor),
                viewport,
                effect: [
                    standard_deviation * scale_factor,
                    shadow_extent * scale_factor,
                    1.0,
                    0.0,
                ],
            });
        }
    }
    instances.push(RectInstance {
        bounds: scaled_rect(bounds, scale_factor),
        fill: linear_color(rect.fill()),
        border_color: linear_color(border.color()),
        border_widths: [
            widths.top * scale_factor,
            widths.right * scale_factor,
            widths.bottom * scale_factor,
            widths.left * scale_factor,
        ],
        corner_radii: [
            radii.top_left * scale_factor,
            radii.top_right * scale_factor,
            radii.bottom_right * scale_factor,
            radii.bottom_left * scale_factor,
        ],
        clip_bounds: scaled_rect(clip_bounds, scale_factor),
        viewport,
        effect: [0.0; 4],
    });
    Ok(instances)
}

fn write_instances(
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    range: Range<u32>,
    instances: &[RectInstance],
) {
    let offset = u64::from(range.start) * mem::size_of::<RectInstance>() as u64;
    queue.write_buffer(buffer, offset, bytemuck::cast_slice(instances));
}

struct PreparedRectInstances {
    instances: Vec<RectInstance>,
    primitive_ranges: Vec<Range<u32>>,
}

pub(super) fn instance_range(
    primitive_ranges: &[Range<u32>],
    primitive_range: Range<usize>,
) -> Option<Range<u32>> {
    if primitive_range.is_empty() {
        return None;
    }
    let start = primitive_ranges.get(primitive_range.start)?.start;
    let end = primitive_ranges
        .get(primitive_range.end.checked_sub(1)?)?
        .end;
    Some(start..end)
}

fn validate_paint_rect(index: usize, rect: PaintRect) -> Result<(), UiRenderError> {
    let bounds = rect.bounds();
    let widths = rect.border().widths();
    let requested_radii = rect.requested_corner_radii();
    let values = [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
        widths.top,
        widths.right,
        widths.bottom,
        widths.left,
        requested_radii.top_left,
        requested_radii.top_right,
        requested_radii.bottom_right,
        requested_radii.bottom_left,
    ];
    if values.into_iter().any(|value| !value.is_finite()) {
        return Err(UiRenderError::InvalidPaintRect {
            index,
            reason: "coordinates and visual metrics must be finite",
        });
    }
    if bounds.size.width < 0.0 || bounds.size.height < 0.0 {
        return Err(UiRenderError::InvalidPaintRect {
            index,
            reason: "bounds must not be negative",
        });
    }
    if [
        widths.top,
        widths.right,
        widths.bottom,
        widths.left,
        requested_radii.top_left,
        requested_radii.top_right,
        requested_radii.bottom_right,
        requested_radii.bottom_left,
    ]
    .into_iter()
    .any(|value| value < 0.0)
    {
        return Err(UiRenderError::InvalidPaintRect {
            index,
            reason: "border widths and corner radii must not be negative",
        });
    }
    if let Some(shadow) = rect.shadow() {
        let offset = shadow.offset();
        let values = [
            offset.x,
            offset.y,
            shadow.blur_radius(),
            shadow.spread_radius(),
        ];
        if values.into_iter().any(|value| !value.is_finite()) {
            return Err(UiRenderError::InvalidPaintRect {
                index,
                reason: "shadow metrics must be finite",
            });
        }
        if shadow.blur_radius() < 0.0 {
            return Err(UiRenderError::InvalidPaintRect {
                index,
                reason: "shadow blur radius must not be negative",
            });
        }
    }
    if let Some(clip) = rect.clip_bounds() {
        let values = [
            clip.origin.x,
            clip.origin.y,
            clip.size.width,
            clip.size.height,
        ];
        if values.into_iter().any(|value| !value.is_finite()) {
            return Err(UiRenderError::InvalidPaintRect {
                index,
                reason: "clip bounds must be finite",
            });
        }
        if clip.size.width < 0.0 || clip.size.height < 0.0 {
            return Err(UiRenderError::InvalidPaintRect {
                index,
                reason: "clip bounds must not be negative",
            });
        }
    }
    Ok(())
}

fn shadow_shape_bounds(bounds: Rect, shadow: BoxShadow) -> Rect {
    let offset = shadow.offset();
    let spread = shadow.spread_radius();
    Rect::from_xywh(
        bounds.origin.x + offset.x - spread,
        bounds.origin.y + offset.y - spread,
        (bounds.size.width + spread * 2.0).max(0.0),
        (bounds.size.height + spread * 2.0).max(0.0),
    )
}

fn shadow_standard_deviation(blur_radius: f32) -> f32 {
    blur_radius * SHADOW_STANDARD_DEVIATION_SCALE
}

fn shadow_blur_extent(standard_deviation: f32) -> f32 {
    standard_deviation * SHADOW_VISIBLE_STANDARD_DEVIATIONS
}

fn expanded_rect(bounds: Rect, extent: f32) -> Rect {
    Rect::from_xywh(
        bounds.origin.x - extent,
        bounds.origin.y - extent,
        bounds.size.width + extent * 2.0,
        bounds.size.height + extent * 2.0,
    )
}

pub(super) fn scaled_rect(rect: Rect, scale_factor: f32) -> [f32; 4] {
    [
        rect.origin.x * scale_factor,
        rect.origin.y * scale_factor,
        rect.size.width * scale_factor,
        rect.size.height * scale_factor,
    ]
}

pub(crate) fn linear_color(color: Color) -> [f32; 4] {
    let [red, green, blue, alpha] = color.components();
    [
        linear_channel(red),
        linear_channel(green),
        linear_channel(blue),
        f32::from(alpha) / 255.0,
    ]
}

fn linear_channel(channel: u8) -> f32 {
    let encoded = f32::from(channel) / 255.0;
    if encoded <= 0.04045 {
        encoded / 12.92
    } else {
        ((encoded + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
#[path = "rect_tests.rs"]
mod tests;
