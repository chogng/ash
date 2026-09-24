use std::ops::Range;

use cosmic_text::{Attrs, Buffer, Metrics, Shaping, Wrap};
use unicode_segmentation::UnicodeSegmentation;

use crate::ui::foundation::Point;
use crate::ui::foundation::Rect;
use crate::ui::foundation::Size;
use crate::ui::text::TextSpan;
use crate::ui::text::TextStyle;
use crate::ui::text::mapping::shaping_family;
use crate::ui::text::mapping::shaping_style;
use crate::ui::text::mapping::shaping_weight;
use crate::ui::text::new_font_system;

/// Horizontal constraint used while measuring shaped text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TextLayoutWidth {
    Unbounded,
    Wrap(f32),
}

/// Shaped logical geometry for a rich-text paragraph.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextLayout {
    size: Size,
    span_fragments: Vec<Vec<Rect>>,
    clusters: Vec<TextCluster>,
    text_len: usize,
}

impl TextLayout {
    pub const fn size(&self) -> Size {
        self.size
    }

    /// Returns visual-line fragments for the source span at `span_index`.
    ///
    /// Bounds are relative to the paragraph origin and follow the same shaping result used to
    /// measure the paragraph. A span can produce multiple fragments after wrapping or BiDi layout.
    pub fn span_fragments(&self, span_index: usize) -> &[Rect] {
        self.span_fragments
            .get(span_index)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// Returns the nearest UTF-8 byte boundary for a point relative to the paragraph origin.
    pub fn hit_test(&self, point: Point) -> Option<usize> {
        let first = self.clusters.first()?;
        let mut same_line = self
            .clusters
            .iter()
            .filter(|cluster| {
                point.y >= cluster.bounds.origin.y && point.y < cluster.bounds.bottom()
            })
            .collect::<Vec<_>>();
        if same_line.is_empty() {
            let target_y = point.y.clamp(first.bounds.origin.y, self.size.height);
            let nearest = self.clusters.iter().min_by(|left, right| {
                vertical_distance(left.bounds, target_y)
                    .total_cmp(&vertical_distance(right.bounds, target_y))
            })?;
            same_line = self
                .clusters
                .iter()
                .filter(|cluster| cluster.bounds.origin.y == nearest.bounds.origin.y)
                .collect();
        }
        same_line.sort_by(|left, right| left.bounds.origin.x.total_cmp(&right.bounds.origin.x));
        let first = same_line.first()?;
        if point.x <= first.bounds.origin.x {
            return Some(first.leading_offset());
        }
        for cluster in &same_line {
            if point.x <= cluster.bounds.right() {
                return Some(
                    if point.x < cluster.bounds.origin.x + cluster.bounds.size.width * 0.5 {
                        cluster.leading_offset()
                    } else {
                        cluster.trailing_offset()
                    },
                );
            }
        }
        same_line.last().map(|cluster| cluster.trailing_offset())
    }

    /// Returns wrapped/BiDi visual fragments for a UTF-8 byte range.
    pub fn range_fragments(&self, range: Range<usize>) -> Vec<Rect> {
        let start = range.start.min(self.text_len);
        let end = range.end.min(self.text_len);
        if start >= end {
            return Vec::new();
        }
        let mut fragments = self
            .clusters
            .iter()
            .filter(|cluster| cluster.range.end > start && cluster.range.start < end)
            .map(|cluster| cluster.bounds)
            .collect::<Vec<_>>();
        fragments.sort_by(|left, right| {
            left.origin
                .y
                .total_cmp(&right.origin.y)
                .then(left.origin.x.total_cmp(&right.origin.x))
        });
        merge_fragments(fragments)
    }
}

#[derive(Clone, Debug, PartialEq)]
struct TextCluster {
    range: Range<usize>,
    bounds: Rect,
    rtl: bool,
}

impl TextCluster {
    fn leading_offset(&self) -> usize {
        if self.rtl {
            self.range.end
        } else {
            self.range.start
        }
    }

    fn trailing_offset(&self) -> usize {
        if self.rtl {
            self.range.start
        } else {
            self.range.end
        }
    }
}

/// Reusable shaping state for measuring plain or rich text with the UI renderer's font policy.
///
/// Hosts should retain one engine for repeated layout. The engine returns logical-pixel geometry
/// and does not own scene state, GPU resources, component identity, or input routing.
pub struct TextLayoutEngine {
    font_system: cosmic_text::FontSystem,
}

impl TextLayoutEngine {
    pub fn new() -> Self {
        Self {
            font_system: new_font_system(),
        }
    }

    pub fn measure_text(&mut self, text: &str, style: &TextStyle, width: TextLayoutWidth) -> Size {
        self.measure(text, &[], style, width)
    }

    pub fn measure_spans(
        &mut self,
        spans: &[TextSpan],
        style: &TextStyle,
        width: TextLayoutWidth,
    ) -> Size {
        self.layout_spans(spans, style, width).size()
    }

    /// Shapes rich text and returns paragraph extent plus per-span visual fragments.
    pub fn layout_spans(
        &mut self,
        spans: &[TextSpan],
        style: &TextStyle,
        width: TextLayoutWidth,
    ) -> TextLayout {
        let text = spans.iter().map(TextSpan::text).collect::<String>();
        self.layout(&text, spans, style, width)
    }

