import { TextureAtlas } from '../atlas/textureAtlas.js';
import { TextureAtlasPage } from '../atlas/textureAtlasPage.js';
import { BindingId } from '../gpu.js';

export const fullFileRenderStrategyWgsl = /* wgsl */ `
struct GlyphInfo {
  atlasPosition: vec2f,
  size: vec2f,
  origin: vec2f,
}

struct Cell {
  position: vec2f,
  unused: vec2f,
  glyphIndex: f32,
  pageIndex: f32,
}

struct LayoutInfo {
  canvasSize: vec2f,
  viewportOffset: vec2f,
  viewportSize: vec2f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) textureCoordinate: vec2f,
  @location(1) pageIndex: f32,
}

@group(0) @binding(${BindingId.GlyphInfo}) var<storage, read> glyphs: array<array<GlyphInfo, ${TextureAtlasPage.maximumGlyphCount}>, ${TextureAtlas.maximumPageCount}>;
@group(0) @binding(${BindingId.Cells}) var<storage, read> cells: array<Cell>;
@group(0) @binding(${BindingId.TextureSampler}) var atlasSampler: sampler;
@group(0) @binding(${BindingId.Texture}) var atlasTexture: texture_2d_array<f32>;
@group(0) @binding(${BindingId.LayoutInfoUniform}) var<uniform> layoutInfo: LayoutInfo;
@group(0) @binding(${BindingId.AtlasDimensionsUniform}) var<uniform> atlasSize: vec2f;
@group(0) @binding(${BindingId.ScrollOffset}) var<uniform> scrollOffset: vec2f;

@vertex
fn vs(@location(0) corner: vec2f, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let cell = cells[instanceIndex];
  let glyph = glyphs[u32(cell.pageIndex)][u32(cell.glyphIndex)];
  let pixel = layoutInfo.viewportOffset + cell.position + glyph.origin + corner * glyph.size - scrollOffset;
  let normalized = pixel / layoutInfo.canvasSize;
  var output: VertexOutput;
  output.position = vec4f(normalized.x * 2.0 - 1.0, 1.0 - normalized.y * 2.0, 0.0, 1.0);
  output.textureCoordinate = (glyph.atlasPosition + corner * glyph.size) / atlasSize;
  output.pageIndex = cell.pageIndex;
  return output;
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(atlasTexture, atlasSampler, input.textureCoordinate, i32(input.pageIndex));
}
`;
