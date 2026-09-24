//! Vertically scrollable composition of multiple file DiffEditors.

use std::cell::OnceCell;
use std::ops::Range;
use std::time::Duration;

use ash_ui_components::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarStyle, ActionViewItem,
    ButtonSelection, ButtonState, ButtonStyle, InteractionRegion, ListContentPadding,
    ListScrollAnchor, ScrollAxis, ScrollCommand, ScrollMetrics, ScrollState, ScrollView,
    ScrollViewStyle, ScrollbarLayout, ScrollbarPresentation, ScrollbarStyle, VirtualListLayout,
};
use zui::ui::{
    AccessibilityExpansion, AccessibilityRole, AnimationEasing, Border, Color, Component,
    ComponentContext, ComponentElement, ComputedElement, CornerRadii, CursorFeedback, Edges,
    Element, ElementId, FocusBehavior, FontFamily, FontWeight, FrameInvalidation, Icon,
    NavigationAxis, NavigationGroupId, NodeAction, PaintIcon, PaintRect, Point, Rect,
    ScalarAnimationSpec, TextBlock, TextStyle, UiNode, UiScene,
};

mod identity;

pub use self::identity::MultiDiffEditorItemIdentity;

use crate::{
    DiffEditor, DiffEditorDocument, DiffEditorFoldState, DiffEditorLabels, DiffEditorPresentation,
    DiffEditorState, DiffEditorStyle,
};

const DEFAULT_SECTION_GAP: f32 = 8.0;
const FILE_HEADER_HEIGHT: f32 = 32.0;
const FILE_HEADER_PADDING: f32 = 10.0;
const FILE_HEADER_ICON_SIZE: f32 = 14.0;
const FILE_HEADER_ACTION_SIZE: f32 = 26.0;
const CARD_INSET: f32 = 8.0;
const CARD_PADDING: f32 = 8.0;
const CARD_BORDER_WIDTH: f32 = 1.0;
const CARD_CORNER_RADIUS: f32 = 6.0;
const MULTI_DIFF_FOLD_SCOPE: u32 = 4;
const FOLD_ANIMATION_DURATION: Duration = Duration::from_millis(140);

fn fold_animation_spec() -> ScalarAnimationSpec {
    ScalarAnimationSpec::new(
        FOLD_ANIMATION_DURATION,
        AnimationEasing::EaseInOut,
        FrameInvalidation::Rebuild,
    )
}

/// One file section projected by [`MultiDiffEditor`].
///
/// Product hosts retain file identity, document lifetime, and the per-file
/// [`DiffEditorState`]. This borrowed item only binds them for one presentation.
#[derive(Clone)]
pub struct MultiDiffEditorItem<'a> {
    file_name: &'a str,
    document: &'a DiffEditorDocument,
    editor_state: DiffEditorState,
    labels: DiffEditorLabels<'a>,
    identity: Option<MultiDiffEditorItemIdentity>,
    expanded: bool,
    disclosure_icon: Option<Icon>,
    header_actions: Vec<MultiDiffEditorHeaderAction>,
}

/// One host-owned action painted in a multi-diff file header.
#[derive(Clone, Debug, PartialEq)]
pub struct MultiDiffEditorHeaderAction {
    identity: ElementId,
    icon: Icon,
    label: String,
    state: ButtonState,
    selection: ButtonSelection,
}

impl MultiDiffEditorHeaderAction {
    pub fn new(
        identity: ElementId,
        icon: Icon,
        label: impl Into<String>,
        state: ButtonState,
    ) -> Self {
        Self {
            identity,
            icon,
            label: label.into(),
            state,
            selection: ButtonSelection::Unselected,
        }
    }

    pub const fn with_selection(mut self, selection: ButtonSelection) -> Self {
        self.selection = selection;
        self
    }
}

impl<'a> MultiDiffEditorItem<'a> {
    pub const fn new(
        file_name: &'a str,
        document: &'a DiffEditorDocument,
        editor_state: DiffEditorState,
        labels: DiffEditorLabels<'a>,
    ) -> Self {
        Self {
            file_name,
            document,
            editor_state,
            labels,
            identity: None,
            expanded: true,
            disclosure_icon: None,
            header_actions: Vec::new(),
        }
    }

    /// Associates the item with the host-owned identity of the represented changed file.
    ///
    /// Standalone callers may omit this during compatibility migration; product hosts that
    /// reorder or retain changed-file snapshots must provide it.
    pub const fn with_identity(mut self, identity: MultiDiffEditorItemIdentity) -> Self {
        self.identity = Some(identity);
        self
    }

