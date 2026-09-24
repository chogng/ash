//! Shared code viewport and lazy visual-row projection.

use std::ops::Range;

use zui::ui::{
    CaretVisibility, Color, Component, ComponentElement, Element, PaintRect, Point, Rect, Size,
    TextBlock, TextBlockWrap, TextStyle, UiScene,
};

pub use self::analysis::CodeEditorLanguage;
pub use self::diagnostics::{
    CodeEditorDiagnostic, CodeEditorDiagnosticPalette, CodeEditorDiagnosticSeverity,
};
pub use self::document::{CodeEditorDocument, CodeEditorRevision};
pub use self::editing::{CodeEditorCommand, CodeEditorSelectionMode, CodeEditorTextEdit};
pub use self::folding::{CodeEditorFoldControl, CodeEditorFoldState, CodeEditorFoldingRange};
pub use self::indentation::CodeEditorIndentation;
use self::layout::{CodeEditorLayout, build_layout};
pub use self::search::{CodeEditorCaseSensitivity, CodeEditorSearchMatch, CodeEditorSearchQuery};
pub use self::style::{
    CodeEditorPalette, CodeEditorStyle, CodeEditorTypography, CodeEditorTypographyError,
};
pub use self::syntax::{CodeEditorSyntaxPalette, CodeEditorSyntaxToken, CodeEditorTokenRole};
use self::text_metrics::visit_display_cell_runs;
use self::wrapping::{CodeEditorVisualLine, CodeEditorVisualProjection};

const MARKER_WIDTH: f32 = 16.0;
const GUTTER_HORIZONTAL_PADDING: f32 = 8.0;
const DEFAULT_CONTENT_HORIZONTAL_PADDING: f32 = 8.0;
const TAB_WIDTH: usize = 4;

fn paint_text_block(
    scene: &mut UiScene,
    text: impl Into<String>,
    origin: Point,
    bounds: Size,
    style: TextStyle,
    cell_width: f32,
) {
    let text = text.into();
    if text.is_empty() || bounds.width <= 0.0 || bounds.height <= 0.0 {
        return;
    }
    visit_display_cell_runs(&text, |run| {
        paint_cell_run(
            scene,
            run.text,
            origin,
            bounds.height,
            run.column,
            run.columns,
            &style,
            cell_width,
        );
    });
}

fn paint_cell_run(
    scene: &mut UiScene,
    text: &str,
    origin: Point,
    height: f32,
    column: usize,
    columns: usize,
    style: &TextStyle,
    cell_width: f32,
) {
    if text.is_empty() || columns == 0 {
        return;
    }
    scene.draw_text(
        TextBlock::new(
            text,
            Point::new(origin.x + column as f32 * cell_width, origin.y),
            Size::new(columns as f32 * cell_width, height),
            style.clone(),
        )
        .with_wrap(TextBlockWrap::None),
    );
}

mod analysis;
mod auto_pairs;
mod core_transaction;
mod decorations;
mod diagnostics;
mod document;
mod editing;
mod folding;
mod folding_sources;
mod indentation;
mod language_configuration;
mod language_editing;
mod layout;
mod line_endings;
mod line_operations;
mod search;
mod style;
mod syntax;
mod text_metrics;
mod wrapping;

/// One caret or selection endpoint in a source row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodeEditorPosition {
    pub row_index: usize,
    pub byte_offset: usize,
}

/// Ordered selection endpoints projected into CodeEditor rows.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodeEditorSelection {
    pub start: CodeEditorPosition,
    pub end: CodeEditorPosition,
}

/// Rejection reported when a shared document-core transaction cannot be projected by Native.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodeEditorCoreTransactionError {
    Core(ash_editor_core::EditorCoreEditError),
    MultipleSelectionsUnsupported,
}

impl From<ash_editor_core::EditorCoreEditError> for CodeEditorCoreTransactionError {
    fn from(error: ash_editor_core::EditorCoreEditError) -> Self {
        Self::Core(error)
    }
}

/// Active platform preedit projected at the committed caret.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodeEditorComposition<'a> {
    pub text: &'a str,
    pub cursor: &'a zui::ui::TextInputCompositionCursor,
}

/// Optional header treatment above a CodeEditor viewport.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodeEditorHeader<'a> {
    #[default]
    Hidden,
    Label(&'a str),
}

/// Named geometry variants owned by the shared CodeEditor.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodeEditorPresentation {
    /// Ordinary document editor with line numbers and marker gutter.
    #[default]
    Document,
    /// Embedded editor without document chrome, suitable for compact composers.
    Compact,
}

