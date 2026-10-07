export const enum RectangleRendererBindingId {
	Shapes,
	LayoutInfoUniform,
	ScrollOffset,
}

export const rectangleRendererWgsl = /* wgsl */ `
struct Vertex { @location(0) position: vec2f, };
struct LayoutInfo { canvasDims: vec2f, viewportOffset: vec2f, viewportDims: vec2f, };
struct ScrollOffset { offset: vec2f, };
struct Shape { position: vec2f, size: vec2f, color: vec4f, };
struct VSOutput { @builtin(position) position: vec4f, @location(1) color: vec4f, };

@group(0) @binding(${RectangleRendererBindingId.LayoutInfoUniform}) var<uniform> layoutInfo: LayoutInfo;
@group(0) @binding(${RectangleRendererBindingId.Shapes}) var<storage, read> shapes: array<Shape>;
@group(0) @binding(${RectangleRendererBindingId.ScrollOffset}) var<uniform> scrollOffset: ScrollOffset;

@vertex fn vs(vertex: Vertex, @builtin(instance_index) instanceIndex: u32) -> VSOutput {
  let shape = shapes[instanceIndex];
  var output: VSOutput;
  output.position = vec4f(vec2f(-1, 1) + vec2f(2, -2) / layoutInfo.canvasDims * (layoutInfo.viewportOffset - scrollOffset.offset + shape.position + vertex.position * shape.size), 0, 1);
  output.color = shape.color;
  return output;
}

@fragment fn fs(input: VSOutput) -> @location(0) vec4f { return input.color; }
`;
