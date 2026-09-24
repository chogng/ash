//! Side-by-side and unified diff projections composed from shared CodeEditor viewports.

use std::collections::BTreeSet;
use std::ops::Range;

use ash_diff::DiffRowKind;
use zui::ui::{
    AccessibilityRole, Component, ComponentContext, ComponentElement, ComputedElement, Element,
    ElementId, PaintRect, Point, Rect, UiNode, UiScene,
};

pub use self::document::DiffEditorDocument;
use self::layout::{DiffEditorLayout, build_layout};
pub use self::style::{DiffEditorPalette, DiffEditorStyle};
use self::unified::UnifiedDiffRows;
use crate::code_editor::{
    CodeEditor, CodeEditorHeader, CodeEditorInlineHighlight, CodeEditorRow, CodeEditorRowSource,
    CodeEditorViewport,
};

const DIVIDER_WIDTH: f32 = 1.0;

mod document;
mod layout;
mod style;
mod unified;

/// The source side represented by a DiffEditor pane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffEditorSide {
    Original,
    Modified,
}

/// Named layout variants for a read-only diff surface.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DiffEditorPresentation {
    /// Two synchronized CodeEditor panes for surfaces with enough horizontal space.
    #[default]
    SideBySide,
    /// One CodeEditor that stacks removed and added rows for narrow embedded surfaces.
    Unified,
}

/// Persistent viewport state retained by the editor host while this document is inactive.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DiffEditorState {
    first_visible_row: usize,
    original_horizontal_column: usize,
    modified_horizontal_column: usize,
    expanded_unchanged_regions: BTreeSet<usize>,
}

impl DiffEditorState {
    pub const fn first_visible_row(&self) -> usize {
        self.first_visible_row
    }

    pub const fn horizontal_column(&self, side: DiffEditorSide) -> usize {
        match side {
            DiffEditorSide::Original => self.original_horizontal_column,
            DiffEditorSide::Modified => self.modified_horizontal_column,
        }
    }

    pub fn set_horizontal_column(&mut self, side: DiffEditorSide, column: usize) {
        match side {
            DiffEditorSide::Original => self.original_horizontal_column = column,
            DiffEditorSide::Modified => self.modified_horizontal_column = column,
        }
    }

    pub fn scroll_rows(&mut self, delta: isize, row_count: usize, visible_row_capacity: usize) {
        let mut viewport = CodeEditorViewport::new(self.first_visible_row);
        viewport.scroll_rows(delta, row_count, visible_row_capacity);
        self.first_visible_row = viewport.first_visible_row();
    }

    pub fn clamp(&mut self, row_count: usize, visible_row_capacity: usize) {
        let mut viewport = CodeEditorViewport::new(self.first_visible_row);
        viewport.clamp(row_count, visible_row_capacity);
        self.first_visible_row = viewport.first_visible_row();
    }

    /// Expands one stable unchanged-region ordinal from the current DiffDocument.
    pub fn expand_unchanged_region(&mut self, region_index: usize) {
        self.expanded_unchanged_regions.insert(region_index);
    }

    /// Collapses one stable unchanged-region ordinal from the current DiffDocument.
    pub fn collapse_unchanged_region(&mut self, region_index: usize) {
        self.expanded_unchanged_regions.remove(&region_index);
    }

    /// Toggles one stable unchanged-region ordinal from the current DiffDocument.
    pub fn toggle_unchanged_region(&mut self, region_index: usize) {
        if !self.expanded_unchanged_regions.remove(&region_index) {
            self.expanded_unchanged_regions.insert(region_index);
        }
    }

    pub fn is_unchanged_region_expanded(&self, region_index: usize) -> bool {
        self.expanded_unchanged_regions.contains(&region_index)
    }

    fn expanded_unchanged_regions(&self) -> impl Iterator<Item = usize> + '_ {
        self.expanded_unchanged_regions.iter().copied()
    }

    fn viewport(&self, side: DiffEditorSide) -> CodeEditorViewport {
        CodeEditorViewport::new(self.first_visible_row)
            .with_horizontal_column(self.horizontal_column(side))
    }
}

/// Labels rendered above the original and modified CodeEditor panes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffEditorLabels<'a> {
    original: &'a str,
    modified: &'a str,
}