/// Visual treatment used for the focused editor caret.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodeEditorCaretStyle {
    #[default]
    Bar,
    Block,
}

/// Whether long source rows remain horizontally scrollable or wrap to the viewport width.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodeEditorLineWrapping {
    #[default]
    None,
    Soft,
}

/// Resolved visual-line contract used by document keyboard navigation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodeEditorNavigation {
    /// Navigate source rows and move a full visible page for page commands.
    LogicalLines { page_rows: usize },
    /// Navigate wrapped visual rows and move a full visible page for page commands.
    SoftWrapped { columns: usize, page_rows: usize },
}

impl CodeEditorNavigation {
    const DEFAULT_PAGE_ROWS: usize = 10;

    /// Returns the resolved visible-row capacity used for page navigation.
    pub const fn page_rows(self) -> usize {
        match self {
            Self::LogicalLines { page_rows } | Self::SoftWrapped { page_rows, .. } => page_rows,
        }
    }
}

impl Default for CodeEditorNavigation {
    fn default() -> Self {
        Self::LogicalLines {
            page_rows: Self::DEFAULT_PAGE_ROWS,
        }
    }
}

impl CodeEditorHeader<'_> {
    fn height(self, style: &CodeEditorStyle) -> f32 {
        match self {
            Self::Hidden => 0.0,
            Self::Label(_) => style.header_height(),
        }
    }
}

/// Retained scroll position for one CodeEditor document view.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CodeEditorViewport {
    first_visible_row: usize,
    horizontal_column: usize,
}

impl CodeEditorViewport {
    pub const fn new(first_visible_row: usize) -> Self {
        Self {
            first_visible_row,
            horizontal_column: 0,
        }
    }

    pub const fn with_horizontal_column(mut self, column: usize) -> Self {
        self.horizontal_column = column;
        self
    }

    pub const fn first_visible_row(self) -> usize {
        self.first_visible_row
    }

    pub const fn horizontal_column(self) -> usize {
        self.horizontal_column
    }

    pub fn scroll_rows(&mut self, delta: isize, row_count: usize, visible_row_capacity: usize) {
        let maximum = row_count.saturating_sub(visible_row_capacity);
        self.first_visible_row = self.first_visible_row.min(maximum);
        self.first_visible_row = if delta.is_negative() {
            self.first_visible_row.saturating_sub(delta.unsigned_abs())
        } else {
            self.first_visible_row
                .saturating_add(delta as usize)
                .min(maximum)
        };
    }

    pub fn set_horizontal_column(&mut self, column: usize) {
        self.horizontal_column = column;
    }

    pub fn clamp(&mut self, row_count: usize, visible_row_capacity: usize) {
        self.first_visible_row = self
            .first_visible_row
            .min(row_count.saturating_sub(visible_row_capacity));
    }

    /// Moves the retained window only when `row` falls outside its visible range.
    pub fn reveal_row(&mut self, row: usize, row_count: usize, visible_row_capacity: usize) {
        if visible_row_capacity == 0 {
            self.first_visible_row = row.min(row_count.saturating_sub(1));
            return;
        }
        if row < self.first_visible_row {
            self.first_visible_row = row;
        } else if row >= self.first_visible_row.saturating_add(visible_row_capacity) {
            self.first_visible_row = row.saturating_add(1).saturating_sub(visible_row_capacity);
        }
        self.clamp(row_count, visible_row_capacity);
    }
}

/// One byte-range highlight painted below code text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeEditorInlineHighlight {
    range: Range<usize>,
    color: Color,
}

impl CodeEditorInlineHighlight {
    pub const fn new(range: Range<usize>, color: Color) -> Self {
        Self { range, color }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CodeEditorMarker<'a> {
    text: &'a str,
    color: Color,
}

/// One visual row supplied to CodeEditor independently from document storage.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeEditorRow<'a> {
    line_number: Option<usize>,
    text: Option<&'a str>,
    marker: Option<CodeEditorMarker<'a>>,
    background: Option<Color>,
    inline_highlights: Vec<CodeEditorInlineHighlight>,
    syntax_tokens: Vec<CodeEditorSyntaxToken>,
}

impl<'a> CodeEditorRow<'a> {
    pub const fn new(line_number: usize, text: &'a str) -> Self {
        Self {
            line_number: Some(line_number),
            text: Some(text),
            marker: None,
            background: None,
            inline_highlights: Vec::new(),
            syntax_tokens: Vec::new(),
        }
    }