    pub const fn file_name(&self) -> &'a str {
        self.file_name
    }

    pub const fn identity(&self) -> Option<MultiDiffEditorItemIdentity> {
        self.identity
    }

    /// Sets the retained file-body expansion and the matching disclosure icon.
    pub const fn with_expansion(mut self, expanded: bool, disclosure_icon: Icon) -> Self {
        self.expanded = expanded;
        self.disclosure_icon = Some(disclosure_icon);
        self
    }

    /// Supplies product-owned actions for the right side of the file header.
    pub fn with_header_actions(
        mut self,
        actions: impl IntoIterator<Item = MultiDiffEditorHeaderAction>,
    ) -> Self {
        self.header_actions = actions.into_iter().collect();
        self
    }
}

/// One visible per-file unchanged-region control for product input routing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MultiDiffEditorFoldControl {
    item_index: usize,
    item_identity: MultiDiffEditorItemIdentity,
    region_index: usize,
    line_count: usize,
    bounds: Rect,
    state: DiffEditorFoldState,
}

impl MultiDiffEditorFoldControl {
    pub const fn item_index(self) -> usize {
        self.item_index
    }

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

    /// Returns the stable interaction identity used by this fold control.
    pub fn element_id(self) -> Option<ElementId> {
        self.item_identity.fold_id(self.region_index)
    }
}

/// Reusable section metrics for one exact item/state snapshot and diff presentation.
///
/// Product hosts that process high-frequency scrolling may retain this value until items or their
/// [`DiffEditorState`] change, avoiding repeated measurement for every input delta.
#[derive(Clone, Debug, PartialEq)]
pub struct MultiDiffEditorLayout {
    sections: VirtualListLayout,
    presentation: DiffEditorPresentation,
}

impl MultiDiffEditorLayout {
    pub fn content_height(&self) -> f32 {
        self.sections.content_extent()
    }

    pub fn section_count(&self) -> usize {
        self.sections.item_count()
    }

    pub fn section_extent(&self, index: usize) -> Option<f32> {
        self.sections.item_extent(index)
    }

    /// Copies retained section extents for host-side changed-file snapshot reconciliation.
    pub fn section_extents(&self) -> Vec<f32> {
        self.sections.item_extents()
    }

    /// Updates one retained section measurement without rebuilding unrelated cumulative geometry.
    pub fn update_section_extent(&mut self, index: usize, extent: f32) -> Option<f32> {
        self.sections.update_item_extent(index, extent)
    }

    /// Replaces one contiguous changed-file range without rebuilding unrelated section geometry.
    pub fn splice_section_extents(
        &mut self,
        range: Range<usize>,
        replacements: impl IntoIterator<Item = f32>,
    ) {
        self.sections.splice_item_extents(range, replacements);
    }

    /// Captures the first section intersecting the current viewport offset.
    pub fn scroll_anchor(&self, scroll_offset: f32) -> Option<ListScrollAnchor> {
        self.sections.scroll_anchor(scroll_offset)
    }

    /// Resolves the logical offset that keeps a captured section at the same viewport position.
    pub fn command_for_anchor(&self, anchor: ListScrollAnchor) -> Option<ScrollCommand> {
        self.sections.command_for_anchor(anchor)
    }
}

impl Default for MultiDiffEditorLayout {
    fn default() -> Self {
        Self {
            sections: VirtualListLayout::variable([]),
            presentation: DiffEditorPresentation::default(),
        }
    }
}

/// Visual tokens and section geometry owned by [`MultiDiffEditor`].
#[derive(Clone, Debug, PartialEq)]
pub struct MultiDiffEditorStyle {
    surface: Color,
    file_header: Color,
    divider: Color,
    file_name: TextStyle,
    diff_editor: DiffEditorStyle,
    header_button: ButtonStyle,
    header_icon: Color,
    scroll_view: ScrollViewStyle,
    section_gap: f32,
    section_horizontal_inset: f32,
    content_vertical_padding: f32,
    section_border_width: f32,
    section_corner_radii: CornerRadii,
}

/// Resolved visual inputs used to construct a MultiDiffEditor style.
#[derive(Clone, Debug, PartialEq)]
pub struct MultiDiffEditorPalette {
    pub surface: Color,
    pub file_header: Color,
    pub divider: Color,
    pub file_name: TextStyle,
    pub diff_editor: DiffEditorStyle,
    pub header_button: ButtonStyle,
    pub header_icon: Color,
    pub scroll_view: ScrollViewStyle,
}

