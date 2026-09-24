use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Instant;

use ash_editor::{
    DiffEditorDocument, DiffEditorLabels, DiffEditorPresentation, DiffEditorState, MultiDiffEditor,
    MultiDiffEditorHeaderAction, MultiDiffEditorItem, MultiDiffEditorItemIdentity,
    MultiDiffEditorLayout, MultiDiffEditorStyle,
};
use ash_icons::icons;
use ash_ui_components::{
    ButtonSelection, ButtonState, ScrollAxis, ScrollCommand, ScrollDelta, ScrollMetrics,
    ScrollState, ScrollbarController, ScrollbarInteractionOutcome, ScrollbarPresentation,
};
use zui::ui::{
    AccessibilityRole, Border, Component, ComponentContext, ComponentElement, ComputedElement,
    Edges, Element, ElementId, PaintRect, Rect, Size, TextBlock, TextStyle, UiDispatch, UiNode,
    UiScene,
};

use super::ScmDiff;
use super::ScmPaneStyle;
use crate::CHANGES_PANE;
use crate::ChangesActivation;
use crate::ChangesToolbarState;
use crate::MULTI_DIFF_EDITOR;
use crate::MULTI_DIFF_SCROLLBAR;
use crate::ScmStaging;
use crate::toolbar::ChangesToolbar;

const EMPTY_STATE_PADDING: f32 = 12.0;

/// One changed file and the retained state of its DiffEditor section.
pub struct EditorDiff {
    file_name: String,
    original_label: String,
    modified_label: String,
    document: DiffEditorDocument,
    editor_state: DiffEditorState,
    identity: MultiDiffEditorItemIdentity,
    staging: ScmStaging,
    expanded: bool,
}

impl EditorDiff {
    fn item(&self, dispatch: &UiDispatch) -> MultiDiffEditorItem<'_> {
        let action = |index, icon, label, selected| {
            let identity = self
                .identity
                .header_action_id(index)
                .expect("changed-file header action identity");
            MultiDiffEditorHeaderAction::new(
                identity,
                icon,
                label,
                button_state(identity, dispatch),
            )
            .with_selection(if selected {
                ButtonSelection::Selected
            } else {
                ButtonSelection::Unselected
            })
        };
        MultiDiffEditorItem::new(
            &self.file_name,
            &self.document,
            self.editor_state.clone(),
            DiffEditorLabels::new(&self.original_label, &self.modified_label),
        )
        .with_identity(self.identity)
        .with_expansion(
            self.expanded,
            if self.expanded {
                icons::CHEVRON_DOWN
            } else {
                icons::CHEVRON_RIGHT
            },
        )
        .with_header_actions([
            action(0, icons::LINK_EXTERNAL, "Open editor", false),
            action(1, icons::DISCARD, "Discard changes", false),
            action(
                2,
                if self.staging == ScmStaging::Unstaged {
                    icons::CHECK
                } else {
                    icons::REMOVE
                },
                if self.staging == ScmStaging::Unstaged {
                    "Stage changes"
                } else {
                    "Unstage changes"
                },
                self.staging != ScmStaging::Unstaged,
            ),
        ])
    }

    #[allow(
        dead_code,
        reason = "the retained file viewport becomes mutable when MultiDiffEditor input is routed"
    )]
    pub(crate) const fn editor_state_mut(&mut self) -> &mut DiffEditorState {
        &mut self.editor_state
    }
}

/// Product-owned changed-file collection and retained MultiDiffEditor viewport.
pub struct EditorPaneState {
    diffs: Vec<EditorDiff>,
    scroll_state: ScrollState,
    scrollbar: ScrollbarController,
    measured_layout: MultiDiffEditorLayout,
    style: MultiDiffEditorStyle,
    diff_identities: BTreeMap<String, MultiDiffEditorItemIdentity>,
    diff_indices: BTreeMap<MultiDiffEditorItemIdentity, usize>,
    next_identity_slot: u32,
}

impl Default for EditorPaneState {
    fn default() -> Self {
        Self {
            diffs: Vec::new(),
            scroll_state: ScrollState::default(),
            scrollbar: ScrollbarController::default(),
            measured_layout: MultiDiffEditorLayout::default(),
            style: MultiDiffEditorStyle::light_cards(),
            diff_identities: BTreeMap::new(),
            diff_indices: BTreeMap::new(),
            next_identity_slot: 1,
        }
    }
}

