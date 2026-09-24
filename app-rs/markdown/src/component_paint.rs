use zui::ui::{
    Border, Component, ComponentElement, CornerRadii, Element, PaintImage, PaintRect, Point, Rect,
    Size, TextBlock, TextStyle, UiScene,
};

use crate::component::{
    DECORATION_THICKNESS, INLINE_CODE_HORIZONTAL_PADDING, INLINE_CODE_VERTICAL_INSET, Markdown,
    MarkdownLink, MarkdownTextRegion, PositionedBlock, ProjectedBlock, QUOTE_BAR_WIDTH,
};
use crate::document::BlockContext;
use crate::inline_layout::{InlineDecoration, InlineLayout, offset_rect};
use crate::table_layout::{CELL_HORIZONTAL_PADDING, CELL_VERTICAL_PADDING, TableLayout};
use crate::{MarkdownSemanticNode, MarkdownSemanticRole, MarkdownStyle};

impl Markdown {
    pub(crate) fn emit(&mut self, block: PositionedBlock, style: &MarkdownStyle) {
        let leading = block.context.quote_depth as f32 * style.quote_indent()
            + block.context.list_depth as f32 * style.list_indent();
        let x = self.bounds.origin.x + leading;
        let y = self.bounds.origin.y + block.top - self.vertical_offset;
        let height = block.projected.height();
        let block_bounds = Rect::from_xywh(x, y, block.projected.width(), height);
        if block_bounds.intersection(self.bounds).is_empty() {
            return;
        }
        self.emit_quotes(y, height, block.context.quote_depth, style);
        self.emit_marker(y, height, &block.context, style);
        let semantic_bounds = block_bounds.intersection(self.bounds);
        if !semantic_bounds.is_empty() {
            let mut semantic = MarkdownSemanticNode::new(
                block.semantic.role,
                block.semantic.label,
                semantic_bounds,
            );
            if let Some(level) = block.semantic.level {
                semantic = semantic.with_level(level);
            }
            if let Some(identifier) = block.semantic.identifier {
                semantic = semantic.with_identifier(identifier);
            }
            self.semantics.push_child(semantic);
        }
        match block.projected {
            ProjectedBlock::Text { inline, width } => {
                self.emit_inline(
                    inline,
                    Point::new(x, y),
                    width,
                    style,
                    Some((block.index, 0)),
                );
            }
            ProjectedBlock::Code {
                language,
                text,
                spans,
                layout,
                style: text_style,
                width,
                label_height,
                padding,
            } => {
                self.rects.push(
                    PaintRect::new(
                        Rect::from_xywh(x, y, width, height),
                        style.code_background(),
                    )
                    .with_border(Border::uniform(1.0, style.border()))
                    .with_corner_radii(CornerRadii::uniform(4.0)),
                );
                let mut text_y = y + padding;
                if let Some(language) = language {
                    self.text.push(TextBlock::new(
                        language,
                        Point::new(x + padding, text_y),
                        Size::new((width - padding * 2.0).max(1.0), label_height.max(1.0)),
                        TextStyle::new(text_style.font_size(), style.muted())
                            .with_family(text_style.family().clone())
                            .with_line_height(text_style.line_height()),
                    ));
                    text_y += label_height;
                }
                if !text.is_empty() {
                    let origin = Point::new(x + padding, text_y);
                    self.text.push(TextBlock::from_spans(
                        spans,
                        origin,
                        Size::new(
                            (width - padding * 2.0).max(1.0),
                            layout.size().height.max(1.0),
                        ),
                        text_style,
                    ));
                    self.text_regions.push(MarkdownTextRegion {
                        block: block.index,
                        source_start: 0,
                        text,
                        origin,
                        layout,
                    });
                }
            }
            ProjectedBlock::Image {
                source,
                image,
                width,
                height,
            } => {
                let image_bounds = Rect::from_xywh(x, y, width, height);
                if let Some(image) = image {
                    self.images.push(PaintImage::new(image, image_bounds));
                } else {
                    self.rects.push(
                        PaintRect::new(image_bounds, style.code_background())
                            .with_border(Border::uniform(1.0, style.border()))
                            .with_corner_radii(CornerRadii::uniform(4.0)),
                    );
                    self.text.push(TextBlock::new(
                        if source.alt().is_empty() {
                            source.destination()
                        } else {
                            source.alt()
                        },
                        Point::new(x + 8.0, y + 8.0),
                        Size::new((width - 16.0).max(1.0), (height - 16.0).max(1.0)),
                        style.body().clone(),
                    ));
                }
            }
            ProjectedBlock::Math {
                source,
                source_layout,
                image,
                width,
                height,
            } => {
                let bounds = Rect::from_xywh(x, y, width, height);
                self.images.push(PaintImage::new(image, bounds));
                self.text_regions.push(MarkdownTextRegion {
                    block: block.index,
                    source_start: 0,
                    text: source,
                    origin: Point::new(x, y),
                    layout: source_layout,
                });
            }
            ProjectedBlock::Rule { width } => {
                self.rects.push(PaintRect::new(
                    Rect::from_xywh(x, y, width, 1.0),
                    style.border(),
                ));
            }
            ProjectedBlock::Table(table) => {
                self.emit_table(table, Point::new(x, y), style, block.index)
            }
        }
    }