impl MultiDiffEditorStyle {
    pub fn light() -> Self {
        Self::new(MultiDiffEditorPalette {
            surface: Color::WHITE,
            file_header: Color::rgb(246, 246, 247),
            divider: Color::rgb(222, 222, 224),
            file_name: TextStyle::new(12.0, Color::rgb(38, 38, 41))
                .with_family(FontFamily::Monospace)
                .with_weight(FontWeight::Bold)
                .with_line_height(18.0),
            diff_editor: DiffEditorStyle::light(),
            header_button: ButtonStyle::new(
                ash_ui_components::ButtonBackgrounds::new(Color::TRANSPARENT)
                    .with_hovered(Color::rgb(232, 232, 232))
                    .with_focused(Color::rgb(235, 235, 237))
                    .with_pressed(Color::rgb(222, 222, 224)),
                TextStyle::new(12.0, Color::rgb(38, 38, 41)),
            )
            .with_padding(Edges::uniform(5.0))
            .with_icon_size(FILE_HEADER_ICON_SIZE)
            .with_corner_radii(CornerRadii::uniform(4.0)),
            header_icon: Color::rgb(72, 72, 78),
            scroll_view: ScrollViewStyle::new(
                ScrollbarStyle::new(Color::TRANSPARENT, Color::rgba(126, 126, 132, 128))
                    .with_hovered_colors(
                        Color::rgba(230, 230, 232, 96),
                        Color::rgba(104, 104, 110, 184),
                    )
                    .with_active_colors(
                        Color::rgba(222, 222, 225, 128),
                        Color::rgba(82, 82, 88, 220),
                    ),
            ),
        })
    }

    pub fn new(palette: MultiDiffEditorPalette) -> Self {
        Self {
            surface: palette.surface,
            file_header: palette.file_header,
            divider: palette.divider,
            file_name: palette.file_name,
            diff_editor: palette.diff_editor,
            header_button: palette.header_button,
            header_icon: palette.header_icon,
            scroll_view: palette.scroll_view,
            section_gap: DEFAULT_SECTION_GAP,
            section_horizontal_inset: 0.0,
            content_vertical_padding: 0.0,
            section_border_width: 0.0,
            section_corner_radii: CornerRadii::uniform(0.0),
        }
    }

    /// Light presentation with inset, bordered file cards for narrow drawers.
    pub fn light_cards() -> Self {
        Self::light().cards()
    }

    /// Applies the inset, border, and corner geometry used by narrow drawer cards.
    pub fn cards(self) -> Self {
        Self {
            section_horizontal_inset: CARD_INSET,
            content_vertical_padding: CARD_PADDING,
            section_border_width: CARD_BORDER_WIDTH,
            section_corner_radii: CornerRadii::uniform(CARD_CORNER_RADIUS),
            ..self
        }
    }

    /// Returns whether retained section measurements remain valid after a style change.
    pub fn same_layout_as(&self, other: &Self) -> bool {
        self.diff_editor.same_layout_as(&other.diff_editor)
            && self.section_gap == other.section_gap
            && self.section_horizontal_inset == other.section_horizontal_inset
            && self.content_vertical_padding == other.content_vertical_padding
            && self.section_border_width == other.section_border_width
    }
}

/// A scrollable editor surface that presents all changed files in one document.
///
/// Each visible section delegates its body to [`DiffEditor`]. The host owns the
/// item collection, per-file states, scrolling input, persistence, and the
/// side-by-side or unified presentation selected for the available surface.
pub struct MultiDiffEditor<'a> {
    bounds: Rect,
    items: &'a [MultiDiffEditorItem<'a>],
    state: ScrollState,
    style: MultiDiffEditorStyle,
    scrollbar_presentation: ScrollbarPresentation,
    diff_presentation: DiffEditorPresentation,
    identity: Option<ElementId>,
    scrollbar_identity: Option<ElementId>,
    section_layout: OnceCell<VirtualListLayout>,
    measured_layout: Option<&'a MultiDiffEditorLayout>,
}

