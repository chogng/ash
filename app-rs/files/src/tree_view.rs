use ash_icons::Icon;
use ash_icons::icons;
use ash_ui_components::IconLabel;
use ash_ui_components::IconLabelStyle;
use ash_ui_components::TreeItemExpansion;
use ash_ui_components::TreeItemLayout;
use ash_ui_components::TreeView;
use ash_ui_components::TreeViewStyle;
use zui::ui::AccessibilityExpansion;
use zui::ui::AccessibilityRole;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CursorFeedback;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::NavigationAxis;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::PaintIcon;
use zui::ui::PaintRect;
use zui::ui::Rect;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiScene;

use super::FILE_LIST_ROW_HEIGHT;
use super::FilesState;
use super::file_icon::icon_for_tree_item;
use super::pane::EXPLORER_PANE;
use super::pane::FilesPaneStyle;
use super::pane::HORIZONTAL_PADDING;
use super::pane::ICON_SIZE;
use super::pane::OVERSCAN_ITEMS;

pub(super) fn build_tree_view<'a>(
    bounds: Rect,
    files: &'a FilesState,
    style: &FilesPaneStyle,
) -> TreeView<'a> {
    TreeView::new(
        bounds,
        files.tree_items(),
        files.scroll_state(),
        TreeViewStyle::new(style.scroll_view, FILE_LIST_ROW_HEIGHT),
    )
    .with_overscan_items(OVERSCAN_ITEMS)
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum FileRowState {
    Resting,
    Hovered,
    Selected,
}

pub(super) struct FilesTreeView<'a> {
    bounds: Rect,
    files: &'a FilesState,
    style: &'a FilesPaneStyle,
    selected: Option<ElementId>,
    focused: Option<ElementId>,
    dispatch: &'a UiDispatch,
}

impl<'a> FilesTreeView<'a> {
    pub(super) fn new(
        bounds: Rect,
        files: &'a FilesState,
        style: &'a FilesPaneStyle,
        selected: Option<ElementId>,
        focused: Option<ElementId>,
        dispatch: &'a UiDispatch,
    ) -> Self {
        Self {
            bounds,
            files,
            style,
            selected,
            focused,
            dispatch,
        }
    }
}

impl Component for FilesTreeView<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("FilesTree").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        let tree = build_tree_view(self.bounds, self.files, self.style);
        let visible_range = tree.visible_range();
        tree.draw(scene, |scene, layout| {
            let Some(row) = self.files.tree_row(layout.index()) else {
                return;
            };
            let element = row.entry().element_id();
            let selected = self.selected == Some(element);
            let focused = self.focused == Some(element);
            scene.draw_component(&FilesTreeItem::new(
                layout,
                element,
                row.entry().label(),
                self.style,
                selected,
                focused,
                self.dispatch.is_hovered(element),
                visible_range.contains(&layout.index()),
            ));
        });
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        let tree = build_tree_view(self.bounds, self.files, self.style);
        let visible_range = tree.visible_range();
        tree.draw_components(context, |context, layout| {
            let Some(row) = self.files.tree_row(layout.index()) else {
                return;
            };
            let element = row.entry().element_id();
            let selected = self.selected == Some(element);
            let focused = self.focused == Some(element);
            context.draw_component(&FilesTreeItem::new(
                layout,
                element,
                row.entry().label(),
                self.style,
                selected,
                focused,
                self.dispatch.is_hovered(element),
                visible_range.contains(&layout.index()),
            ));
        });
    }
}

struct FilesTreeItem<'a> {
    layout: TreeItemLayout,
    element: ElementId,
    label: &'a str,
    style: &'a FilesPaneStyle,
    state: FileRowState,
    selected: bool,
    interactive: bool,
}

impl<'a> FilesTreeItem<'a> {
    fn new(
        layout: TreeItemLayout,
        element: ElementId,
        label: &'a str,
        style: &'a FilesPaneStyle,
        selected: bool,
        focused: bool,
        hovered: bool,
        interactive: bool,
    ) -> Self {
        Self {
            layout,
            element,
            label,
            style,
            state: file_row_state(selected || focused, hovered),
            selected,
            interactive,
        }
    }
}