    pub const fn placeholder() -> Self {
        Self {
            line_number: None,
            text: None,
            marker: None,
            background: None,
            inline_highlights: Vec::new(),
            syntax_tokens: Vec::new(),
        }
    }

    /// Creates a non-document visual row such as a diff fold control.
    pub const fn annotation(text: &'a str) -> Self {
        Self {
            line_number: None,
            text: Some(text),
            marker: None,
            background: None,
            inline_highlights: Vec::new(),
            syntax_tokens: Vec::new(),
        }
    }

    pub const fn with_marker(mut self, text: &'a str, color: Color) -> Self {
        self.marker = Some(CodeEditorMarker { text, color });
        self
    }

    pub const fn with_background(mut self, background: Color) -> Self {
        self.background = Some(background);
        self
    }

    pub fn with_inline_highlights(mut self, highlights: Vec<CodeEditorInlineHighlight>) -> Self {
        self.inline_highlights = highlights;
        self
    }

    pub fn with_syntax_tokens(mut self, tokens: Vec<CodeEditorSyntaxToken>) -> Self {
        self.syntax_tokens = tokens;
        self
    }
}

/// Lazy visual-row source consumed by CodeEditor.
///
/// Implementations retain authoritative document or projection data and return only the requested
/// visible row. A row source must keep row ordering and line-number identity stable for the
/// lifetime of one presentation frame. Diff projections may return placeholders for alignment or
/// non-numbered annotations for fold controls; ordinary documents should return numbered rows.
pub trait CodeEditorRowSource {
    /// Returns the number of visual rows addressable in this frame.
    fn row_count(&self) -> usize;

    /// Returns the largest real line number used to size the gutter.
    fn largest_line_number(&self) -> usize;

    /// Projects one visual row, or `None` when the index is outside the source.
    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>>;

    /// Returns the authoritative document byte range represented by one source row.
    ///
    /// Ordinary document sources implement this so editor-owned features such as diagnostics can
    /// project document ranges without knowing the host's storage model. Synthetic and diff rows
    /// may keep the default when no single document byte range exists.
    fn source_byte_range(&self, _source_row: usize) -> Option<Range<usize>> {
        None
    }

    /// Maps a visual-row index back to its authoritative source row.
    fn source_row(&self, visual_row: usize) -> Option<usize> {
        (visual_row < self.row_count()).then_some(visual_row)
    }

    /// Maps an authoritative source row into the current visual projection.
    fn visual_row(&self, source_row: usize) -> Option<usize> {
        (source_row < self.row_count()).then_some(source_row)
    }

    /// Returns the folding range and state owned by one source row, when present.
    fn folding_range(
        &self,
        _source_row: usize,
    ) -> Option<(CodeEditorFoldingRange, CodeEditorFoldState)> {
        None
    }

    /// Returns the committed caret position for editable sources.
    fn caret(&self) -> Option<CodeEditorPosition> {
        None
    }

    /// Returns an ordered committed-text selection for editable sources.
    fn selection(&self) -> Option<CodeEditorSelection> {
        None
    }

    /// Returns active platform preedit without mutating committed text.
    fn composition(&self) -> Option<CodeEditorComposition<'_>> {
        None
    }
}

/// A mapped source location under a point in the visible CodeEditor body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodeEditorLocation {
    pub row_index: usize,
    pub line_number: Option<usize>,
}

/// Native code viewport shared by ordinary and diff editor presentations.
///
/// This component owns row geometry, clipping, line-number paint, inline decorations, and
/// viewport projection. Its host owns editing commands, selection/caret state, file identity,
/// persistence, and input routing.
pub struct CodeEditor<'a> {
    bounds: Rect,
    paint_viewport: Rect,
    rows: &'a dyn CodeEditorRowSource,
    viewport: CodeEditorViewport,
    header: CodeEditorHeader<'a>,
    style: CodeEditorStyle,
    presentation: CodeEditorPresentation,
    content_horizontal_padding: f32,
    line_wrapping: CodeEditorLineWrapping,
    visual_projection: CodeEditorVisualProjection,
    caret_visibility: CaretVisibility,
    caret_style: CodeEditorCaretStyle,
    ghost_text: Option<&'a str>,
    diagnostics: &'a [CodeEditorDiagnostic],
}

impl<'a> CodeEditor<'a> {
    pub fn row_height(&self) -> f32 {
        self.style.row_height()
    }