impl<'a> MultiDiffEditor<'a> {
    pub fn new(
        bounds: Rect,
        items: &'a [MultiDiffEditorItem<'a>],
        state: ScrollState,
        style: MultiDiffEditorStyle,
    ) -> Self {
        Self {
            bounds,
            items,
            state,
            style,
            scrollbar_presentation: ScrollbarPresentation::default(),
            diff_presentation: DiffEditorPresentation::SideBySide,
            identity: None,
            scrollbar_identity: None,
            section_layout: OnceCell::new(),
            measured_layout: None,
        }
    }

    /// Associates the editor surface with the host's stable interaction identity.
    pub const fn with_identity(mut self, identity: ElementId) -> Self {
        self.identity = Some(identity);
        self
    }

    /// Associates the component-owned scrollbar semantics with a host identity.
    pub const fn with_scrollbar_identity(mut self, identity: ElementId) -> Self {
        self.scrollbar_identity = Some(identity);
        self
    }

    /// Returns the stable identity for one visible unchanged-region control.
    pub fn fold_element_id(item_index: usize, region_index: usize) -> Option<ElementId> {
        let item_index = u16::try_from(item_index).ok()?;
        let region_index = u16::try_from(region_index).ok()?;
        let local = ((u32::from(item_index) << 16) | u32::from(region_index)).checked_add(1)?;
        Some(ElementId::scoped(MULTI_DIFF_FOLD_SCOPE, local))
    }

    fn item_identity(
        item_index: usize,
        item: &MultiDiffEditorItem<'_>,
    ) -> MultiDiffEditorItemIdentity {
        item.identity().unwrap_or_else(|| {
            MultiDiffEditorItemIdentity::from_slot(
                u32::try_from(item_index)
                    .ok()
                    .and_then(|index| index.checked_add(1))
                    .expect("multi-diff item index must fit its compatibility identity"),
            )
        })
    }

    /// Selects the layout used by every visible per-file DiffEditor.
    pub fn with_diff_presentation(mut self, presentation: DiffEditorPresentation) -> Self {
        self.diff_presentation = presentation;
        self.section_layout.take();
        self.measured_layout = None;
        self
    }

    /// Reuses metrics previously returned by [`Self::measure_layout`].
    ///
    /// The host must invalidate the layout when item order, documents, per-file state, style, or
    /// presentation changes.
    pub fn with_measured_layout(mut self, layout: &'a MultiDiffEditorLayout) -> Self {
        debug_assert_eq!(layout.sections.item_count(), self.items.len());
        debug_assert_eq!(layout.presentation, self.diff_presentation);
        self.measured_layout = Some(layout);
        self
    }

    pub const fn with_scrollbar_presentation(
        mut self,
        presentation: ScrollbarPresentation,
    ) -> Self {
        self.scrollbar_presentation = presentation;
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn content_height(&self) -> f32 {
        if let Some(layout) = self.measured_layout {
            return layout.content_height();
        }
        self.section_layout().content_extent()
    }

    pub fn scroll_metrics(&self) -> ScrollMetrics {
        self.scroll_view().metrics()
    }

    /// Measures reusable section geometry for the current items, state, style, and presentation.
    pub fn measure_layout(&self) -> MultiDiffEditorLayout {
        MultiDiffEditorLayout {
            sections: self.section_layout().clone(),
            presentation: self.diff_presentation,
        }
    }

    /// Measures one section for an incremental update of a retained layout.
    pub fn measure_section_extent(&self, index: usize) -> Option<f32> {
        self.items.get(index).map(|item| self.section_height(item))
    }

    /// Returns the visible per-file fold controls after shared scrolling is applied.
    pub fn fold_controls(&self) -> Vec<MultiDiffEditorFoldControl> {
        if self.diff_presentation != DiffEditorPresentation::Unified {
            return Vec::new();
        }
        let viewport = self.scroll_view().viewport();
        let mut controls = Vec::new();
        let section_layout = self.section_layout();
        for item_index in section_layout.visible_range(viewport) {
            let item = &self.items[item_index];
            if !item.expanded {
                continue;
            }
            let item_identity = Self::item_identity(item_index, item);
            let item_bounds = section_layout
                .item_bounds(item_index, viewport)
                .expect("visible multi-diff section");
            let section = self.section_bounds(item_bounds);
            let diff_bounds = self.diff_bounds(section);
            controls.extend(
                DiffEditor::new(
                    diff_bounds,
                    item.document,
                    item.editor_state.clone(),
                    item.labels,
                    self.style.diff_editor.clone(),
                )
                .with_presentation(self.diff_presentation)
                .within_viewport(viewport.bounds())
                .fold_controls()
                .into_iter()
                .map(|control| MultiDiffEditorFoldControl {
                    item_index,
                    item_identity,
                    region_index: control.region_index(),
                    line_count: control.line_count(),
                    bounds: control.bounds(),
                    state: control.state(),
                }),
            );
        }
        controls
    }

    fn section_bounds(&self, item_bounds: Rect) -> Rect {
        Rect::from_xywh(
            item_bounds.origin.x + self.style.section_horizontal_inset,
            item_bounds.origin.y,
            (self.bounds.size.width - self.style.section_horizontal_inset * 2.0).max(0.0),
            item_bounds.size.height,
        )
    }

    pub fn scroll_view(&self) -> ScrollView {
        ScrollView::new(
            self.bounds,
            zui::ui::Size::new(self.bounds.size.width, self.content_height()),
            self.state,
            ScrollAxis::Vertical,
            self.style.scroll_view,
        )
        .with_scrollbar_presentation(self.scrollbar_presentation)
    }

    fn section_height(&self, item: &MultiDiffEditorItem<'_>) -> f32 {
        let body_height = if item.expanded {
            DiffEditor::new(
                Rect::from_xywh(0.0, 0.0, self.bounds.size.width, 0.0),
                item.document,
                item.editor_state.clone(),
                item.labels,
                self.style.diff_editor.clone(),
            )
            .with_presentation(self.diff_presentation)
            .content_height()
        } else {
            0.0
        };
        self.style.section_border_width * 2.0 + FILE_HEADER_HEIGHT + body_height
    }

    fn section_layout(&self) -> &VirtualListLayout {
        if let Some(layout) = self.measured_layout {
            return &layout.sections;
        }
        self.section_layout.get_or_init(|| {
            self.section_layout_from_heights(
                self.items.iter().map(|item| self.section_height(item)),
            )
        })
    }

    fn section_layout_from_heights(
        &self,
        heights: impl IntoIterator<Item = f32>,
    ) -> VirtualListLayout {
        VirtualListLayout::variable(heights)
            .with_item_gap(self.style.section_gap)
            .with_content_padding(ListContentPadding::symmetric(
                self.style.content_vertical_padding,
            ))
    }

    fn animated_section_layout(&self, context: &mut ComponentContext<'_, '_>) -> VirtualListLayout {
        let target_layout = self.section_layout();
        let viewport = self.scroll_view_with_layout(target_layout).viewport();
        let spec = fold_animation_spec();
        let overrides = target_layout
            .visible_range(viewport)
            .map(|item_index| {
                let item = &self.items[item_index];
                let target = target_layout
                    .item_extent(item_index)
                    .expect("visible multi-diff item must have a target height");
                let height = context.bind_scalar(
                    Self::item_identity(item_index, item).fold_animation_key(),
                    target,
                    target,
                    spec,
                );
                (item_index, height)
            })
            .collect::<Vec<_>>();
        target_layout.clone().with_item_extent_overrides(overrides)
    }

    fn diff_bounds(&self, section: Rect) -> Rect {
        let header_bottom = section.origin.y + self.style.section_border_width + FILE_HEADER_HEIGHT;
        Rect::from_xywh(
            section.origin.x + self.style.section_border_width,
            header_bottom,
            (section.size.width - self.style.section_border_width * 2.0).max(0.0),
            (section.bottom() - header_bottom - self.style.section_border_width).max(0.0),
        )
    }

    fn scroll_view_with_layout(&self, layout: &VirtualListLayout) -> ScrollView {
        ScrollView::new(
            self.bounds,
            zui::ui::Size::new(self.bounds.size.width, layout.content_extent()),
            self.state,
            ScrollAxis::Vertical,
            self.style.scroll_view,
        )
        .with_scrollbar_presentation(self.scrollbar_presentation)
    }
}

