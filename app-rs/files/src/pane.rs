use ash_ui_components::{IconLabel, IconLabelStyle, ListView};
use zui::ui::{AccessibilityRole, ComputedElement, UiDispatch, UiNode};
use zui::ui::{
    Component, ComponentContext, ComponentElement, Element, PaintRect, Rect, TextBlock, TextStyle,
    UiScene,
};

use super::FILE_LIST_ROW_HEIGHT;
use super::FilesState;
use super::file_icon::icon_for_search_result;
use super::tree_view::FileRowState;
use super::tree_view::FilesTreeView;
use super::tree_view::draw_row_background;
use super::tree_view::file_row_state;

use ash_ui_components::ScrollViewStyle;
use ash_ui_theme::UiTheme;
use zui::ui::Color;
use zui::ui::ElementId;

pub const EXPLORER_PANE: ElementId = crate::FILES_PANE;
pub(super) const HORIZONTAL_PADDING: f32 = 10.0;
pub(super) const ICON_SIZE: f32 = 14.0;
const SEARCH_RESULT_SCOPE: u32 = 6;
pub(super) const OVERSCAN_ITEMS: usize = 2;

/// Product file tree and fuzzy path results hosted by the Files pane.
pub struct FilesPaneStyle {
    pub surface: Color,
    pub selected_background: Color,
    pub hovered_background: Color,
    pub text: Color,
    pub text_muted: Color,
    pub scroll_view: ScrollViewStyle,
}

impl FilesPaneStyle {
    pub fn from_theme(theme: UiTheme) -> Self {
        Self {
            surface: theme.content_background,
            selected_background: theme.list_active_background,
            hovered_background: theme.list_hover_background,
            text: theme.foreground,
            text_muted: theme.muted_foreground,
            scroll_view: theme.file_list_scroll_view_style(),
        }
    }
}

/// Files-pane rendering and interaction registration over retained `FilesState`.
pub struct FilesPane<'a> {
    bounds: Rect,
    files: &'a FilesState,
    parent: ElementId,
    style: &'a FilesPaneStyle,
    dispatch: &'a UiDispatch,
}

impl<'a> FilesPane<'a> {
    pub const fn new(
        bounds: Rect,
        files: &'a FilesState,
        parent: ElementId,
        style: &'a FilesPaneStyle,
        dispatch: &'a UiDispatch,
    ) -> Self {
        Self {
            bounds,
            files,
            parent,
            style,
            dispatch,
        }
    }

    fn search_list_view(&self) -> ListView {
        ListView::new(
            self.bounds,
            self.files.search_matches().len(),
            FILE_LIST_ROW_HEIGHT,
            self.files.scroll_state(),
            self.style.scroll_view,
        )
        .with_overscan_items(OVERSCAN_ITEMS)
    }

    fn showing_search_results(&self) -> bool {
        self.files.search_visible() && !self.files.search_input().text().trim().is_empty()
    }
}

impl Component for FilesPane<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("FilesPane")
            .in_bounds(self.bounds)
            .with_identity(EXPLORER_PANE)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        let (role, label) = if self.showing_search_results() {
            (AccessibilityRole::List, "File search results")
        } else {
            (AccessibilityRole::Tree, "Files")
        };
        Some(UiNode::new(EXPLORER_PANE, element.bounds(), role, label).with_parent(self.parent))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context
            .scene_mut()
            .draw_rect(PaintRect::new(self.bounds, self.style.surface));
        let focused = self.dispatch.focused();
        let selected = self.files.selected_element();
        if self.files.item_count() == 0 {
            draw_empty(
                context.scene_mut(),
                self.bounds,
                self.style,
                if self.showing_search_results() {
                    "No matching files"
                } else {
                    "No files loaded"
                },
            );
            return;
        }
        if self.showing_search_results() {
            let list = self.search_list_view();
            list.draw_components(context, |context, item| {
                let Some(path) = self.files.search_matches().get(item.index()) else {
                    return;
                };
                let element = search_result_element_id(item.index());
                let label = path.to_string_lossy().replace('\\', "/");
                context.draw_component(&FilesSearchResult::new(
                    item.bounds(),
                    element,
                    label,
                    self.style,
                    file_row_state(focused == Some(element), self.dispatch.is_hovered(element)),
                ));
            });
        } else {
            context.draw_component(&FilesTreeView::new(
                self.bounds,
                self.files,
                self.style,
                selected,
                focused,
                self.dispatch,
            ));
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(PaintRect::new(self.bounds, self.style.surface));
        let focused = self.dispatch.focused();
        let selected = self.files.selected_element();
        if self.files.item_count() == 0 {
            draw_empty(
                scene,
                self.bounds,
                self.style,
                if self.showing_search_results() {
                    "No matching files"
                } else {
                    "No files loaded"
                },
            );
            return;
        }
        if self.showing_search_results() {
            self.search_list_view().draw(scene, |scene, item| {
                let Some(path) = self.files.search_matches().get(item.index()) else {
                    return;
                };
                let element = search_result_element_id(item.index());
                draw_search_row(
                    scene,
                    item.bounds(),
                    &path.to_string_lossy().replace('\\', "/"),
                    self.style,
                    file_row_state(focused == Some(element), self.dispatch.is_hovered(element)),
                );
            });
        } else {
            scene.draw_component(&FilesTreeView::new(
                self.bounds,
                self.files,
                self.style,
                selected,
                focused,
                self.dispatch,
            ));
        }
    }
}

