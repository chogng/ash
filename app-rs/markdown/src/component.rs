use ash_ui_components::{ScrollMetrics, ScrollState};
use zui::ui::{
    ImageData, PaintImage, PaintRect, Point, Rect, Size, TextBlock, TextLayout, TextLayoutEngine,
    TextLayoutWidth, TextSpan, TextStyle,
};

use crate::accessibility::{MarkdownSemanticNode, MarkdownSemanticRole, enclosing_bounds};
use crate::document::{BlockContext, InlineRun, MarkdownBlockKind};
use crate::highlight::{
    MarkdownSyntaxHighlighter, SyntectMarkdownHighlighter, highlighted_code_spans,
};
use crate::inline_layout::{InlineLayout, layout_inline};
use crate::math::{MarkdownMathCache, MarkdownMathImages, MarkdownMathMode};
use crate::presentation::MarkdownPresentation;
use crate::table_layout::{TableLayout, layout_table};
use crate::{MarkdownDocument, MarkdownStyle};

pub(crate) const QUOTE_BAR_WIDTH: f32 = 3.0;
pub(crate) const INLINE_CODE_HORIZONTAL_PADDING: f32 = 3.0;
pub(crate) const INLINE_CODE_VERTICAL_INSET: f32 = 1.0;
pub(crate) const DECORATION_THICKNESS: f32 = 1.0;

/// Reusable Markdown paragraph shaper and block layout engine.
///
/// Hosts retain one engine and call [`layout`](Self::layout) whenever the document, bounds, style,
/// or viewport changes. The engine owns font shaping state only; product identity and scrolling
/// input remain with the host.
pub struct MarkdownLayoutEngine {
    text: TextLayoutEngine,
    highlighter: Box<dyn MarkdownSyntaxHighlighter>,
    math: MarkdownMathCache,
}

impl MarkdownLayoutEngine {
    pub fn new() -> Self {
        Self {
            text: TextLayoutEngine::new(),
            highlighter: Box::new(SyntectMarkdownHighlighter::new()),
            math: MarkdownMathCache::new(),
        }
    }

    pub fn with_syntax_highlighter(
        mut self,
        highlighter: impl MarkdownSyntaxHighlighter + 'static,
    ) -> Self {
        self.highlighter = Box::new(highlighter);
        self
    }

    pub fn layout(
        &mut self,
        bounds: Rect,
        document: &MarkdownDocument,
        scroll: ScrollState,
        style: &MarkdownStyle,
    ) -> Markdown {
        self.layout_with(
            bounds,
            document,
            scroll,
            style,
            &MarkdownPresentation::default(),
        )
    }

    pub fn layout_with(
        &mut self,
        bounds: Rect,
        document: &MarkdownDocument,
        scroll: ScrollState,
        style: &MarkdownStyle,
        presentation: &MarkdownPresentation,
    ) -> Markdown {
        if bounds.is_empty() || document.is_empty() {
            return Markdown {
                bounds,
                content_height: 0.0,
                vertical_offset: 0.0,
                rects: Vec::new(),
                images: Vec::new(),
                text: Vec::new(),
                links: Vec::new(),
                text_regions: Vec::new(),
                semantics: MarkdownSemanticNode::new(
                    MarkdownSemanticRole::Document,
                    String::new(),
                    bounds,
                ),
            };
        }
        let inline_math = self.math.prepare_inline(document, style);
        let mut blocks = Vec::with_capacity(document.blocks.len());
        let mut top = 0.0;
        for (index, block) in document.blocks.iter().enumerate() {
            let projected = self.project_block(
                bounds.size.width,
                &block.kind,
                &block.context,
                style,
                presentation,
                &inline_math,
            );
            let height = projected.height();
            blocks.push(PositionedBlock {
                index,
                top,
                context: block.context.clone(),
                semantic: semantic_projection(&block.kind, &block.context),
                projected,
            });
            top += height + style.block_gap();
        }
        let content_height = (top - style.block_gap()).max(0.0);
        let metrics = ScrollMetrics::new(bounds.size, Size::new(bounds.size.width, content_height));
        let vertical_offset = scroll
            .vertical_offset()
            .clamp(0.0, metrics.maximum_offset().y);
        let mut markdown = Markdown {
            bounds,
            content_height,
            vertical_offset,
            rects: Vec::new(),
            images: Vec::new(),
            text: Vec::new(),
            links: Vec::new(),
            text_regions: Vec::new(),
            semantics: MarkdownSemanticNode::new(
                MarkdownSemanticRole::Document,
                String::new(),
                bounds,
            ),
        };
        for block in blocks {
            markdown.emit(block, style);
        }
        markdown.apply_presentation(presentation, style);
        for link in &markdown.links {
            if let Some(bounds) = enclosing_bounds(&link.bounds) {
                markdown.semantics.push_child(
                    MarkdownSemanticNode::new(
                        MarkdownSemanticRole::Link,
                        link.destination.clone(),
                        bounds,
                    )
                    .with_destination(link.destination.clone()),
                );
            }
        }
        markdown
    }