impl Component for MultiDiffEditor<'_> {
    fn element(&self) -> ComponentElement {
        let element = Element::leaf("MultiDiffEditor").in_bounds(self.bounds);
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
                "Multiple file differences",
            )
        })
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        self.paint_surface(context.scene_mut(), element.bounds());
        if self.bounds.is_empty() {
            return;
        }
        let section_layout = self.animated_section_layout(context);
        let scroll_view = self.scroll_view_with_layout(&section_layout);
        scroll_view.draw_components(context, |context, viewport| {
            for item_index in section_layout.visible_range(viewport) {
                let item = &self.items[item_index];
                let item_identity = Self::item_identity(item_index, item);
                let item_bounds = section_layout
                    .item_bounds(item_index, viewport)
                    .expect("visible multi-diff section");
                let section = MultiDiffSection::new(
                    item_index,
                    item_identity,
                    item,
                    self.section_bounds(item_bounds),
                    self.diff_bounds(self.section_bounds(item_bounds)),
                    viewport.bounds(),
                    self.style.clone(),
                    self.diff_presentation,
                    self.identity
                        .map(NavigationGroupId::new)
                        .unwrap_or_else(|| NavigationGroupId::new(item_identity.section_id())),
                );
                context.draw_component(&section);
            }
        });
        if let Some(identity) = self.scrollbar_identity
            && let Some(scrollbar) = scroll_view.vertical_scrollbar()
        {
            let metrics = scroll_view.metrics();
            let maximum = metrics.maximum_offset().y;
            let percentage = if maximum > 0.0 {
                self.state.vertical_offset() / maximum * 100.0
            } else {
                0.0
            };
            context.draw_component(&MultiDiffScrollbar::new(
                identity,
                scrollbar.layout(),
                percentage,
            ));
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        if self.bounds.is_empty() {
            return;
        }
        self.paint_surface(scene, self.bounds);
        self.scroll_view().draw(scene, |scene, viewport| {
            let section_layout = self.section_layout();
            for item_index in section_layout.visible_range(viewport) {
                let item = &self.items[item_index];
                let item_identity = Self::item_identity(item_index, item);
                let item_bounds = section_layout
                    .item_bounds(item_index, viewport)
                    .expect("visible multi-diff section");
                let section = self.section_bounds(item_bounds);
                scene.draw_rect(
                    PaintRect::new(section, self.style.surface)
                        .with_border(Border::new(
                            Edges::uniform(self.style.section_border_width),
                            self.style.divider,
                        ))
                        .with_corner_radii(self.style.section_corner_radii),
                );
                scene.draw_component(&MultiDiffFileHeader::new(
                    item_identity,
                    section,
                    item.file_name,
                    item.expanded,
                    item.disclosure_icon,
                    &item.header_actions,
                    self.style.clone(),
                    self.identity
                        .map(NavigationGroupId::new)
                        .unwrap_or_else(|| NavigationGroupId::new(item_identity.section_id())),
                ));
                if !item.expanded {
                    continue;
                }
                let diff_bounds = self.diff_bounds(section);
                scene.draw_component(
                    &DiffEditor::new(
                        diff_bounds,
                        item.document,
                        item.editor_state.clone(),
                        item.labels,
                        self.style.diff_editor.clone(),
                    )
                    .with_presentation(self.diff_presentation)
                    .within_viewport(viewport.bounds()),
                );
            }
        });
    }
}