impl<'a> DiffEditorLabels<'a> {
    pub const fn new(original: &'a str, modified: &'a str) -> Self {
        Self { original, modified }
    }

    const fn for_side(self, side: DiffEditorSide) -> &'a str {
        match side {
            DiffEditorSide::Original => self.original,
            DiffEditorSide::Modified => self.modified,
        }
    }
}

/// A mapped source location under a point in the visible DiffEditor body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffEditorLocation {
    pub side: DiffEditorSide,
    pub row_index: usize,
    pub line_number: Option<usize>,
}

struct DiffSideRows<'a> {
    document: &'a DiffEditorDocument,
    side: DiffEditorSide,
    style: &'a DiffEditorStyle,
}

impl CodeEditorRowSource for DiffSideRows<'_> {
    fn row_count(&self) -> usize {
        self.document.diff().rows().len()
    }

    fn largest_line_number(&self) -> usize {
        match self.side {
            DiffEditorSide::Original => self.document.diff().old_line_count(),
            DiffEditorSide::Modified => self.document.diff().new_line_count(),
        }
    }

    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>> {
        let row = self.document.diff().rows().get(index)?;
        let syntax_tokens = match self.side {
            DiffEditorSide::Original => row.old(),
            DiffEditorSide::Modified => row.new_line(),
        }
        .map(|line| self.document.syntax_tokens(self.side, line.number()))
        .unwrap_or_default();
        Some(project_row(row, self.side, self.style, true, syntax_tokens))
    }
}

/// Whether an unchanged-region control currently reveals its source lines.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffEditorFoldState {
    Collapsed,
    Expanded,
}

/// One visible unchanged-region control and its hit-test geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiffEditorFoldControl {
    region_index: usize,
    line_count: usize,
    bounds: Rect,
    state: DiffEditorFoldState,
}

impl DiffEditorFoldControl {
    pub const fn region_index(self) -> usize {
        self.region_index
    }

    pub const fn line_count(self) -> usize {
        self.line_count
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn state(self) -> DiffEditorFoldState {
        self.state
    }
}

/// Read-only diff composition built from shared [`CodeEditor`] viewports.
///
/// The host owns file identity, diff computation, active-tab selection, input routing, and the
/// retained [`DiffEditorState`]. DiffEditor owns row projection, synchronized vertical position,
/// side-specific decorations, and the selected [`DiffEditorPresentation`].
pub struct DiffEditor<'a> {
    bounds: Rect,
    paint_viewport: Rect,
    document: &'a DiffEditorDocument,
    state: DiffEditorState,
    labels: DiffEditorLabels<'a>,
    style: DiffEditorStyle,
    presentation: DiffEditorPresentation,
    identity: Option<ElementId>,
}

impl<'a> DiffEditor<'a> {
    pub fn new(
        bounds: Rect,
        document: &'a DiffEditorDocument,
        state: DiffEditorState,
        labels: DiffEditorLabels<'a>,
        style: DiffEditorStyle,
    ) -> Self {
        Self {
            bounds,
            paint_viewport: bounds,
            document,
            state,
            labels,
            style,
            presentation: DiffEditorPresentation::SideBySide,
            identity: None,
        }
    }

    /// Selects a named diff geometry without changing the document or retained state.
    pub const fn with_presentation(mut self, presentation: DiffEditorPresentation) -> Self {
        self.presentation = presentation;
        self
    }