    fn emit_inline(
        &mut self,
        inline: InlineLayout,
        origin: Point,
        width: f32,
        style: &MarkdownStyle,
        text_source: Option<(usize, usize)>,
    ) {
        for decoration in inline.decorations {
            match decoration {
                InlineDecoration::Code { fragments } => {
                    for fragment in fragments {
                        let bounds = offset_rect(fragment, origin);
                        self.rects.push(
                            PaintRect::new(
                                Rect::from_xywh(
                                    bounds.origin.x - INLINE_CODE_HORIZONTAL_PADDING,
                                    bounds.origin.y + INLINE_CODE_VERTICAL_INSET,
                                    bounds.size.width + INLINE_CODE_HORIZONTAL_PADDING * 2.0,
                                    (bounds.size.height - INLINE_CODE_VERTICAL_INSET * 2.0)
                                        .max(1.0),
                                ),
                                style.inline_code_background(),
                            )
                            .with_corner_radii(CornerRadii::uniform(3.0)),
                        );
                    }
                }
                InlineDecoration::Link {
                    destination,
                    fragments,
                } => {
                    let bounds = fragments
                        .into_iter()
                        .map(|fragment| offset_rect(fragment, origin))
                        .map(|fragment| fragment.intersection(self.bounds))
                        .filter(|fragment| !fragment.is_empty())
                        .collect::<Vec<_>>();
                    for fragment in &bounds {
                        self.rects.push(PaintRect::new(
                            Rect::from_xywh(
                                fragment.origin.x,
                                fragment.bottom() - DECORATION_THICKNESS,
                                fragment.size.width,
                                DECORATION_THICKNESS,
                            ),
                            style.link(),
                        ));
                    }
                    if !bounds.is_empty() {
                        self.links.push(MarkdownLink {
                            destination,
                            bounds,
                        });
                    }
                }
                InlineDecoration::Strikethrough { color, fragments } => {
                    for fragment in fragments {
                        let fragment = offset_rect(fragment, origin);
                        self.rects.push(PaintRect::new(
                            Rect::from_xywh(
                                fragment.origin.x,
                                fragment.origin.y + fragment.size.height * 0.52,
                                fragment.size.width,
                                DECORATION_THICKNESS,
                            ),
                            color,
                        ));
                    }
                }
                InlineDecoration::Image {
                    source,
                    image,
                    fragments,
                } => {
                    for fragment in fragments {
                        let fragment = offset_rect(fragment, origin);
                        let bounds = fit_image_bounds(&image, fragment);
                        self.images.push(PaintImage::new(image.clone(), bounds));
                        self.semantics.push_child(MarkdownSemanticNode::new(
                            MarkdownSemanticRole::Image,
                            source.alt().to_owned(),
                            bounds.intersection(self.bounds),
                        ));
                    }
                }
                InlineDecoration::Math {
                    source,
                    image,
                    fragments,
                } => {
                    for fragment in fragments {
                        let fragment = offset_rect(fragment, origin);
                        let bounds = fit_image_bounds(&image, fragment);
                        self.images.push(PaintImage::new(image.clone(), bounds));
                        self.semantics.push_child(MarkdownSemanticNode::new(
                            MarkdownSemanticRole::Math,
                            source.clone(),
                            bounds.intersection(self.bounds),
                        ));
                    }
                }
            }
        }
        if !inline.spans.is_empty() {
            self.text.push(TextBlock::from_spans(
                inline.spans,
                origin,
                Size::new(width, inline.size.height.max(1.0)),
                inline.style,
            ));
        }
        if let Some((block, source_start)) = text_source
            && !inline.text.is_empty()
        {
            self.text_regions.push(MarkdownTextRegion {
                block,
                source_start,
                text: inline.text,
                origin,
                layout: inline.shaped,
            });
        }
    }