impl MultiDiffEditor<'_> {
    fn paint_surface(&self, scene: &mut UiScene, bounds: Rect) {
        scene.draw_rect(PaintRect::new(bounds, self.style.surface));
    }
}

struct MultiDiffSection<'a> {
    item_index: usize,
    item_identity: MultiDiffEditorItemIdentity,
    item: &'a MultiDiffEditorItem<'a>,
    bounds: Rect,
    diff_bounds: Rect,
    paint_viewport: Rect,
    style: MultiDiffEditorStyle,
    presentation: DiffEditorPresentation,
    navigation_group: NavigationGroupId,
}

impl<'a> MultiDiffSection<'a> {
    #[allow(clippy::too_many_arguments)]
    fn new(
        item_index: usize,
        item_identity: MultiDiffEditorItemIdentity,
        item: &'a MultiDiffEditorItem<'a>,
        bounds: Rect,
        diff_bounds: Rect,
        paint_viewport: Rect,
        style: MultiDiffEditorStyle,
        presentation: DiffEditorPresentation,
        navigation_group: NavigationGroupId,
    ) -> Self {
        Self {
            item_index,
            item_identity,
            item,
            bounds,
            diff_bounds,
            paint_viewport,
            style,
            presentation,
            navigation_group,
        }
    }

    fn section_id(&self) -> ElementId {
        self.item_identity.section_id()
    }

    fn paint_surface(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.surface)
                .with_border(Border::new(
                    Edges::uniform(self.style.section_border_width),
                    self.style.divider,
                ))
                .with_corner_radii(self.style.section_corner_radii),
        );
    }
}

