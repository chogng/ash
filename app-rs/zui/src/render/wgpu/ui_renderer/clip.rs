use std::mem;
use std::ops::Range;

use bytemuck::{Pod, Zeroable};

use crate::ui::foundation::Rect;
use crate::ui::presentation::UiScene;

use super::rect::scaled_rect;
use super::{UiRenderError, UiViewport};

pub(crate) const CLIP_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24PlusStencil8;

pub(super) enum PreparedBatch {
    ClipStart {
        index: usize,
        depth: u32,
    },
    ClipEnd {
        index: usize,
        depth: u32,
    },
    Rects {
        range: Range<usize>,
        clip_depth: u32,
    },
    Icons {
        range: Range<usize>,
        clip_depth: u32,
    },
    Images {
        range: Range<usize>,
        clip_depth: u32,
    },
    Text {
        index: usize,
        clip_depth: u32,
    },
}

pub(super) fn content_depth_stencil() -> wgpu::DepthStencilState {
    let face = wgpu::StencilFaceState {
        compare: wgpu::CompareFunction::Equal,
        fail_op: wgpu::StencilOperation::Keep,
        depth_fail_op: wgpu::StencilOperation::Keep,
        pass_op: wgpu::StencilOperation::Keep,
    };
    wgpu::DepthStencilState {
        format: CLIP_FORMAT,
        depth_write_enabled: Some(false),
        depth_compare: Some(wgpu::CompareFunction::Always),
        stencil: wgpu::StencilState {
            front: face,
            back: face,
            read_mask: u8::MAX.into(),
            write_mask: 0,
        },
        bias: wgpu::DepthBiasState::default(),
    }
}

const INSTANCE_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x4
];

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ClipInstance {
    bounds: [f32; 4],
    corner_radii: [f32; 4],
    clip_bounds: [f32; 4],
    viewport: [f32; 4],
}

pub(super) struct ClipRenderer {
    start_pipeline: wgpu::RenderPipeline,
    end_pipeline: wgpu::RenderPipeline,
    instance_buffer: wgpu::Buffer,
    instance_capacity: usize,
    instance_count: usize,
}

impl ClipRenderer {
    pub(super) fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ash-ui rounded clip shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("clip.wgsl").into()),
        });
        let start_pipeline = create_pipeline(
            device,
            surface_format,
            &shader,
            "ash-ui rounded clip start pipeline",
            wgpu::StencilOperation::IncrementClamp,
        );
        let end_pipeline = create_pipeline(
            device,
            surface_format,
            &shader,
            "ash-ui rounded clip end pipeline",
            wgpu::StencilOperation::DecrementClamp,
        );
        Self {
            start_pipeline,
            end_pipeline,
            instance_buffer: create_instance_buffer(device, 1),
            instance_capacity: 1,
            instance_count: 0,
        }
    }

    pub(super) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &UiScene,
        target: UiViewport,
    ) -> Result<(), UiRenderError> {
        let instances = prepare_instances(scene, target)?;
        self.instance_count = instances.len();
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

    pub(super) fn render_start<'pass>(
        &'pass self,
        pass: &mut wgpu::RenderPass<'pass>,
        index: usize,
        depth: u32,
    ) {
        self.render(pass, index, depth, &self.start_pipeline);
    }

    pub(super) fn render_end<'pass>(
        &'pass self,
        pass: &mut wgpu::RenderPass<'pass>,
        index: usize,
        depth: u32,
    ) {
        self.render(pass, index, depth, &self.end_pipeline);
    }

    fn render<'pass>(
        &'pass self,
        pass: &mut wgpu::RenderPass<'pass>,
        index: usize,
        depth: u32,
        pipeline: &'pass wgpu::RenderPipeline,
    ) {
        if index >= self.instance_count {
            return;
        }
        pass.set_pipeline(pipeline);
        pass.set_stencil_reference(depth);
        pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
        pass.draw(0..6, index as u32..index as u32 + 1);
    }
}

fn prepare_instances(
    scene: &UiScene,
    target: UiViewport,
) -> Result<Vec<ClipInstance>, UiRenderError> {
    let scale_factor = target.scale_factor();
    let logical_viewport = Rect::from_xywh(
        0.0,
        0.0,
        target.width() as f32 / scale_factor,
        target.height() as f32 / scale_factor,
    );
    let viewport = [target.width() as f32, target.height() as f32, 0.0, 0.0];
    scene
        .clips()
        .iter()
        .copied()
        .enumerate()
        .map(|(index, clip)| {
            validate_clip(index, clip)?;
            let clip_bounds = clip
                .clip_bounds()
                .map(|bounds| bounds.intersection(logical_viewport))
                .unwrap_or(logical_viewport);
            let radii = clip.corner_radii();
            Ok(ClipInstance {
                bounds: scaled_rect(clip.bounds(), scale_factor),
                corner_radii: [
                    radii.top_left * scale_factor,
                    radii.top_right * scale_factor,
                    radii.bottom_right * scale_factor,
                    radii.bottom_left * scale_factor,
                ],
                clip_bounds: scaled_rect(clip_bounds, scale_factor),
                viewport,
            })
        })
        .collect()
}

fn create_pipeline(
    device: &wgpu::Device,
    surface_format: wgpu::TextureFormat,
    shader: &wgpu::ShaderModule,
    label: &'static str,
    pass_op: wgpu::StencilOperation,
) -> wgpu::RenderPipeline {
    let face = wgpu::StencilFaceState {
        compare: wgpu::CompareFunction::Equal,
        fail_op: wgpu::StencilOperation::Keep,
        depth_fail_op: wgpu::StencilOperation::Keep,
        pass_op,
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: None,
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: mem::size_of::<ClipInstance>() as wgpu::BufferAddress,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &INSTANCE_ATTRIBUTES,
            })],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: surface_format,
                blend: None,
                write_mask: wgpu::ColorWrites::empty(),
            })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: CLIP_FORMAT,
            depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: wgpu::StencilState {
                front: face,
                back: face,
                read_mask: u8::MAX.into(),
                write_mask: u8::MAX.into(),
            },
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn create_instance_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ash-ui rounded clip instances"),
        size: (capacity * mem::size_of::<ClipInstance>()) as wgpu::BufferAddress,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn validate_clip(
    index: usize,
    clip: crate::ui::presentation::ClipRect,
) -> Result<(), UiRenderError> {
    let bounds = clip.bounds();
    let radii = clip.requested_corner_radii();
    let values = [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
        radii.top_left,
        radii.top_right,
        radii.bottom_right,
        radii.bottom_left,
    ];
    if values.into_iter().any(|value| !value.is_finite()) {
        return Err(UiRenderError::InvalidClip {
            index,
            reason: "coordinates and corner radii must be finite",
        });
    }
    if bounds.size.width < 0.0
        || bounds.size.height < 0.0
        || [
            radii.top_left,
            radii.top_right,
            radii.bottom_right,
            radii.bottom_left,
        ]
        .into_iter()
        .any(|radius| radius < 0.0)
    {
        return Err(UiRenderError::InvalidClip {
            index,
            reason: "bounds and corner radii must not be negative",
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "clip_tests.rs"]
mod tests;