impl Component for FilesTreeItem<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("FilesTreeItem")
            .in_bounds(self.layout.bounds())
            .with_identity(self.element)
            .with_inspection_label(self.label)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<zui::ui::UiNode> {
        if !self.interactive {
            return None;
        }
        let expansion = match self.layout.item().expansion() {
            TreeItemExpansion::Leaf => AccessibilityExpansion::NotApplicable,
            TreeItemExpansion::Collapsed => AccessibilityExpansion::Collapsed,
            TreeItemExpansion::Expanded => AccessibilityExpansion::Expanded,
        };
        Some(
            zui::ui::UiNode::new(
                self.element,
                element.bounds(),
                AccessibilityRole::TreeItem,
                self.label,
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(
                NavigationGroupId::new(EXPLORER_PANE),
                NavigationAxis::Vertical,
            )
            .with_level(self.layout.item().depth() + 1)
            .with_expansion(expansion)
            .with_selection(if self.selected {
                zui::ui::AccessibilitySelection::Selected
            } else {
                zui::ui::AccessibilitySelection::Unselected
            }),
        )
    }

    fn paint(&self, scene: &mut UiScene) {
        draw_row_background(scene, self.layout.bounds(), self.style, self.state);

        if let Some(bounds) = self.layout.disclosure_bounds() {
            let icon = match self.layout.item().expansion() {
                TreeItemExpansion::Expanded => icons::CHEVRON_DOWN,
                TreeItemExpansion::Collapsed => icons::CHEVRON_RIGHT,
                TreeItemExpansion::Leaf => unreachable!("leaf has no disclosure geometry"),
            };
            scene.draw_component(&FilesTreeDisclosure::new(
                bounds,
                icon,
                self.style.text_muted,
            ));
        }

        scene.draw_component(&file_label(self.layout, self.label, self.style));
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        draw_row_background(
            context.scene_mut(),
            self.layout.bounds(),
            self.style,
            self.state,
        );

        if let Some(bounds) = self.layout.disclosure_bounds() {
            let icon = match self.layout.item().expansion() {
                TreeItemExpansion::Expanded => icons::CHEVRON_DOWN,
                TreeItemExpansion::Collapsed => icons::CHEVRON_RIGHT,
                TreeItemExpansion::Leaf => unreachable!("leaf has no disclosure geometry"),
            };
            context.draw_component(&FilesTreeDisclosure::new(
                bounds,
                icon,
                self.style.text_muted,
            ));
        }

        context.draw_component(&file_label(self.layout, self.label, self.style));
    }
}

struct FilesTreeDisclosure {
    bounds: Rect,
    icon: Icon,
    color: Color,
}

impl FilesTreeDisclosure {
    const fn new(bounds: Rect, icon: Icon, color: Color) -> Self {
        Self {
            bounds,
            icon,
            color,
        }
    }
}

impl Component for FilesTreeDisclosure {
    fn element(&self) -> ComponentElement {
        Element::leaf("FilesTreeDisclosure").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_icon(PaintIcon::new(self.icon, self.bounds, self.color));
    }
}

fn file_label(layout: TreeItemLayout, label: &str, style: &FilesPaneStyle) -> IconLabel {
    let content = layout.content_bounds();
    let bounds = Rect::from_xywh(
        content.origin.x,
        content.origin.y,
        (content.size.width - HORIZONTAL_PADDING).max(1.0),
        content.size.height,
    );
    IconLabel::new(
        bounds,
        icon_for_tree_item(layout.item().expansion()),
        label,
        IconLabelStyle::new(TextStyle::new(12.0, style.text).with_line_height(16.0))
            .with_icon_size(ICON_SIZE)
            .with_icon_color(style.text_muted)
            .with_content_gap(6.0),
    )
}

pub(super) fn file_row_state(selected: bool, hovered: bool) -> FileRowState {
    if selected {
        FileRowState::Selected
    } else if hovered {
        FileRowState::Hovered
    } else {
        FileRowState::Resting
    }
}

pub(super) fn draw_row_background(
    scene: &mut UiScene,
    bounds: Rect,
    style: &FilesPaneStyle,
    state: FileRowState,
) {
    let background = match state {
        FileRowState::Resting => return,
        FileRowState::Hovered => style.hovered_background,
        FileRowState::Selected => style.selected_background,
    };
    scene.draw_rect(PaintRect::new(bounds, background));
}