impl Component for MultiDiffSection<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("MultiDiffSection")
            .in_bounds(self.bounds)
            .with_identity(self.section_id())
            .with_inspection_label(format!("Changed file {}", self.item.file_name))
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(UiNode::new(
            self.section_id(),
            element.bounds(),
            AccessibilityRole::Group,
            format!("Changed file {}", self.item.file_name),
        ))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.paint_surface(context.scene_mut());
        context.draw_component(&MultiDiffFileHeader::new(
            self.item_identity,
            self.bounds,
            self.item.file_name,
            self.item.expanded,
            self.item.disclosure_icon,
            &self.item.header_actions,
            self.style.clone(),
            self.navigation_group,
        ));
        if !self.item.expanded {
            return;
        }
        let diff = DiffEditor::new(
            self.diff_bounds,
            self.item.document,
            self.item.editor_state.clone(),
            self.item.labels,
            self.style.diff_editor.clone(),
        )
        .with_presentation(self.presentation)
        .within_viewport(self.paint_viewport)
        .with_identity(self.item_identity.diff_id());
        let fold_controls = diff
            .fold_controls()
            .into_iter()
            .map(|control| MultiDiffEditorFoldControl {
                item_index: self.item_index,
                item_identity: self.item_identity,
                region_index: control.region_index(),
                line_count: control.line_count(),
                bounds: control.bounds(),
                state: control.state(),
            })
            .collect::<Vec<_>>();
        context.draw_component(&diff);
        for control in fold_controls {
            context.draw_component(&MultiDiffFoldControl::new(
                self.item.file_name,
                control,
                self.navigation_group,
            ));
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_surface(scene);
    }
}

struct MultiDiffFileHeader<'a> {
    item_identity: MultiDiffEditorItemIdentity,
    bounds: Rect,
    file_name: &'a str,
    expanded: bool,
    disclosure_icon: Option<Icon>,
    actions: &'a [MultiDiffEditorHeaderAction],
    style: MultiDiffEditorStyle,
    navigation_group: NavigationGroupId,
}

impl<'a> MultiDiffFileHeader<'a> {
    fn new(
        item_identity: MultiDiffEditorItemIdentity,
        section: Rect,
        file_name: &'a str,
        expanded: bool,
        disclosure_icon: Option<Icon>,
        actions: &'a [MultiDiffEditorHeaderAction],
        style: MultiDiffEditorStyle,
        navigation_group: NavigationGroupId,
    ) -> Self {
        let bounds = Rect::from_xywh(
            section.origin.x + style.section_border_width,
            section.origin.y + style.section_border_width,
            (section.size.width - style.section_border_width * 2.0).max(0.0),
            FILE_HEADER_HEIGHT.min(section.size.height),
        );
        Self {
            item_identity,
            bounds,
            file_name,
            expanded,
            disclosure_icon,
            actions,
            style,
            navigation_group,
        }
    }

    fn action_bar(&self) -> ActionBar {
        let width = FILE_HEADER_ACTION_SIZE * self.actions.len() as f32;
        let bounds = Rect::from_xywh(
            (self.bounds.right() - FILE_HEADER_PADDING - width).max(self.bounds.origin.x),
            self.bounds.origin.y + (self.bounds.size.height - FILE_HEADER_ACTION_SIZE) * 0.5,
            width.min(self.bounds.size.width),
            FILE_HEADER_ACTION_SIZE,
        );
        let items = self
            .actions
            .iter()
            .map(|action| {
                ActionBarItem::Action(
                    ActionViewItem::icon(action.icon, action.label.clone(), action.state)
                        .with_selection(action.selection),
                )
            })
            .collect();
        ActionBar::new(
            bounds,
            ActionBarOrientation::Horizontal,
            items,
            ActionBarStyle::new(
                self.style.header_button.clone(),
                zui::ui::Size::new(FILE_HEADER_ACTION_SIZE, FILE_HEADER_ACTION_SIZE),
            ),
        )
    }

    fn paint_contents(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.file_header).with_border(Border::new(
                Edges::new(0.0, 0.0, 1.0, 0.0),
                self.style.divider,
            )),
        );
        let disclosure_width = if let Some(icon) = self.disclosure_icon {
            scene.draw_icon(PaintIcon::new(
                icon,
                Rect::from_xywh(
                    self.bounds.origin.x + FILE_HEADER_PADDING,
                    self.bounds.origin.y + (self.bounds.size.height - FILE_HEADER_ICON_SIZE) * 0.5,
                    FILE_HEADER_ICON_SIZE,
                    FILE_HEADER_ICON_SIZE,
                ),
                self.style.header_icon,
            ));
            FILE_HEADER_ICON_SIZE + 6.0
        } else {
            0.0
        };
        let action_bar = self.action_bar();
        scene.draw_text(TextBlock::new(
            self.file_name,
            Point::new(
                self.bounds.origin.x + FILE_HEADER_PADDING + disclosure_width,
                self.bounds.origin.y + 7.0,
            ),
            zui::ui::Size::new(
                (action_bar.bounds().origin.x
                    - self.bounds.origin.x
                    - FILE_HEADER_PADDING * 2.0
                    - disclosure_width)
                    .max(1.0),
                18.0,
            ),
            self.style.file_name.clone(),
        ));
        scene.draw_component(&action_bar);
    }
}