    fn measure(
        &mut self,
        text: &str,
        spans: &[TextSpan],
        style: &TextStyle,
        width: TextLayoutWidth,
    ) -> Size {
        self.layout(text, spans, style, width).size()
    }

    fn layout(
        &mut self,
        text: &str,
        spans: &[TextSpan],
        style: &TextStyle,
        width: TextLayoutWidth,
    ) -> TextLayout {
        if text.is_empty() {
            return TextLayout {
                size: Size::new(0.0, 0.0),
                span_fragments: vec![Vec::new(); spans.len()],
                clusters: Vec::new(),
                text_len: 0,
            };
        }
        let metrics = Metrics::new(style.font_size(), style.line_height());
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        match width {
            TextLayoutWidth::Unbounded => {
                buffer.set_wrap(Wrap::None);
                buffer.set_size(None, None);
            }
            TextLayoutWidth::Wrap(width) => {
                buffer.set_wrap(Wrap::WordOrGlyph);
                buffer.set_size(Some(width.max(0.0)), None);
            }
        }
        let attrs = attrs_for_style(style);
        if spans.is_empty() {
            buffer.set_text(text, &attrs, Shaping::Advanced, None);
        } else {
            buffer.set_rich_text(
                spans.iter().enumerate().map(|(index, span)| {
                    (
                        span.text(),
                        attrs_for_style(span.style()).metadata(index + 1),
                    )
                }),
                &attrs,
                Shaping::Advanced,
                None,
            );
        }
        buffer.shape_until_scroll(&mut self.font_system, false);
        let mut measured = Size::new(0.0, 0.0);
        let mut span_fragments = vec![Vec::new(); spans.len()];
        let line_offsets = line_offsets(text);
        let mut clusters = Vec::new();
        for run in buffer.layout_runs() {
            measured.width = measured.width.max(run.line_w);
            measured.height = measured.height.max(run.line_top + run.line_height);
            let mut glyphs = run
                .glyphs
                .iter()
                .filter_map(|glyph| {
                    glyph
                        .metadata
                        .checked_sub(1)
                        .filter(|index| *index < spans.len())
                        .map(|index| (index, glyph.x, glyph.x + glyph.w))
                })
                .collect::<Vec<_>>();
            glyphs.sort_by(|left, right| left.1.total_cmp(&right.1));
            let mut fragment: Option<(usize, f32, f32)> = None;
            for (index, left, right) in glyphs {
                match fragment {
                    Some((current, start, end))
                        if current == index && left <= end + f32::EPSILON =>
                    {
                        fragment = Some((current, start, end.max(right)));
                    }
                    Some(previous) => {
                        push_fragment(&mut span_fragments, previous, run.line_top, run.line_height);
                        fragment = Some((index, left, right));
                    }
                    None => fragment = Some((index, left, right)),
                }
            }
            if let Some(fragment) = fragment {
                push_fragment(&mut span_fragments, fragment, run.line_top, run.line_height);
            }
            let line_offset = line_offsets.get(run.line_i).copied().unwrap_or_default();
            for glyph in run.glyphs {
                let cluster = &run.text[glyph.start..glyph.end];
                let graphemes = cluster.grapheme_indices(true).collect::<Vec<_>>();
                let width = glyph.w / graphemes.len().max(1) as f32;
                for (visual_index, (offset, grapheme)) in graphemes.iter().enumerate() {
                    let rtl = glyph.level.is_rtl();
                    let x_index = if rtl {
                        graphemes.len() - visual_index - 1
                    } else {
                        visual_index
                    };
                    clusters.push(TextCluster {
                        range: (line_offset + glyph.start + *offset)
                            ..(line_offset + glyph.start + *offset + grapheme.len()),
                        bounds: Rect::from_xywh(
                            glyph.x + x_index as f32 * width,
                            run.line_top,
                            width,
                            run.line_height,
                        ),
                        rtl,
                    });
                }
            }
        }
        TextLayout {
            size: measured,
            span_fragments,
            clusters,
            text_len: text.len(),
        }
    }
}

fn line_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            offsets.push(index + 1);
        }
    }
    offsets
}

fn vertical_distance(bounds: Rect, y: f32) -> f32 {
    if y < bounds.origin.y {
        bounds.origin.y - y
    } else if y > bounds.bottom() {
        y - bounds.bottom()
    } else {
        0.0
    }
}

fn merge_fragments(fragments: Vec<Rect>) -> Vec<Rect> {
    let mut merged: Vec<Rect> = Vec::new();
    for fragment in fragments {
        if let Some(last) = merged.last_mut()
            && (last.origin.y - fragment.origin.y).abs() <= f32::EPSILON
            && fragment.origin.x <= last.right() + f32::EPSILON
        {
            last.size.width = last.right().max(fragment.right()) - last.origin.x;
            continue;
        }
        merged.push(fragment);
    }
    merged
}

impl Default for TextLayoutEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn attrs_for_style(style: &TextStyle) -> Attrs<'_> {
    Attrs::new()
        .family(shaping_family(style.family()))
        .weight(shaping_weight(style.weight()))
        .style(shaping_style(style.style()))
        .metrics(Metrics::new(style.font_size(), style.line_height()))
}

fn push_fragment(
    fragments: &mut [Vec<Rect>],
    (index, left, right): (usize, f32, f32),
    top: f32,
    height: f32,
) {
    fragments[index].push(Rect::from_xywh(left, top, (right - left).max(0.0), height));
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