pub type ScrollbarPointerOutcome = ScrollbarInteractionOutcome;

impl EditorPaneState {
    pub fn set_style(&mut self, style: MultiDiffEditorStyle) {
        let preserves_layout = self.style.same_layout_as(&style);
        self.style = style;
        if !preserves_layout {
            self.remeasure();
        }
    }

    fn style(&self) -> MultiDiffEditorStyle {
        self.style.clone()
    }

    pub(crate) fn diffs(&self) -> &[EditorDiff] {
        &self.diffs
    }

    #[allow(
        dead_code,
        reason = "the retained file viewport becomes mutable when MultiDiffEditor input is routed"
    )]
    pub(crate) fn diff_mut(&mut self, index: usize) -> Option<&mut EditorDiff> {
        self.diffs.get_mut(index)
    }

    pub fn toggle_fold_for_element(&mut self, id: ElementId) -> bool {
        let Some((identity, region_index)) = MultiDiffEditorItemIdentity::from_fold_id(id) else {
            return false;
        };
        let Some(&index) = self.diff_indices.get(&identity) else {
            return false;
        };
        let diff = &mut self.diffs[index];
        if region_index >= diff.document.diff().rows().len() {
            return false;
        }
        diff.editor_state.toggle_unchanged_region(region_index);
        self.remeasure_section(index);
        true
    }

    pub fn activate(&mut self, id: ElementId) -> Option<ChangesActivation> {
        if let Some(identity) = MultiDiffEditorItemIdentity::from_header_id(id) {
            let &index = self.diff_indices.get(&identity)?;
            self.diffs[index].expanded = !self.diffs[index].expanded;
            self.remeasure_section(index);
            return Some(ChangesActivation::Changed);
        }
        let (identity, action) = MultiDiffEditorItemIdentity::from_header_action_id(id)?;
        let &index = self.diff_indices.get(&identity)?;
        let diff = &self.diffs[index];
        match action {
            0 => Some(ChangesActivation::OpenFile(diff.file_name.clone())),
            1 => Some(ChangesActivation::Discard(vec![diff.file_name.clone()])),
            2 if diff.staging == ScmStaging::Unstaged => {
                Some(ChangesActivation::Stage(vec![diff.file_name.clone()]))
            }
            2 => Some(ChangesActivation::Unstage(vec![diff.file_name.clone()])),
            _ => None,
        }
    }

    pub fn set_all_expanded(&mut self, expanded: bool) {
        if self.diffs.iter().all(|diff| diff.expanded == expanded) {
            return;
        }
        for diff in &mut self.diffs {
            diff.expanded = expanded;
        }
        self.remeasure();
    }

    pub fn replace_diffs(&mut self, diffs: &[ScmDiff]) -> Vec<MultiDiffEditorItemIdentity> {
        let mut next_diffs = Vec::with_capacity(diffs.len());
        for diff in diffs {
            let file_name = diff.path().to_owned();
            next_diffs.push(EditorDiff {
                identity: self.identity_for_path(&file_name),
                file_name,
                original_label: "HEAD".to_string(),
                modified_label: "Working Tree".to_string(),
                document: diff.document().clone(),
                editor_state: DiffEditorState::default(),
                staging: diff.staging(),
                expanded: true,
            });
        }
        self.replace_editor_diffs(next_diffs)
    }

    fn identity_for_path(&mut self, path: &str) -> MultiDiffEditorItemIdentity {
        if let Some(identity) = self.diff_identities.get(path) {
            return *identity;
        }
        let slot = self.next_identity_slot;
        self.next_identity_slot = self
            .next_identity_slot
            .checked_add(1)
            .expect("changed-file identity space exhausted");
        let identity = MultiDiffEditorItemIdentity::from_slot(slot);
        self.diff_identities.insert(path.to_owned(), identity);
        identity
    }

    fn replace_editor_diffs(
        &mut self,
        next_diffs: Vec<EditorDiff>,
    ) -> Vec<MultiDiffEditorItemIdentity> {
        let previous_identities = self
            .diffs
            .iter()
            .map(|diff| diff.identity)
            .collect::<Vec<_>>();
        let previous_extents =
            (!previous_identities.is_empty()).then(|| self.measured_layout.section_extents());
        let anchor = self
            .measured_layout
            .scroll_anchor(self.scroll_state.vertical_offset())
            .and_then(|anchor| {
                previous_identities
                    .get(anchor.item_index())
                    .copied()
                    .map(|identity| (identity, anchor))
            });
        let previous_states = self
            .diffs
            .drain(..)
            .map(|diff| {
                (
                    diff.file_name,
                    (diff.editor_state, diff.identity, diff.expanded),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let next_paths = next_diffs
            .iter()
            .map(|diff| diff.file_name.as_str())
            .collect::<BTreeSet<_>>();
        let removed_identities = previous_states
            .iter()
            .filter_map(|(path, (_, identity, _))| {
                (!next_paths.contains(path.as_str())).then_some(*identity)
            })
            .collect();
        self.diffs = next_diffs
            .into_iter()
            .map(|mut diff| {
                if let Some((state, _, expanded)) = previous_states.get(&diff.file_name) {
                    diff.editor_state = state.clone();
                    diff.expanded = *expanded;
                }
                diff
            })
            .collect();
        self.rebuild_diff_indices();
        self.scrollbar.cancel();
        if previous_identities.is_empty() {
            self.remeasure();
        } else {
            let section_extents = self.measure_section_extents();
            self.reconcile_section_layout(
                &previous_identities,
                previous_extents
                    .as_deref()
                    .expect("non-empty changed-file layout extents"),
                &section_extents,
            );
        }
        if let Some((identity, anchor)) = anchor {
            if let Some(&index) = self.diff_indices.get(&identity) {
                self.restore_scroll_anchor(anchor.with_item_index(index));
            }
        }
        removed_identities
    }

    #[cfg(test)]
    #[allow(
        dead_code,
        reason = "called once the authoritative changed-file snapshot is connected"
    )]
    pub(crate) fn open_diff(
        &mut self,
        file_name: impl Into<String>,
        original_label: impl Into<String>,
        modified_label: impl Into<String>,
        document: ash_diff::DiffDocument,
    ) {
        let file_name = file_name.into();
        let identity = self.identity_for_path(&file_name);
        self.diffs.push(EditorDiff {
            identity,
            file_name,
            original_label: original_label.into(),
            modified_label: modified_label.into(),
            document: DiffEditorDocument::new(document, ash_editor::CodeEditorLanguage::PlainText),
            editor_state: DiffEditorState::default(),
            staging: ScmStaging::Unstaged,
            expanded: true,
        });
        self.rebuild_diff_indices();
        self.remeasure();
    }

    #[cfg(test)]
    pub(crate) fn replace_test_diffs(
        &mut self,
        diffs: Vec<(String, ash_diff::DiffDocument)>,
    ) -> Vec<MultiDiffEditorItemIdentity> {
        let mut next_diffs = Vec::with_capacity(diffs.len());
        for (file_name, document) in diffs {
            next_diffs.push(EditorDiff {
                identity: self.identity_for_path(&file_name),
                file_name,
                original_label: "HEAD".to_string(),
                modified_label: "Working Tree".to_string(),
                document: DiffEditorDocument::new(
                    document,
                    ash_editor::CodeEditorLanguage::PlainText,
                ),
                editor_state: DiffEditorState::default(),
                staging: ScmStaging::Unstaged,
                expanded: true,
            });
        }
        self.replace_editor_diffs(next_diffs)
    }

    fn items(&self, dispatch: &UiDispatch) -> Vec<MultiDiffEditorItem<'_>> {
        self.diffs.iter().map(|diff| diff.item(dispatch)).collect()
    }

    pub fn scroll(&mut self, delta: f32, viewport: Size, now: Instant) -> bool {
        let metrics = ScrollMetrics::new(
            viewport,
            Size::new(viewport.width, self.measured_layout.content_height()),
        );
        let changed = self.scroll_state.apply(
            ScrollCommand::ByPixels(ScrollDelta::vertical(delta)),
            metrics,
            ScrollAxis::Vertical,
        );
        self.scrollbar.activity(now);
        changed
    }

    pub fn scrollbar_pointer_moved(
        &mut self,
        point: zui::ui::Point,
        bounds: Rect,
        now: Instant,
    ) -> ScrollbarPointerOutcome {
        let view = self.scroll_view(bounds);
        self.scrollbar
            .pointer_moved(view, &mut self.scroll_state, point, now)
    }

    pub fn press_scrollbar(
        &mut self,
        point: zui::ui::Point,
        bounds: Rect,
        now: Instant,
    ) -> ScrollbarPointerOutcome {
        let view = self.scroll_view(bounds);
        self.scrollbar
            .press(view, &mut self.scroll_state, point, now)
    }

    pub fn release_scrollbar(
        &mut self,
        point: zui::ui::Point,
        bounds: Rect,
        now: Instant,
    ) -> ScrollbarPointerOutcome {
        let view = self.scroll_view(bounds);
        self.scrollbar.release(view, point, now)
    }

    pub fn scrollbar_pointer_left(&mut self, now: Instant) -> bool {
        self.scrollbar.pointer_left(now)
    }

    pub fn cancel_scrollbar_interaction(&mut self) {
        self.scrollbar.cancel();
    }

    pub fn advance_scrollbar(&mut self, now: Instant) -> bool {
        self.scrollbar.advance(now)
    }

    pub const fn scrollbar_deadline(&self) -> Option<Instant> {
        self.scrollbar.next_deadline()
    }

    pub(crate) fn scrollbar_presentation(&self) -> ScrollbarPresentation {
        self.scrollbar.presentation()
    }

    fn scroll_view(&self, bounds: Rect) -> ash_ui_components::ScrollView {
        let dispatch = UiDispatch::default();
        let items = self.items(&dispatch);
        MultiDiffEditor::new(bounds, &items, self.scroll_state, self.style())
            .with_diff_presentation(DiffEditorPresentation::Unified)
            .with_measured_layout(&self.measured_layout)
            .with_scrollbar_presentation(self.scrollbar.presentation())
            .scroll_view()
    }

    fn remeasure(&mut self) {
        let dispatch = UiDispatch::default();
        let items = self.items(&dispatch);
        self.measured_layout = MultiDiffEditor::new(
            Rect::from_xywh(0.0, 0.0, 1.0, 0.0),
            &items,
            ScrollState::default(),
            self.style(),
        )
        .with_diff_presentation(DiffEditorPresentation::Unified)
        .measure_layout();
    }

    fn measure_section_extents(&self) -> Vec<f32> {
        let dispatch = UiDispatch::default();
        let items = self.items(&dispatch);
        let editor = MultiDiffEditor::new(
            Rect::from_xywh(0.0, 0.0, 1.0, 0.0),
            &items,
            ScrollState::default(),
            self.style(),
        )
        .with_diff_presentation(DiffEditorPresentation::Unified);
        (0..items.len())
            .map(|index| {
                editor
                    .measure_section_extent(index)
                    .expect("changed file must have a section extent")
            })
            .collect()
    }

    fn reconcile_section_layout(
        &mut self,
        previous_identities: &[MultiDiffEditorItemIdentity],
        previous_extents: &[f32],
        section_extents: &[f32],
    ) {
        assert_eq!(
            previous_identities.len(),
            self.measured_layout.section_count(),
            "multi-diff retained layout must match the previous changed-file collection"
        );
        assert_eq!(
            section_extents.len(),
            self.diffs.len(),
            "measured sections must match the next changed-file collection"
        );
        assert_eq!(
            previous_extents.len(),
            previous_identities.len(),
            "retained section extents must match the previous changed-file collection"
        );
        let next_identities = self
            .diffs
            .iter()
            .map(|diff| diff.identity)
            .collect::<Vec<_>>();
        let prefix = previous_identities
            .iter()
            .zip(&next_identities)
            .take_while(|(previous, next)| previous == next)
            .count();
        let suffix_limit = previous_identities
            .len()
            .min(next_identities.len())
            .saturating_sub(prefix);
        let suffix = previous_identities
            .iter()
            .rev()
            .zip(next_identities.iter().rev())
            .take(suffix_limit)
            .take_while(|(previous, next)| previous == next)
            .count();
        let previous_middle_end = previous_identities.len() - suffix;
        let next_middle_end = next_identities.len() - suffix;
        self.measured_layout.splice_section_extents(
            prefix..previous_middle_end,
            section_extents[prefix..next_middle_end].iter().copied(),
        );

        for index in 0..prefix {
            if previous_extents[index] != section_extents[index] {
                self.measured_layout
                    .update_section_extent(index, section_extents[index]);
            }
        }
        for offset in 0..suffix {
            let previous_index = previous_middle_end + offset;
            let next_index = next_middle_end + offset;
            if previous_extents[previous_index] != section_extents[next_index] {
                self.measured_layout
                    .update_section_extent(next_index, section_extents[next_index]);
            }
        }
    }

    fn remeasure_section(&mut self, index: usize) {
        assert_eq!(
            self.measured_layout.section_count(),
            self.diffs.len(),
            "multi-diff retained layout must match the changed-file collection"
        );
        let anchor = self
            .measured_layout
            .scroll_anchor(self.scroll_state.vertical_offset());
        let extent = {
            let dispatch = UiDispatch::default();
            let items = [self.diffs[index].item(&dispatch)];
            MultiDiffEditor::new(
                Rect::from_xywh(0.0, 0.0, 1.0, 0.0),
                &items,
                ScrollState::default(),
                self.style(),
            )
            .with_diff_presentation(DiffEditorPresentation::Unified)
            .measure_section_extent(0)
            .expect("single multi-diff item must have a section extent")
        };
        self.measured_layout
            .update_section_extent(index, extent)
            .expect("changed file must have retained section geometry");
        let Some(anchor) = anchor else {
            return;
        };
        self.restore_scroll_anchor(anchor);
    }

    fn restore_scroll_anchor(&mut self, anchor: ash_ui_components::ListScrollAnchor) {
        let Some(command) = self.measured_layout.command_for_anchor(anchor) else {
            return;
        };
        self.scroll_state.apply(
            command,
            ScrollMetrics::new(
                Size::new(0.0, 0.0),
                Size::new(0.0, self.measured_layout.content_height()),
            ),
            ScrollAxis::Vertical,
        );
    }

    fn rebuild_diff_indices(&mut self) {
        self.diff_indices.clear();
        self.diff_indices.extend(
            self.diffs
                .iter()
                .enumerate()
                .map(|(index, diff)| (diff.identity, index)),
        );
        assert_eq!(
            self.diff_indices.len(),
            self.diffs.len(),
            "changed-file identities must be unique"
        );
    }
}