    /// Associates the diff body with a stable inspection and interaction identity.
    pub const fn with_identity(mut self, identity: ElementId) -> Self {
        self.identity = Some(identity);
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    /// Limits both code panes to the visible host viewport without changing document geometry.
    pub const fn within_viewport(mut self, viewport: Rect) -> Self {
        self.paint_viewport = viewport;
        self
    }

    pub fn visible_row_capacity(&self) -> usize {
        match self.presentation {
            DiffEditorPresentation::SideBySide => {
                let rows = self.rows(DiffEditorSide::Original);
                self.code_editor(DiffEditorSide::Original, &rows)
                    .visible_row_capacity()
            }
            DiffEditorPresentation::Unified => {
                let rows = self.unified_rows();
                self.unified_code_editor(&rows).visible_row_capacity()
            }
        }
    }

    pub fn content_height(&self) -> f32 {
        match self.presentation {
            DiffEditorPresentation::SideBySide => CodeEditor::content_height_for_rows(
                CodeEditorHeader::Label(self.labels.original),
                self.document.diff().rows().len(),
                self.style.code_editor(),
            ),
            DiffEditorPresentation::Unified => CodeEditor::content_height_for_rows(
                CodeEditorHeader::Hidden,
                self.document.unified_row_count(&self.state),
                self.style.code_editor(),
            ),
        }
    }

    pub fn visible_row_range(&self) -> Range<usize> {
        match self.presentation {
            DiffEditorPresentation::SideBySide => {
                let rows = self.rows(DiffEditorSide::Original);
                self.code_editor(DiffEditorSide::Original, &rows)
                    .visible_row_range()
            }
            DiffEditorPresentation::Unified => {
                let rows = self.unified_rows();
                self.unified_code_editor(&rows).visible_row_range()
            }
        }
    }

    /// Returns visible fold controls for host-owned input and accessibility routing.
    pub fn fold_controls(&self) -> Vec<DiffEditorFoldControl> {
        if self.presentation != DiffEditorPresentation::Unified {
            return Vec::new();
        }
        let rows = self.unified_rows();
        let editor = self.unified_code_editor(&rows);
        let visible = editor.visible_row_range();
        let visible_start = visible.start;
        let row_height = self.style.code_editor().row_height();
        visible
            .filter_map(|visual_row| {
                let (region, expanded) = rows.fold_at(visual_row)?;
                let bounds = Rect::from_xywh(
                    self.bounds.origin.x,
                    self.bounds.origin.y
                        + visual_row.saturating_sub(visible_start) as f32 * row_height,
                    self.bounds.size.width,
                    row_height,
                )
                .intersection(self.paint_viewport);
                (!bounds.is_empty()).then_some(DiffEditorFoldControl {
                    region_index: region.index,
                    line_count: region.source_rows.len(),
                    bounds,
                    state: if expanded {
                        DiffEditorFoldState::Expanded
                    } else {
                        DiffEditorFoldState::Collapsed
                    },
                })
            })
            .collect()
    }

    pub fn location_at(&self, point: Point) -> Option<DiffEditorLocation> {
        if self.presentation == DiffEditorPresentation::Unified {
            let rows = self.unified_rows();
            let location = self.unified_code_editor(&rows).location_at(point)?;
            return Some(DiffEditorLocation {
                side: rows.side_at(location.row_index)?,
                row_index: location.row_index,
                line_number: location.line_number,
            });
        }
        let layout = self.layout();
        let side = if layout.original.contains(point) {
            DiffEditorSide::Original
        } else if layout.modified.contains(point) {
            DiffEditorSide::Modified
        } else {
            return None;
        };
        let rows = self.rows(side);
        let location = self.code_editor(side, &rows).location_at(point)?;
        Some(DiffEditorLocation {
            side,
            row_index: location.row_index,
            line_number: location.line_number,
        })
    }

    fn layout(&self) -> DiffEditorLayout {
        build_layout(self.bounds)
    }

    fn rows(&self, side: DiffEditorSide) -> DiffSideRows<'_> {
        DiffSideRows {
            document: self.document,
            side,
            style: &self.style,
        }
    }

    fn unified_rows(&self) -> UnifiedDiffRows<'_> {
        UnifiedDiffRows::new(self.document, &self.state, &self.style)
    }

    fn code_editor<'rows>(
        &'rows self,
        side: DiffEditorSide,
        rows: &'rows DiffSideRows<'_>,
    ) -> CodeEditor<'rows> {
        let layout = self.layout();
        let bounds = match side {
            DiffEditorSide::Original => layout.original,
            DiffEditorSide::Modified => layout.modified,
        };
        CodeEditor::new(
            bounds,
            rows,
            self.state.viewport(side),
            CodeEditorHeader::Label(self.labels.for_side(side)),
            self.style.code_editor().clone(),
        )
        .within_viewport(self.paint_viewport)
    }

    fn unified_code_editor<'rows>(
        &'rows self,
        rows: &'rows UnifiedDiffRows<'_>,
    ) -> CodeEditor<'rows> {
        CodeEditor::new(
            self.bounds,
            rows,
            self.state.viewport(DiffEditorSide::Modified),
            CodeEditorHeader::Hidden,
            self.style.code_editor().clone(),
        )
        .within_viewport(self.paint_viewport)
    }
}