struct FilesSearchResult<'a> {
    bounds: Rect,
    element: ElementId,
    label: String,
    style: &'a FilesPaneStyle,
    state: FileRowState,
}

impl<'a> FilesSearchResult<'a> {
    fn new(
        bounds: Rect,
        element: ElementId,
        label: String,
        style: &'a FilesPaneStyle,
        state: FileRowState,
    ) -> Self {
        Self {
            bounds,
            element,
            label,
            style,
            state,
        }
    }
}

impl Component for FilesSearchResult<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("FilesSearchResult")
            .in_bounds(self.bounds)
            .with_identity(self.element)
            .with_inspection_label(&self.label)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(UiNode::new(
            self.element,
            element.bounds(),
            AccessibilityRole::ListItem,
            self.label.clone(),
        ))
    }

    fn paint(&self, scene: &mut UiScene) {
        draw_search_row(scene, self.bounds, &self.label, self.style, self.state);
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        draw_search_row_in_context(context, self.bounds, &self.label, self.style, self.state);
    }
}

fn draw_search_row(
    scene: &mut UiScene,
    bounds: Rect,
    label: &str,
    style: &FilesPaneStyle,
    state: FileRowState,
) {
    draw_row_background(scene, bounds, style, state);
    scene.draw_component(&search_result_label(bounds, label, style));
}

fn draw_search_row_in_context(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    label: &str,
    style: &FilesPaneStyle,
    state: FileRowState,
) {
    draw_row_background(context.scene_mut(), bounds, style, state);
    context.draw_component(&search_result_label(bounds, label, style));
}

fn search_result_label(bounds: Rect, label: &str, style: &FilesPaneStyle) -> IconLabel {
    let content = Rect::from_xywh(
        bounds.origin.x + HORIZONTAL_PADDING,
        bounds.origin.y,
        (bounds.size.width - HORIZONTAL_PADDING * 2.0).max(1.0),
        bounds.size.height,
    );
    IconLabel::new(
        content,
        icon_for_search_result(),
        label,
        IconLabelStyle::new(TextStyle::new(12.0, style.text).with_line_height(16.0))
            .with_icon_size(ICON_SIZE)
            .with_icon_color(style.text_muted)
            .with_content_gap(6.0),
    )
}

fn search_result_element_id(index: usize) -> zui::ui::ElementId {
    zui::ui::ElementId::scoped(
        SEARCH_RESULT_SCOPE,
        u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1),
    )
}

fn draw_empty(scene: &mut UiScene, bounds: Rect, style: &FilesPaneStyle, label: &str) {
    scene.draw_text(TextBlock::new(
        label,
        zui::ui::Point::new(
            bounds.origin.x + HORIZONTAL_PADDING,
            bounds.origin.y + HORIZONTAL_PADDING,
        ),
        zui::ui::Size::new(
            (bounds.size.width - HORIZONTAL_PADDING * 2.0).max(1.0),
            18.0,
        ),
        TextStyle::new(12.0, style.text_muted).with_line_height(18.0),
    ));
}

#[cfg(test)]
#[path = "pane_tests.rs"]
mod tests;