/// Editor Pane hosting one MultiDiffEditor for all changed files.
pub struct EditorPane<'a> {
    bounds: Rect,
    state: &'a EditorPaneState,
    style: ScmPaneStyle,
    parent: ElementId,
    toolbar: Option<&'a ChangesToolbarState>,
    dispatch: Option<&'a UiDispatch>,
    content_bounds: Option<Rect>,
}

impl<'a> EditorPane<'a> {
    pub const fn new(
        bounds: Rect,
        state: &'a EditorPaneState,
        style: ScmPaneStyle,
        parent: ElementId,
    ) -> Self {
        Self {
            bounds,
            state,
            style,
            parent,
            toolbar: None,
            dispatch: None,
            content_bounds: None,
        }
    }

    pub const fn with_toolbar(
        mut self,
        toolbar: &'a ChangesToolbarState,
        dispatch: &'a UiDispatch,
    ) -> Self {
        self.toolbar = Some(toolbar);
        self.dispatch = Some(dispatch);
        self
    }

    /// Overrides the area used by the diff content while keeping the Changes toolbar full width.
    pub const fn with_content_bounds(mut self, bounds: Rect) -> Self {
        self.content_bounds = Some(bounds);
        self
    }

    /// Returns the content area below the Changes toolbar.
    pub const fn content_bounds_for(bounds: Rect) -> Rect {
        Rect::from_xywh(
            bounds.origin.x,
            bounds.origin.y + ChangesToolbar::height(),
            bounds.size.width,
            (bounds.size.height - ChangesToolbar::height()).max(0.0),
        )
    }