impl Component for DiffEditor<'_> {
    fn element(&self) -> ComponentElement {
        let element = Element::leaf("DiffEditor").in_bounds(self.bounds);
        match self.identity {
            Some(identity) => element.with_identity(identity),
            None => element,
        }
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        self.identity.map(|identity| {
            UiNode::new(
                identity,
                element.bounds(),
                AccessibilityRole::Group,
                "Diff contents",
            )
        })
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        let paint_bounds = element.bounds().intersection(self.paint_viewport);
        if paint_bounds.is_empty() {
            return;
        }
        match self.presentation {
            DiffEditorPresentation::SideBySide => {
                let layout = self.layout();
                let original_rows = self.rows(DiffEditorSide::Original);
                let modified_rows = self.rows(DiffEditorSide::Modified);
                context.with_clip(paint_bounds, |context| {
                    context.draw_component(
                        &self.code_editor(DiffEditorSide::Original, &original_rows),
                    );
                    context.draw_component(
                        &self.code_editor(DiffEditorSide::Modified, &modified_rows),
                    );
                    context
                        .scene_mut()
                        .draw_rect(PaintRect::new(layout.divider, self.style.divider()));
                });
            }
            DiffEditorPresentation::Unified => {
                let rows = self.unified_rows();
                context.with_clip(paint_bounds, |context| {
                    context.draw_component(&self.unified_code_editor(&rows));
                });
            }
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        let paint_bounds = self.bounds.intersection(self.paint_viewport);
        if paint_bounds.is_empty() {
            return;
        }
        match self.presentation {
            DiffEditorPresentation::SideBySide => {
                let layout = self.layout();
                let original_rows = self.rows(DiffEditorSide::Original);
                let modified_rows = self.rows(DiffEditorSide::Modified);
                scene.with_clip(paint_bounds, |scene| {
                    scene.draw_component(
                        &self.code_editor(DiffEditorSide::Original, &original_rows),
                    );
                    scene.draw_component(
                        &self.code_editor(DiffEditorSide::Modified, &modified_rows),
                    );
                    scene.draw_rect(PaintRect::new(layout.divider, self.style.divider()));
                });
            }
            DiffEditorPresentation::Unified => {
                let rows = self.unified_rows();
                scene.draw_component(&self.unified_code_editor(&rows));
            }
        }
    }
}

pub(super) fn project_row<'a>(
    row: &'a ash_diff::DiffRow,
    side: DiffEditorSide,
    style: &DiffEditorStyle,
    allow_placeholder: bool,
    syntax_tokens: &[crate::CodeEditorSyntaxToken],
) -> CodeEditorRow<'a> {
    let line = match side {
        DiffEditorSide::Original => row.old(),
        DiffEditorSide::Modified => row.new_line(),
    };
    let background = style.line_background(row.kind(), side, line.is_some());
    let Some(line) = line else {
        debug_assert!(allow_placeholder);
        return CodeEditorRow::placeholder().with_background(background);
    };
    let mut code_row = CodeEditorRow::new(line.number(), line.text())
        .with_background(background)
        .with_syntax_tokens(syntax_tokens.to_vec());
    if let Some(marker) = change_marker(row.kind(), side) {
        code_row = code_row.with_marker(marker, style.marker_color(side));
    }
    let inline_color = style.inline_color(side);
    let highlights = row
        .inline_changes()
        .iter()
        .filter_map(|change| {
            let range = match side {
                DiffEditorSide::Original => change.old_range(),
                DiffEditorSide::Modified => change.new_range(),
            };
            (!range.is_empty()).then(|| CodeEditorInlineHighlight::new(range, inline_color))
        })
        .collect();
    code_row.with_inline_highlights(highlights)
}

fn change_marker(kind: DiffRowKind, side: DiffEditorSide) -> Option<&'static str> {
    match (kind, side) {
        (DiffRowKind::Added, DiffEditorSide::Modified)
        | (DiffRowKind::Modified, DiffEditorSide::Modified) => Some("+"),
        (DiffRowKind::Removed, DiffEditorSide::Original)
        | (DiffRowKind::Modified, DiffEditorSide::Original) => Some("−"),
        _ => None,
    }
}

#[cfg(test)]
#[path = "diff_editor_tests.rs"]
mod tests;