    fn project_block(
        &mut self,
        total_width: f32,
        kind: &MarkdownBlockKind,
        context: &BlockContext,
        style: &MarkdownStyle,
        presentation: &MarkdownPresentation,
        inline_math: &MarkdownMathImages,
    ) -> ProjectedBlock {
        let leading = context.quote_depth as f32 * style.quote_indent()
            + context.list_depth as f32 * style.list_indent();
        let width = (total_width - leading).max(1.0);
        match kind {
            MarkdownBlockKind::Paragraph(runs) => self.project_text(
                runs,
                style.body().clone(),
                width,
                style,
                presentation.images(),
                inline_math,
            ),
            MarkdownBlockKind::Heading { level, runs } => self.project_text(
                runs,
                style.heading(*level),
                width,
                style,
                presentation.images(),
                inline_math,
            ),
            MarkdownBlockKind::Table(table) => ProjectedBlock::Table(layout_table(
                &mut self.text,
                table,
                width,
                style,
                presentation.images(),
                inline_math,
            )),
            MarkdownBlockKind::CodeBlock { language, text } => {
                let padding = style.code_padding();
                let text_style = style.code_block();
                let text_width = (width - padding * 2.0).max(1.0);
                let label_height = language.as_ref().map_or(0.0, |_| text_style.line_height());
                let spans = highlighted_code_spans(
                    self.highlighter.as_ref(),
                    language.as_deref(),
                    text,
                    &text_style,
                );
                let layout =
                    self.text
                        .layout_spans(&spans, &text_style, TextLayoutWidth::Wrap(text_width));
                ProjectedBlock::Code {
                    language: language.clone(),
                    spans,
                    text: text.clone(),
                    layout,
                    style: text_style,
                    width,
                    label_height,
                    padding,
                }
            }
            MarkdownBlockKind::Image(source) => {
                let loaded = presentation.images().get(source.destination()).cloned();
                let (image_width, image_height) = loaded.as_ref().map_or((width, 64.0), |image| {
                    let scale = (width / image.width() as f32).min(1.0);
                    (image.width() as f32 * scale, image.height() as f32 * scale)
                });
                ProjectedBlock::Image {
                    source: source.clone(),
                    image: loaded,
                    width: image_width,
                    height: image_height.max(style.body().line_height()),
                }
            }
            MarkdownBlockKind::Math { text, display } => {
                let math_style = style.math_block();
                let mode = if *display {
                    MarkdownMathMode::Display
                } else {
                    MarkdownMathMode::Inline
                };
                if let Some(image) =
                    self.math
                        .render(text, mode, math_style.color(), math_style.font_size())
                {
                    let scale = (width / image.width() as f32).min(1.0);
                    let image_width = image.width() as f32 * scale;
                    let source_layout = self.text.layout_spans(
                        &[TextSpan::new(text, math_style.clone())],
                        &math_style,
                        TextLayoutWidth::Wrap(image_width.max(1.0)),
                    );
                    return ProjectedBlock::Math {
                        source: text.clone(),
                        source_layout,
                        width: image_width,
                        height: image.height() as f32 * scale,
                        image,
                    };
                }
                let runs = vec![InlineRun {
                    text: text.clone(),
                    format: crate::document::InlineFormat {
                        math: true,
                        ..Default::default()
                    },
                }];
                self.project_text(
                    &runs,
                    math_style,
                    width,
                    style,
                    presentation.images(),
                    inline_math,
                )
            }
            MarkdownBlockKind::Rule => ProjectedBlock::Rule { width },
        }
    }

    fn project_text(
        &mut self,
        runs: &[InlineRun],
        base: TextStyle,
        width: f32,
        style: &MarkdownStyle,
        images: &crate::MarkdownImages,
        inline_math: &MarkdownMathImages,
    ) -> ProjectedBlock {
        ProjectedBlock::Text {
            inline: layout_inline(
                &mut self.text,
                runs,
                base,
                TextLayoutWidth::Wrap(width.max(1.0)),
                style,
                images,
                inline_math,
            ),
            width,
        }
    }
}

impl Default for MarkdownLayoutEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Immutable, already-shaped Markdown component for one viewport frame.
pub struct Markdown {
    pub(crate) bounds: Rect,
    pub(crate) content_height: f32,
    pub(crate) vertical_offset: f32,
    pub(crate) rects: Vec<PaintRect>,
    pub(crate) images: Vec<PaintImage>,
    pub(crate) text: Vec<TextBlock>,
    pub(crate) links: Vec<MarkdownLink>,
    pub(crate) text_regions: Vec<MarkdownTextRegion>,
    pub(crate) semantics: MarkdownSemanticNode,
}