    fn content_bounds(&self) -> Rect {
        if let Some(bounds) = self.content_bounds {
            return bounds;
        }
        if self.toolbar.is_some() {
            Self::content_bounds_for(self.bounds)
        } else {
            self.bounds
        }
    }

    fn interaction_node_for_bounds(&self, bounds: Rect) -> UiNode {
        UiNode::new(
            CHANGES_PANE,
            bounds,
            AccessibilityRole::Group,
            "Changed files editor",
        )
        .with_parent(self.parent)
    }

    fn paint_surface(&self, scene: &mut UiScene, bounds: Rect) {
        scene.draw_rect(
            PaintRect::new(bounds, self.style.surface).with_border(Border::new(
                Edges::new(1.0, 0.0, 0.0, 0.0),
                self.style.border,
            )),
        );
    }

    fn paint_empty_state(&self, scene: &mut UiScene, bounds: Rect) {
        scene.draw_text(TextBlock::new(
            "No changes in this scope",
            zui::ui::Point::new(
                bounds.origin.x + EMPTY_STATE_PADDING,
                bounds.origin.y + EMPTY_STATE_PADDING,
            ),
            zui::ui::Size::new(
                (bounds.size.width - EMPTY_STATE_PADDING * 2.0).max(1.0),
                18.0,
            ),
            TextStyle::new(12.0, self.style.text_muted).with_line_height(18.0),
        ));
        scene.draw_text(TextBlock::new(
            "Your working tree is clean.",
            zui::ui::Point::new(
                bounds.origin.x + EMPTY_STATE_PADDING,
                bounds.origin.y + EMPTY_STATE_PADDING + 24.0,
            ),
            zui::ui::Size::new(
                (bounds.size.width - EMPTY_STATE_PADDING * 2.0).max(1.0),
                18.0,
            ),
            TextStyle::new(12.0, self.style.text_muted).with_line_height(18.0),
        ));
    }
}