    pub(crate) fn content_height_for_rows(
        header: CodeEditorHeader<'_>,
        row_count: usize,
        style: &CodeEditorStyle,
    ) -> f32 {
        header.height(style) + row_count as f32 * style.row_height()
    }

    pub fn new(
        bounds: Rect,
        rows: &'a dyn CodeEditorRowSource,
        viewport: CodeEditorViewport,
        header: CodeEditorHeader<'a>,
        style: CodeEditorStyle,
    ) -> Self {
        let visual_projection =
            CodeEditorVisualProjection::new(rows, CodeEditorLineWrapping::None, usize::MAX);
        Self {
            bounds,
            paint_viewport: bounds,
            rows,
            viewport,
            header,
            style,
            presentation: CodeEditorPresentation::Document,
            content_horizontal_padding: DEFAULT_CONTENT_HORIZONTAL_PADDING,
            line_wrapping: CodeEditorLineWrapping::None,
            visual_projection,
            caret_visibility: CaretVisibility::Visible,
            caret_style: CodeEditorCaretStyle::Bar,
            ghost_text: None,
            diagnostics: &[],
        }
    }

    /// Selects a named geometry contract without changing the row source.
    pub fn with_presentation(mut self, presentation: CodeEditorPresentation) -> Self {
        self.presentation = presentation;
        self.rebuild_visual_projection();
        self
    }

    /// Sets the horizontal space between the content bounds and editor text.
    pub fn with_content_horizontal_padding(mut self, padding: f32) -> Self {
        self.content_horizontal_padding = padding.max(0.0);
        self.rebuild_visual_projection();
        self
    }

    /// Projects host-owned focus blink state into caret paint.
    pub const fn with_caret_visibility(mut self, visibility: CaretVisibility) -> Self {
        self.caret_visibility = visibility;
        self
    }

    /// Selects the caret treatment without changing focus or blink state.
    pub const fn with_caret_style(mut self, style: CodeEditorCaretStyle) -> Self {
        self.caret_style = style;
        self
    }

    /// Paints a non-document, single-line continuation at the committed caret.
    ///
    /// The host owns suggestion generation and acceptance. CodeEditor only projects the supplied
    /// text without changing document layout, selection, history, or the committed caret.
    pub const fn with_ghost_text(mut self, text: &'a str) -> Self {
        self.ghost_text = Some(text);
        self
    }