    fn emit_table(
        &mut self,
        table: TableLayout,
        origin: Point,
        style: &MarkdownStyle,
        block: usize,
    ) {
        let mut row_y = origin.y;
        let mut source_offset = 0;
        let mut semantic_rows = Vec::new();
        for row in table.rows {
            let mut semantic_row = MarkdownSemanticNode::new(
                MarkdownSemanticRole::Row,
                String::new(),
                Rect::from_xywh(origin.x, row_y, table.width, row.height).intersection(self.bounds),
            );
            if row.header {
                self.rects.push(PaintRect::new(
                    Rect::from_xywh(origin.x, row_y, table.width, row.height),
                    style.table_header_background(),
                ));
            }
            let mut cell_x = origin.x;
            for (index, cell) in row.cells.into_iter().enumerate() {
                let cell_len = cell.text.len();
                semantic_row.push_child(MarkdownSemanticNode::new(
                    MarkdownSemanticRole::Cell,
                    cell.text.clone(),
                    Rect::from_xywh(cell_x, row_y, table.column_widths[index], row.height)
                        .intersection(self.bounds),
                ));
                self.emit_inline(
                    cell,
                    Point::new(
                        cell_x + CELL_HORIZONTAL_PADDING,
                        row_y + CELL_VERTICAL_PADDING,
                    ),
                    (table.column_widths[index] - CELL_HORIZONTAL_PADDING * 2.0).max(1.0),
                    style,
                    Some((block, source_offset)),
                );
                cell_x += table.column_widths[index];
                source_offset += cell_len;
                if index + 1 < table.column_widths.len() {
                    source_offset += 1;
                }
            }
            semantic_rows.push(semantic_row);
            source_offset += 1;
            row_y += row.height;
            self.rects.push(PaintRect::new(
                Rect::from_xywh(origin.x, row_y - DECORATION_THICKNESS, table.width, 1.0),
                style.border(),
            ));
        }
        self.rects.push(PaintRect::new(
            Rect::from_xywh(origin.x, origin.y, table.width, DECORATION_THICKNESS),
            style.border(),
        ));
        let mut boundary_x = origin.x;
        self.rects.push(PaintRect::new(
            Rect::from_xywh(boundary_x, origin.y, DECORATION_THICKNESS, table.height),
            style.border(),
        ));
        for column_width in table.column_widths {
            boundary_x += column_width;
            self.rects.push(PaintRect::new(
                Rect::from_xywh(
                    boundary_x - DECORATION_THICKNESS,
                    origin.y,
                    DECORATION_THICKNESS,
                    table.height,
                ),
                style.border(),
            ));
        }
        if let Some(table) = self.semantics.last_child_mut()
            && table.role() == MarkdownSemanticRole::Table
        {
            for row in semantic_rows {
                table.push_child(row);
            }
        }
    }

    fn emit_quotes(&mut self, y: f32, height: f32, depth: usize, style: &MarkdownStyle) {
        for index in 0..depth {
            self.rects.push(PaintRect::new(
                Rect::from_xywh(
                    self.bounds.origin.x + index as f32 * style.quote_indent(),
                    y,
                    QUOTE_BAR_WIDTH,
                    height,
                ),
                style.border(),
            ));
        }
    }

    fn emit_marker(&mut self, y: f32, height: f32, context: &BlockContext, style: &MarkdownStyle) {
        let Some(marker) = context.marker.as_ref() else {
            return;
        };
        let x = self.bounds.origin.x
            + context.quote_depth as f32 * style.quote_indent()
            + context.list_depth.saturating_sub(1) as f32 * style.list_indent();
        self.text.push(TextBlock::new(
            marker,
            Point::new(x, y),
            Size::new(style.list_indent(), height.max(1.0)),
            TextStyle::new(style.body().font_size(), style.muted())
                .with_family(style.body().family().clone())
                .with_line_height(style.body().line_height()),
        ));
    }
}

fn fit_image_bounds(image: &zui::ui::ImageData, available: Rect) -> Rect {
    let scale = (available.size.width / image.width() as f32)
        .min(available.size.height / image.height() as f32);
    let width = image.width() as f32 * scale;
    let height = image.height() as f32 * scale;
    Rect::from_xywh(
        available.origin.x + (available.size.width - width) * 0.5,
        available.origin.y + (available.size.height - height) * 0.5,
        width,
        height,
    )
}

impl Component for Markdown {
    fn element(&self) -> ComponentElement {
        Element::leaf("Markdown").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        if self.bounds.is_empty() {
            return;
        }
        scene.with_clip(self.bounds, |scene| {
            for rect in &self.rects {
                scene.draw_rect(*rect);
            }
            for image in &self.images {
                scene.draw_image(image.clone());
            }
            for text in &self.text {
                scene.draw_text(text.clone());
            }
        });
    }
}