/// A laid-out link whose destination remains untrusted until the host activates it.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownLink {
    pub(crate) destination: String,
    pub(crate) bounds: Vec<Rect>,
}

impl MarkdownLink {
    pub fn destination(&self) -> &str {
        &self.destination
    }

    /// Returns visible, viewport-clipped hit fragments for this link.
    pub fn bounds(&self) -> &[Rect] {
        &self.bounds
    }
}

pub(crate) struct PositionedBlock {
    pub(crate) index: usize,
    pub(crate) top: f32,
    pub(crate) context: BlockContext,
    pub(crate) semantic: SemanticProjection,
    pub(crate) projected: ProjectedBlock,
}

pub(crate) enum ProjectedBlock {
    Text {
        inline: InlineLayout,
        width: f32,
    },
    Code {
        language: Option<String>,
        text: String,
        spans: Vec<TextSpan>,
        layout: TextLayout,
        style: TextStyle,
        width: f32,
        label_height: f32,
        padding: f32,
    },
    Image {
        source: crate::MarkdownImageSource,
        image: Option<ImageData>,
        width: f32,
        height: f32,
    },
    Math {
        source: String,
        source_layout: TextLayout,
        image: ImageData,
        width: f32,
        height: f32,
    },
    Rule {
        width: f32,
    },
    Table(TableLayout),
}

impl ProjectedBlock {
    pub(crate) fn height(&self) -> f32 {
        match self {
            Self::Text { inline, .. } => inline.size.height,
            Self::Code {
                layout,
                label_height,
                padding,
                ..
            } => layout.size().height + label_height + padding * 2.0,
            Self::Image { height, .. } | Self::Math { height, .. } => *height,
            Self::Rule { .. } => 1.0,
            Self::Table(table) => table.height,
        }
    }

    pub(crate) const fn width(&self) -> f32 {
        match self {
            Self::Text { width, .. }
            | Self::Code { width, .. }
            | Self::Image { width, .. }
            | Self::Math { width, .. }
            | Self::Rule { width } => *width,
            Self::Table(table) => table.width,
        }
    }
}

pub(crate) struct MarkdownTextRegion {
    pub(crate) block: usize,
    pub(crate) source_start: usize,
    pub(crate) text: String,
    pub(crate) origin: Point,
    pub(crate) layout: TextLayout,
}

impl MarkdownTextRegion {
    pub(crate) fn bounds(&self) -> Rect {
        Rect::new(self.origin, self.layout.size())
    }
}

pub(crate) struct SemanticProjection {
    pub(crate) role: MarkdownSemanticRole,
    pub(crate) label: String,
    pub(crate) level: Option<u8>,
    pub(crate) identifier: Option<String>,
}

fn semantic_projection(kind: &MarkdownBlockKind, context: &BlockContext) -> SemanticProjection {
    let label = match kind {
        MarkdownBlockKind::Paragraph(runs) | MarkdownBlockKind::Heading { runs, .. } => {
            runs.iter().map(|run| run.text.as_str()).collect()
        }
        MarkdownBlockKind::CodeBlock { text, .. } | MarkdownBlockKind::Math { text, .. } => {
            text.clone()
        }
        MarkdownBlockKind::Image(image) => image.alt().to_owned(),
        MarkdownBlockKind::Table(_) => "Table".to_owned(),
        MarkdownBlockKind::Rule => String::new(),
    };
    let (role, level, identifier) = match kind {
        MarkdownBlockKind::Heading { level, .. } => {
            (MarkdownSemanticRole::Heading, Some(*level), None)
        }
        MarkdownBlockKind::CodeBlock { .. } => (MarkdownSemanticRole::Code, None, None),
        MarkdownBlockKind::Image(_) => (MarkdownSemanticRole::Image, None, None),
        MarkdownBlockKind::Math { .. } => (MarkdownSemanticRole::Math, None, None),
        MarkdownBlockKind::Table(_) => (MarkdownSemanticRole::Table, None, None),
        MarkdownBlockKind::Rule => (MarkdownSemanticRole::Separator, None, None),
        MarkdownBlockKind::Paragraph(_) if context.footnote.is_some() => (
            MarkdownSemanticRole::Footnote,
            None,
            context.footnote.as_ref().map(|label| format!("fn-{label}")),
        ),
        MarkdownBlockKind::Paragraph(_) if context.marker.is_some() => {
            (MarkdownSemanticRole::ListItem, None, None)
        }
        MarkdownBlockKind::Paragraph(_) => (MarkdownSemanticRole::Paragraph, None, None),
    };
    let identifier = identifier.or_else(|| {
        matches!(kind, MarkdownBlockKind::Heading { .. }).then(|| heading_identifier(&label))
    });
    SemanticProjection {
        role,
        label,
        level,
        identifier,
    }
}

fn heading_identifier(label: &str) -> String {
    label
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
