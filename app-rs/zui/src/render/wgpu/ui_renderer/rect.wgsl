struct RectInstance {
    @location(0) bounds: vec4<f32>,
    @location(1) fill: vec4<f32>,
    @location(2) border_color: vec4<f32>,
    @location(3) border_widths: vec4<f32>,
    @location(4) corner_radii: vec4<f32>,
    @location(5) clip_bounds: vec4<f32>,
    @location(6) viewport: vec4<f32>,
    @location(7) effect: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) screen_position: vec2<f32>,
    @location(1) @interpolate(flat) bounds: vec4<f32>,
    @location(2) @interpolate(flat) fill: vec4<f32>,
    @location(3) @interpolate(flat) border_color: vec4<f32>,
    @location(4) @interpolate(flat) border_widths: vec4<f32>,
    @location(5) @interpolate(flat) corner_radii: vec4<f32>,
    @location(6) @interpolate(flat) clip_bounds: vec4<f32>,
    @location(7) @interpolate(flat) effect: vec4<f32>,
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
fn vs_main(instance: RectInstance, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let unit_position = QUAD_VERTICES[vertex_index];
    let screen_position = instance.bounds.xy + unit_position * instance.bounds.zw;
    let ndc = screen_position / instance.viewport.xy * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0);
    var output: VertexOutput;
    output.position = vec4<f32>(ndc, 0.0, 1.0);
    output.screen_position = screen_position;
    output.bounds = instance.bounds;
    output.fill = instance.fill;
    output.border_color = instance.border_color;
    output.border_widths = instance.border_widths;
    output.corner_radii = instance.corner_radii;
    output.clip_bounds = instance.clip_bounds;
    output.effect = instance.effect;
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

fn coverage(distance: f32) -> f32 {
    return 1.0 - smoothstep(-0.5, 0.5, distance);
}

fn erf_approximation(value: f32) -> f32 {
    let coefficient = 0.147;
    let magnitude = abs(value);
    let squared = magnitude * magnitude;
    let exponent = -squared * (4.0 / 3.14159265 + coefficient * squared)
        / (1.0 + coefficient * squared);
    let result = sqrt(max(1.0 - exp(exponent), 0.0));
    return select(-result, result, value >= 0.0);
}

fn gaussian_shadow_coverage(distance: f32, standard_deviation: f32) -> f32 {
    let normalized_distance = distance / (max(standard_deviation, 0.16666667) * 1.41421356);
    return 0.5 * (1.0 - erf_approximation(normalized_distance));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let clip_max = input.clip_bounds.xy + input.clip_bounds.zw;
    if input.screen_position.x < input.clip_bounds.x
        || input.screen_position.y < input.clip_bounds.y
        || input.screen_position.x >= clip_max.x
        || input.screen_position.y >= clip_max.y {
        discard;
    }

    if input.effect.z > 0.5 {
        let shadow_extent = input.effect.y;
        let shape_origin = input.bounds.xy + vec2<f32>(shadow_extent);
        let shape_size = max(
            input.bounds.zw - vec2<f32>(shadow_extent * 2.0),
            vec2<f32>(0.0),
        );
        let shadow_distance = rounded_rect_distance(
            input.screen_position,
            shape_origin,
            shape_size,
            input.corner_radii,
        );
        let standard_deviation = input.effect.x;
        let shadow_coverage = select(
            coverage(shadow_distance),
            gaussian_shadow_coverage(shadow_distance, standard_deviation),
            standard_deviation > 0.0,
        );
        let shadow_alpha = input.fill.a * shadow_coverage;
        if shadow_alpha <= 0.001 {
            discard;
        }
        return vec4<f32>(input.fill.rgb, shadow_alpha);
    }

    let outer_distance = rounded_rect_distance(
        input.screen_position,
        input.bounds.xy,
        input.bounds.zw,
        input.corner_radii,
    );
    let outer_coverage = coverage(outer_distance);

    let inner_origin = input.bounds.xy + vec2<f32>(input.border_widths.w, input.border_widths.x);
    let inner_size = max(
        input.bounds.zw
            - vec2<f32>(
                input.border_widths.w + input.border_widths.y,
                input.border_widths.x + input.border_widths.z,
            ),
        vec2<f32>(0.0),
    );
    let inner_radii = max(
        input.corner_radii
            - vec4<f32>(
                max(input.border_widths.w, input.border_widths.x),
                max(input.border_widths.y, input.border_widths.x),
                max(input.border_widths.y, input.border_widths.z),
                max(input.border_widths.w, input.border_widths.z),
            ),
        vec4<f32>(0.0),
    );
    var inner_coverage = 0.0;
    if inner_size.x > 0.0 && inner_size.y > 0.0 {
        inner_coverage = coverage(rounded_rect_distance(
            input.screen_position,
            inner_origin,
            inner_size,
            inner_radii,
        ));
    }

    let fill_alpha = input.fill.a * inner_coverage;
    let border_alpha = input.border_color.a * outer_coverage * (1.0 - inner_coverage);
    let output_alpha = border_alpha + fill_alpha * (1.0 - border_alpha);
    if output_alpha <= 0.0 {
        discard;
    }
    let output_rgb = (
        input.border_color.rgb * border_alpha
            + input.fill.rgb * fill_alpha * (1.0 - border_alpha)
    ) / output_alpha;
    return vec4<f32>(output_rgb, output_alpha);
}