impl Component for MultiDiffFileHeader<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("MultiDiffFileHeader")
            .in_bounds(self.bounds)
            .with_identity(self.item_identity.header_id())
            .with_inspection_label(self.file_name)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                self.item_identity.header_id(),
                element.bounds(),
                AccessibilityRole::Button,
                format!(
                    "{} {}",
                    if self.expanded { "Collapse" } else { "Expand" },
                    self.file_name
                ),
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(self.navigation_group, NavigationAxis::Vertical)
            .with_expansion(if self.expanded {
                AccessibilityExpansion::Expanded
            } else {
                AccessibilityExpansion::Collapsed
            }),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.paint_contents(context.scene_mut());
        let action_bar = self.action_bar();
        for (index, action) in self.actions.iter().enumerate() {
            let Some(bounds) = action_bar.interactive_item_bounds(index) else {
                continue;
            };
            context.draw_component(
                &InteractionRegion::new(
                    "MultiDiffFileAction",
                    action.identity,
                    bounds,
                    AccessibilityRole::Button,
                    action.label.clone(),
                )
                .with_parent(self.item_identity.header_id())
                .with_cursor(CursorFeedback::Pointer)
                .with_focus(FocusBehavior::TabStop)
                .with_action(NodeAction::Activate)
                .with_navigation(self.navigation_group, NavigationAxis::Horizontal),
            );
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_contents(scene);
    }
}

struct MultiDiffFoldControl<'a> {
    file_name: &'a str,
    control: MultiDiffEditorFoldControl,
    navigation_group: NavigationGroupId,
}

impl<'a> MultiDiffFoldControl<'a> {
    fn new(
        file_name: &'a str,
        control: MultiDiffEditorFoldControl,
        navigation_group: NavigationGroupId,
    ) -> Self {
        Self {
            file_name,
            control,
            navigation_group,
        }
    }

    fn identity(&self) -> ElementId {
        self.control
            .element_id()
            .expect("multi-diff fold index must fit its identity")
    }
}

impl Component for MultiDiffFoldControl<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("MultiDiffFoldControl")
            .in_bounds(self.control.bounds())
            .with_identity(self.identity())
            .with_inspection_label(format!(
                "{} unchanged lines in {}",
                self.control.line_count(),
                self.file_name
            ))
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        let (action, expansion) = match self.control.state() {
            DiffEditorFoldState::Collapsed => ("Show", AccessibilityExpansion::Collapsed),
            DiffEditorFoldState::Expanded => ("Hide", AccessibilityExpansion::Expanded),
        };
        Some(
            UiNode::new(
                self.identity(),
                element.bounds(),
                AccessibilityRole::Button,
                format!(
                    "{action} {} unchanged lines in {}",
                    self.control.line_count(),
                    self.file_name
                ),
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(self.navigation_group, NavigationAxis::Vertical)
            .with_expansion(expansion),
        )
    }

    fn paint(&self, _scene: &mut UiScene) {}
}

struct MultiDiffScrollbar {
    identity: ElementId,
    layout: ScrollbarLayout,
    percentage: f32,
}

impl MultiDiffScrollbar {
    const fn new(identity: ElementId, layout: ScrollbarLayout, percentage: f32) -> Self {
        Self {
            identity,
            layout,
            percentage,
        }
    }
}

impl Component for MultiDiffScrollbar {
    fn element(&self) -> ComponentElement {
        Element::leaf("MultiDiffScrollbar")
            .in_bounds(self.layout.track_bounds())
            .with_identity(self.identity)
            .with_inspection_label("Changed files scrollbar")
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                self.identity,
                element.bounds(),
                AccessibilityRole::ScrollBar,
                "Changed files scrollbar",
            )
            .with_value(format!("{:.0} percent", self.percentage)),
        )
    }

    fn paint(&self, _scene: &mut UiScene) {}
}

#[cfg(test)]
#[path = "multi_diff_editor_tests.rs"]
mod tests;