impl Component for EditorPane<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("EditorPane")
            .in_bounds(self.bounds)
            .with_identity(CHANGES_PANE)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(self.interaction_node_for_bounds(element.bounds()))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        let bounds = element.bounds();
        self.paint_surface(context.scene_mut(), bounds);
        let content_bounds = self.content_bounds();
        if self.state.diffs().is_empty() {
            self.paint_empty_state(context.scene_mut(), content_bounds);
        } else {
            let default_dispatch = UiDispatch::default();
            let dispatch = self.dispatch.unwrap_or(&default_dispatch);
            let items = self.state.items(dispatch);
            let editor = MultiDiffEditor::new(
                content_bounds,
                &items,
                self.state.scroll_state,
                self.state.style(),
            )
            .with_diff_presentation(DiffEditorPresentation::Unified)
            .with_measured_layout(&self.state.measured_layout)
            .with_scrollbar_presentation(self.state.scrollbar_presentation())
            .with_identity(MULTI_DIFF_EDITOR)
            .with_scrollbar_identity(MULTI_DIFF_SCROLLBAR);
            context.draw_component(&editor);
        }
        if let (Some(toolbar), Some(dispatch)) = (self.toolbar, self.dispatch) {
            context.draw_component(&ChangesToolbar::new(
                Rect::from_xywh(
                    bounds.origin.x,
                    bounds.origin.y,
                    bounds.size.width,
                    ChangesToolbar::height(),
                ),
                bounds,
                toolbar,
                self.style,
                CHANGES_PANE,
                dispatch,
            ));
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_surface(scene, self.bounds);
        let bounds = self.content_bounds();
        if self.state.diffs().is_empty() {
            self.paint_empty_state(scene, bounds);
        } else {
            let default_dispatch = UiDispatch::default();
            let dispatch = self.dispatch.unwrap_or(&default_dispatch);
            let items = self.state.items(dispatch);
            scene.draw_component(
                &MultiDiffEditor::new(bounds, &items, self.state.scroll_state, self.state.style())
                    .with_diff_presentation(DiffEditorPresentation::Unified)
                    .with_measured_layout(&self.state.measured_layout)
                    .with_scrollbar_presentation(self.state.scrollbar_presentation()),
            );
        }
        if let (Some(toolbar), Some(dispatch)) = (self.toolbar, self.dispatch) {
            scene.draw_component(&ChangesToolbar::new(
                Rect::from_xywh(
                    self.bounds.origin.x,
                    self.bounds.origin.y,
                    self.bounds.size.width,
                    ChangesToolbar::height(),
                ),
                self.bounds,
                toolbar,
                self.style,
                CHANGES_PANE,
                dispatch,
            ));
        }
    }
}

fn button_state(id: ElementId, dispatch: &UiDispatch) -> ButtonState {
    if dispatch.is_pressed(id) {
        ButtonState::Pressed
    } else if dispatch.is_focused(id) {
        ButtonState::Focused
    } else if dispatch.is_hovered(id) {
        ButtonState::Hovered
    } else {
        ButtonState::Resting
    }
}

#[cfg(test)]
#[path = "pane_tests.rs"]
mod tests;
