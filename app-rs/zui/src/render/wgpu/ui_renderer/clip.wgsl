struct ClipInstance {
    @location(0) bounds: vec4<f32>,
    @location(1) corner_radii: vec4<f32>,
    @location(2) clip_bounds: vec4<f32>,
    @location(3) viewport: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) screen_position: vec2<f32>,
    @location(1) @interpolate(flat) bounds: vec4<f32>,
    @location(2) @interpolate(flat) corner_radii: vec4<f32>,
    @location(3) @interpolate(flat) clip_bounds: vec4<f32>,
};

const QUAD_VERTICES = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
);

@vertex
fn vs_main(instance: ClipInstance, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let unit_position = QUAD_VERTICES[vertex_index];
    let screen_position = instance.bounds.xy + unit_position * instance.bounds.zw;
    let ndc = screen_position / instance.viewport.xy * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0);
    var output: VertexOutput;
    output.position = vec4<f32>(ndc, 0.0, 1.0);
    output.screen_position = screen_position;
    output.bounds = instance.bounds;
    output.corner_radii = instance.corner_radii;
    output.clip_bounds = instance.clip_bounds;
    return output;
}

fn selected_radius(radii: vec4<f32>, position: vec2<f32>, center: vec2<f32>) -> f32 {
    if position.y < center.y {
        return select(radii.x, radii.y, position.x >= center.x);
    }
    return select(radii.w, radii.z, position.x >= center.x);
}

fn rounded_rect_distance(
    position: vec2<f32>,
    origin: vec2<f32>,
    size: vec2<f32>,
    radii: vec4<f32>,
) -> f32 {
    let half_size = max(size * 0.5, vec2<f32>(0.0));
    let center = origin + half_size;
    let radius = selected_radius(radii, position, center);
    let offset = abs(position - center) - half_size + vec2<f32>(radius);
    return length(max(offset, vec2<f32>(0.0))) + min(max(offset.x, offset.y), 0.0) - radius;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let clip_max = input.clip_bounds.xy + input.clip_bounds.zw;
    if input.screen_position.x < input.clip_bounds.x
        || input.screen_position.y < input.clip_bounds.y
        || input.screen_position.x >= clip_max.x
        || input.screen_position.y >= clip_max.y
        || rounded_rect_distance(
            input.screen_position,
            input.bounds.xy,
            input.bounds.zw,
            input.corner_radii,
        ) > 0.0 {
        discard;
    }
    return vec4<f32>(0.0);
}
