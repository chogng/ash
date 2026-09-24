use zui::ui::{
    Color, ImageData, Point, Rect, Size, TextLayout, TextLayoutEngine, TextLayoutWidth, TextSpan,
    TextStyle,
};

use crate::document::InlineRun;
use crate::math::MarkdownMathImages;
use crate::{MarkdownImageSource, MarkdownImages, MarkdownStyle};

pub(crate) struct InlineLayout {
    pub(crate) spans: Vec<TextSpan>,
    pub(crate) style: TextStyle,
    pub(crate) size: Size,
    pub(crate) shaped: TextLayout,
    pub(crate) text: String,
    pub(crate) decorations: Vec<InlineDecoration>,
}

pub(crate) enum InlineDecoration {
    Code {
        fragments: Vec<Rect>,
    },
    Link {
        destination: String,
        fragments: Vec<Rect>,
    },
    Strikethrough {
        color: Color,
        fragments: Vec<Rect>,
    },
    Image {
        source: MarkdownImageSource,
        image: ImageData,
        fragments: Vec<Rect>,
    },
    Math {
        source: String,
        image: ImageData,
        fragments: Vec<Rect>,
    },
}

pub(crate) fn layout_inline(
    text: &mut TextLayoutEngine,
    runs: &[InlineRun],
    base: TextStyle,
    width: TextLayoutWidth,
    style: &MarkdownStyle,
    images: &MarkdownImages,
    inline_math: &MarkdownMathImages,
) -> InlineLayout {
    let spans = runs
        .iter()
        .map(|run| {
            let inline = style.inline(&base, &run.format);
            let has_image = run
                .format
                .image
                .as_ref()
                .and_then(|source| images.get(source.destination()))
                .is_some();
            let has_math = run.format.math && inline_math.contains_key(&run.text);
            let inline = if has_image || has_math {
                inline.with_color(Color::TRANSPARENT)
            } else {
                inline
            };
            TextSpan::new(&run.text, inline)
        })
        .collect::<Vec<_>>();
    let shaped = text.layout_spans(&spans, &base, width);
    let decorations = runs
        .iter()
        .enumerate()
        .flat_map(|(index, run)| {
            let fragments = shaped.span_fragments(index).to_vec();
            let mut decorations = Vec::with_capacity(3);
            if run.format.code && !fragments.is_empty() {
                decorations.push(InlineDecoration::Code {
                    fragments: fragments.clone(),
                });
            }
            if let Some(destination) = run.format.link.as_ref()
                && !fragments.is_empty()
            {
                decorations.push(InlineDecoration::Link {
                    destination: destination.clone(),
                    fragments: fragments.clone(),
                });
            }
            if run.format.strikethrough && !fragments.is_empty() {
                decorations.push(InlineDecoration::Strikethrough {
                    color: spans[index].style().color(),
                    fragments: fragments.clone(),
                });
            }
            if let Some(source) = run.format.image.as_ref()
                && let Some(image) = images.get(source.destination())
                && !fragments.is_empty()
            {
                decorations.push(InlineDecoration::Image {
                    source: source.clone(),
                    image: image.clone(),
                    fragments: fragments.clone(),
                });
            }
            if run.format.math
                && let Some(image) = inline_math.get(&run.text)
                && !fragments.is_empty()
            {
                decorations.push(InlineDecoration::Math {
                    source: run.text.clone(),
                    image: image.clone(),
                    fragments,
                });
            }
            decorations
        })
        .collect();
    InlineLayout {
        text: spans.iter().map(TextSpan::text).collect(),
        spans,
        style: base,
        size: shaped.size(),
        shaped,
        decorations,
    }
}

pub(crate) fn offset_rect(rect: Rect, origin: Point) -> Rect {
    Rect::from_xywh(
        rect.origin.x + origin.x,
        rect.origin.y + origin.y,
        rect.size.width,
        rect.size.height,
    )
}