    /// Limits row projection to the visible host viewport while preserving document geometry.
    ///
    /// Scroll containers use this when the editor's full content bounds are larger than the
    /// on-screen clip. The editor still positions rows against `bounds`, but does not shape or
    /// publish rows that cannot appear inside `viewport`.
    pub const fn within_viewport(mut self, viewport: Rect) -> Self {
        self.paint_viewport = viewport;
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn visible_row_capacity(&self) -> usize {
        let body_height = (self.bounds.size.height - self.header.height(&self.style)).max(0.0);
        (body_height / self.style.row_height()).floor() as usize
    }

    pub fn content_height(&self) -> f32 {
        Self::content_height_for_rows(self.header, self.visual_projection.len(), &self.style)
    }

    pub fn visible_row_range(&self) -> Range<usize> {
        let capacity = self.visible_row_capacity();
        let row_count = self.visual_projection.len();
        let start = self
            .viewport
            .first_visible_row
            .min(row_count.saturating_sub(capacity));
        start..start.saturating_add(capacity).min(row_count)
    }

    fn painted_row_range(&self, layout: CodeEditorLayout) -> Range<usize> {
        let visible = self.visible_row_range();
        let painted_body = layout.body.intersection(self.paint_viewport);
        if visible.is_empty() || painted_body.is_empty() {
            return visible.start..visible.start;
        }
        let row_height = self.style.row_height();
        let first_offset =
            ((painted_body.origin.y - layout.body.origin.y) / row_height).floor() as usize;
        let end_offset =
            ((painted_body.bottom() - layout.body.origin.y) / row_height).ceil() as usize;
        visible.start.saturating_add(first_offset).min(visible.end)
            ..visible.start.saturating_add(end_offset).min(visible.end)
    }

    pub fn location_at(&self, point: Point) -> Option<CodeEditorLocation> {
        let layout = self.layout();
        if !layout.body.contains(point) {
            return None;
        }
        let visible = self.visible_row_range();
        let visual_row = visible.start
            + ((point.y - layout.body.origin.y) / self.style.row_height())
                .floor()
                .max(0.0) as usize;
        let line = self.visual_projection.line(self.rows, visual_row)?;
        let row = self.rows.row(line.row_index)?;
        Some(CodeEditorLocation {
            row_index: visual_row,
            line_number: line.first_for_row.then_some(row.line_number).flatten(),
        })
    }

    pub fn text_position_at(&self, point: Point) -> Option<CodeEditorPosition> {
        let layout = self.layout();
        let location = self.location_at(point)?;
        let line = self.visual_projection.line(self.rows, location.row_index)?;
        let row = self.rows.row(line.row_index)?;
        let text = row.text?;
        let local_column = if point.x <= layout.content.origin.x + self.content_horizontal_padding {
            0
        } else {
            ((point.x - layout.content.origin.x - self.content_horizontal_padding)
                / self.style.cell_width())
            .floor() as usize
        };
        let visual_column = self
            .horizontal_origin_column(line)
            .saturating_add(local_column)
            .min(line.end_column);
        Some(CodeEditorPosition {
            row_index: self.rows.source_row(line.row_index)?,
            byte_offset: self::text_metrics::byte_offset_for_column(text, visual_column),
        })
    }

    /// Returns the visible document-fold controls whose geometry intersects this frame.
    pub fn fold_controls(&self) -> Vec<CodeEditorFoldControl> {
        if self.presentation != CodeEditorPresentation::Document {
            return Vec::new();
        }
        let layout = self.layout();
        let visible = self.visible_row_range();
        self.painted_row_range(layout)
            .filter_map(|visual_row| {
                let line = self.visual_projection.line(self.rows, visual_row)?;
                if !line.first_for_row {
                    return None;
                }
                let source_row = self.rows.source_row(line.row_index)?;
                let (range, state) = self.rows.folding_range(source_row)?;
                let bounds = Rect::from_xywh(
                    layout.gutter.right() - MARKER_WIDTH,
                    layout.body.origin.y
                        + visual_row.saturating_sub(visible.start) as f32 * self.style.row_height(),
                    MARKER_WIDTH,
                    self.style.row_height(),
                );
                Some(CodeEditorFoldControl::new(range, bounds, state))
            })
            .collect()
    }

    /// Hit-tests a document folding control without exposing gutter geometry to the host.
    pub fn fold_control_at(&self, point: Point) -> Option<CodeEditorFoldControl> {
        self.fold_controls()
            .into_iter()
            .find(|control| control.bounds().contains(point))
    }

    fn layout(&self) -> CodeEditorLayout {
        build_layout(
            self.bounds,
            self.gutter_width(),
            self.header.height(&self.style),
        )
    }

    fn gutter_width(&self) -> f32 {
        if self.presentation == CodeEditorPresentation::Compact {
            return 0.0;
        }
        let largest_line = self.rows.largest_line_number().max(1);
        let digits = largest_line.ilog10() as f32 + 1.0;
        MARKER_WIDTH + GUTTER_HORIZONTAL_PADDING * 2.0 + digits * self.style.cell_width()
    }

    fn paint_header(&self, scene: &mut UiScene, layout: CodeEditorLayout) {
        let CodeEditorHeader::Label(label) = self.header else {
            return;
        };
        scene.draw_rect(self.style.header_rect(layout.header));
        let label_bounds = Rect::from_xywh(
            layout.header.origin.x + self.content_horizontal_padding,
            layout.header.origin.y,
            (layout.header.size.width - self.content_horizontal_padding * 2.0).max(0.0),
            layout.header.size.height,
        );
        paint_text_block(
            scene,
            label,
            label_bounds.origin,
            label_bounds.size,
            self.style.header_text_style().clone(),
            self.style.cell_width(),
        );
    }

    fn paint_row(
        &self,
        scene: &mut UiScene,
        layout: CodeEditorLayout,
        visible_row: usize,
        visual_row: usize,
        line: CodeEditorVisualLine,
        row: CodeEditorRow<'_>,
    ) {
        let row_height = self.style.row_height();
        let cell_width = self.style.cell_width();
        let row_bounds = Rect::from_xywh(
            layout.body.origin.x,
            layout.body.origin.y + visible_row as f32 * row_height,
            layout.body.size.width,
            row_height,
        );
        scene.draw_rect(PaintRect::new(
            row_bounds,
            row.background.unwrap_or(self.style.surface()),
        ));
        let Some(text) = row.text else {
            return;
        };
        let source_row = self
            .rows
            .source_row(line.row_index)
            .unwrap_or(line.row_index);
        if self.presentation == CodeEditorPresentation::Document {
            let gutter_bounds = Rect::from_xywh(
                row_bounds.origin.x,
                row_bounds.origin.y,
                layout.gutter.size.width,
                row_height,
            );
            scene.draw_rect(PaintRect::new(gutter_bounds, self.style.gutter()));
            let number_width =
                (layout.gutter.size.width - MARKER_WIDTH - GUTTER_HORIZONTAL_PADDING * 2.0)
                    .max(0.0);
            if line.first_for_row
                && let Some(line_number) = row.line_number
            {
                let number = format!(
                    "{:>width$}",
                    line_number,
                    width = (number_width / cell_width).floor() as usize
                );
                let number_bounds = Rect::from_xywh(
                    layout.gutter.origin.x + GUTTER_HORIZONTAL_PADDING,
                    row_bounds.origin.y,
                    number_width,
                    row_height,
                );
                paint_text_block(
                    scene,
                    number,
                    number_bounds.origin,
                    number_bounds.size,
                    self.style.muted_text_style(),
                    cell_width,
                );
            }
            let fold = line
                .first_for_row
                .then_some(source_row)
                .and_then(|source_row| {
                    self.rows
                        .folding_range(source_row)
                        .map(|(_, state)| match state {
                            CodeEditorFoldState::Collapsed => "▸",
                            CodeEditorFoldState::Expanded => "▾",
                        })
                });
            if let Some(fold) = fold {
                let marker_bounds = Rect::from_xywh(
                    layout.gutter.right() - MARKER_WIDTH,
                    row_bounds.origin.y,
                    MARKER_WIDTH,
                    row_height,
                );
                paint_text_block(
                    scene,
                    fold,
                    marker_bounds.origin,
                    marker_bounds.size,
                    self.style.muted_text_style(),
                    cell_width,
                );
            } else if line.first_for_row
                && let Some(marker) = row.marker
            {
                let marker_bounds = Rect::from_xywh(
                    layout.gutter.right() - MARKER_WIDTH,
                    row_bounds.origin.y,
                    MARKER_WIDTH,
                    row_height,
                );
                paint_text_block(
                    scene,
                    marker.text,
                    marker_bounds.origin,
                    marker_bounds.size,
                    self.style.text_with_color(marker.color),
                    cell_width,
                );
            }
        }

        let content_row_bounds = Rect::from_xywh(
            layout.content.origin.x,
            row_bounds.origin.y,
            layout.content.size.width,
            row_height,
        );
        scene.with_clip(content_row_bounds, |scene| {
            let origin_column = self.horizontal_origin_column(line);
            self.paint_selection(scene, content_row_bounds, source_row, text, origin_column);
            self.paint_inline_highlights(
                scene,
                content_row_bounds,
                text,
                &row.inline_highlights,
                origin_column,
            );
            self.paint_code_text(
                scene,
                content_row_bounds,
                text,
                &row.syntax_tokens,
                origin_column,
            );
            self.paint_diagnostics(
                scene,
                content_row_bounds,
                source_row,
                text,
                line.start_byte..line.end_byte,
                origin_column,
            );
            self.paint_ghost_text(
                scene,
                content_row_bounds,
                source_row,
                visual_row,
                text,
                origin_column,
            );
            self.paint_composition_and_caret(
                scene,
                content_row_bounds,
                source_row,
                visual_row,
                text,
                origin_column,
            );
        });
    }
}

impl Component for CodeEditor<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("CodeEditor").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        let paint_bounds = self.bounds.intersection(self.paint_viewport);
        if paint_bounds.is_empty() {
            return;
        }
        let layout = self.layout();
        scene.with_clip(paint_bounds, |scene| {
            scene.draw_rect(PaintRect::new(self.bounds, self.style.surface()));
            self.paint_header(scene, layout);
            let visible = self.visible_row_range();
            for visual_row in self.painted_row_range(layout) {
                let Some(line) = self.visual_projection.line(self.rows, visual_row) else {
                    continue;
                };
                let Some(row) = self.rows.row(line.row_index) else {
                    continue;
                };
                let visible_row = visual_row.saturating_sub(visible.start);
                self.paint_row(scene, layout, visible_row, visual_row, line, row);
            }
        });
    }
}

#[cfg(test)]
#[path = "code_editor_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "code_editor_core_conformance_tests.rs"]
mod core_conformance_tests;
