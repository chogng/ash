use ash_icons::icons;
use ash_ui_components::ActionBarSeparatorStyle;
use ash_ui_components::ActionViewItem;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonState;
use ash_ui_components::ButtonStyle;
use ash_ui_components::ContextMenu;
use ash_ui_components::ContextMenuStyle as SharedContextMenuStyle;
use ash_ui_components::ContextView;
use ash_ui_components::ContextViewAnchorAxis;
use ash_ui_components::ContextViewAnchorPosition;
use ash_ui_components::ContextViewPlacement;
use ash_ui_components::ContextViewStyle;
use ash_ui_components::InputBox;
use ash_ui_components::InputBoxState;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use ash_ui_components::InteractionRegion;
use ash_ui_components::MenuIds;
use ash_ui_components::MenuItem;
use ash_ui_components::MenuSelection;
use ash_ui_components::MenuStyle;
use ash_ui_theme::UiTheme;
use zui::ui::AccessibilityRole;
use zui::ui::Border;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::CursorFeedback;
use zui::ui::Edges;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::FontWeight;
use zui::ui::InteractionFrame;
use zui::ui::PaintRect;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;

use super::TAB_CONTEXT_MENU;
use super::TAB_CONTEXT_MENU_GROUPS;
use super::TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP;
use super::TAB_RENAME_INPUT;
use super::TabContextMenuAction;
use super::TabContextMenuState;
use super::TabContextMenuView;
use super::tab_group_menu_element_id;
use crate::SidebarPart;

const MENU_WIDTH: f32 = 140.0;
const MENU_ITEM_HEIGHT: f32 = 28.0;
const MENU_GAP: f32 = 2.0;
const MENU_MARGIN: f32 = 8.0;
const MENU_CORNER_RADIUS: f32 = 10.0;
const MENU_SEPARATOR_EXTENT: f32 = 8.0;
const MENU_SEPARATOR_INSET: f32 = 8.0;
const RENAME_WIDTH: f32 = 240.0;
const RENAME_HEIGHT: f32 = 30.0;
const RENAME_PADDING: f32 = 4.0;

/// Colors used by the Workbench-owned tab actions menu.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TabContextMenuStyle {
    surface: Color,
    border: Color,
    text: Color,
    hovered: Color,
    danger: Color,
}

impl TabContextMenuStyle {
    pub const fn from_theme(theme: UiTheme) -> Self {
        Self::new(
            theme.menu_background,
            theme.border,
            theme.menu_foreground,
            theme.menu_hover_background,
            theme.error,
        )
    }

    pub const fn new(
        surface: Color,
        border: Color,
        text: Color,
        hovered: Color,
        danger: Color,
    ) -> Self {
        Self {
            surface,
            border,
            text,
            hovered,
            danger,
        }
    }
}

/// Workbench presentation for a tab actions menu and its group/rename child view.
#[derive(Clone, Debug, PartialEq)]
pub struct TabContextMenu {
    root: Option<ContextMenu>,
    groups: Option<ContextMenu>,
    rename_view: Option<ContextView>,
    rename: Option<InputBox>,
    rename_value: Option<String>,
    border: Color,
    bounds: Rect,
}

impl TabContextMenu {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        viewport: Rect,
        sidebar_part: &SidebarPart,
        state: &TabContextMenuState,
        caret_visibility: CaretVisibility,
        style: TabContextMenuStyle,
        window: ElementId,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Option<Self> {
        let open = state.open.as_ref()?;
        if open.view == TabContextMenuView::Rename {
            let rename_view = ContextView::new(
                viewport,
                open.anchor,
                Size::new(RENAME_WIDTH, RENAME_HEIGHT),
                ContextViewPlacement::new()
                    .with_position(ContextViewAnchorPosition::After)
                    .with_gap(2.0)
                    .with_viewport_margin(MENU_MARGIN),
                ContextViewStyle::new(style.surface)
                    .with_corner_radii(CornerRadii::uniform(6.0))
                    .with_padding(Edges::uniform(RENAME_PADDING)),
            );
            let state = if dispatch.is_focused(TAB_RENAME_INPUT) {
                InputBoxState::Focused(caret_visibility)
            } else if dispatch.is_hovered(TAB_RENAME_INPUT) {
                InputBoxState::Hovered
            } else {
                InputBoxState::Resting
            };
            let rename = InputBox::new(
                rename_view.content_bounds(),
                "Session name",
                state,
                rename_style(style),
                &open.rename,
                text_layout,
            );
            return Some(Self {
                root: None,
                groups: None,
                rename_view: Some(rename_view),
                rename: Some(rename),
                rename_value: Some(open.rename.text().to_owned()),
                border: style.border,
                bounds: rename_view.bounds(),
            });
        }
        let button_style = menu_button_style(style);
        let session_action_enabled = open.target_tab.session_id().is_some();
        let action = |action: TabContextMenuAction, enabled: bool| {
            let id = action.element_id();
            let state = button_state(dispatch, id, enabled);
            let label = action.label(open.pinned, open.confirm_delete);
            let view = if action == TabContextMenuAction::MoveToGroup {
                ActionViewItem::label_and_trailing_icon(label, icons::CHEVRON_RIGHT, state)
            } else {
                ActionViewItem::label(label, state)
            };
            let view = if action == TabContextMenuAction::Delete {
                view.with_text_style(menu_text_style(style.danger))
            } else {
                view
            };
            MenuItem::action(id, view)
        };
        let root_items = vec![
            action(TabContextMenuAction::TogglePin, true),
            action(TabContextMenuAction::Rename, true),
            action(TabContextMenuAction::Fork, session_action_enabled),
            MenuItem::separator(),
            action(TabContextMenuAction::MoveToGroup, true),
            MenuItem::separator(),
            action(TabContextMenuAction::Archive, session_action_enabled),
            action(TabContextMenuAction::Delete, session_action_enabled),
        ];
        let menu_style = MenuStyle::new(
            style.surface,
            button_style.clone(),
            Size::new(MENU_WIDTH, MENU_ITEM_HEIGHT),
        )
        .with_border(Border::uniform(1.0, style.border))
        .with_corner_radii(CornerRadii::uniform(MENU_CORNER_RADIUS))
        .with_separator_style(
            ActionBarSeparatorStyle::new(style.border)
                .with_extent(MENU_SEPARATOR_EXTENT)
                .with_thickness(1.0)
                .with_cross_axis_inset(MENU_SEPARATOR_INSET),
        );
        let root_style = SharedContextMenuStyle::new(menu_style).with_placement(
            ContextViewPlacement::new()
                .with_gap(MENU_GAP)
                .with_viewport_margin(MENU_MARGIN),
        );
        let root = ContextMenu::new(
            viewport,
            open.anchor,
            "Tab actions",
            root_items,
            MenuIds::new(window, TAB_CONTEXT_MENU),
            root_style,
        )
        .with_selection(MenuSelection::None);

        let groups = (open.view == TabContextMenuView::Groups).then(|| {
            let source = sidebar_part.input_group(&open.target_tab);
            let entries = sidebar_part
                .groups()
                .iter()
                .filter(|group| Some(group.id()) != source)
                .map(|group| {
                    (
                        tab_group_menu_element_id(group.id()),
                        group
                            .label()
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("Group {}", group.id().value())),
                    )
                })
                .chain(std::iter::once((
                    TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP,
                    "New group".to_owned(),
                )))
                .collect::<Vec<_>>();
            let items = entries
                .iter()
                .map(|(id, label)| {
                    MenuItem::action(
                        *id,
                        ActionViewItem::label(label, button_state(dispatch, *id, true)),
                    )
                })
                .collect();
            let item_bounds = root
                .item_bounds(TabContextMenuAction::MoveToGroup.menu_index())
                .unwrap_or_else(|| {
                    Rect::from_xywh(root.bounds().right(), root.bounds().origin.y, 1.0, 1.0)
                });
            let anchor = Rect::from_xywh(
                root.bounds().origin.x,
                item_bounds.origin.y,
                root.bounds().size.width,
                item_bounds.size.height,
            );
            ContextMenu::new(
                viewport,
                anchor,
                "Tab groups",
                items,
                MenuIds::new(TAB_CONTEXT_MENU, TAB_CONTEXT_MENU_GROUPS),
                SharedContextMenuStyle::new(
                    MenuStyle::new(
                        style.surface,
                        button_style.clone(),
                        Size::new(MENU_WIDTH, MENU_ITEM_HEIGHT),
                    )
                    .with_border(Border::uniform(1.0, style.border))
                    .with_corner_radii(CornerRadii::uniform(MENU_CORNER_RADIUS)),
                )
                .with_placement(
                    ContextViewPlacement::new()
                        .with_axis(ContextViewAnchorAxis::Horizontal)
                        .with_position(ContextViewAnchorPosition::After)
                        .with_gap(MENU_GAP)
                        .with_viewport_margin(MENU_MARGIN),
                ),
            )
            .with_selection(MenuSelection::None)
        });

        let bounds = groups
            .as_ref()
            .map(|groups| union_rect(root.bounds(), groups.bounds()))
            .unwrap_or_else(|| root.bounds());
        Some(Self {
            root: Some(root),
            groups,
            rename_view: None,
            rename: None,
            rename_value: None,
            border: style.border,
            bounds,
        })
    }

    #[cfg(test)]
    pub fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.root.as_ref()?.item_bounds(index)
    }
}

impl Component for TabContextMenu {
    fn element(&self) -> ComponentElement {
        Element::leaf("TabContextMenu").in_bounds(self.bounds)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        if let Some(root) = &self.root {
            root.draw_components_with_header(context, |_context, _bounds| {});
            context.set_modal_root(root.menu_root());
            if let Some(groups) = &self.groups {
                context.draw_component(groups);
            }
            return;
        }
        let (Some(rename_view), Some(rename)) = (&self.rename_view, &self.rename) else {
            return;
        };
        rename_view.draw_components(context, |context, _| {
            context.draw_component(&InteractionRegion::new(
                "SessionRename",
                TAB_CONTEXT_MENU,
                rename_view.bounds(),
                AccessibilityRole::Group,
                "Rename Session",
            ));
            context.draw_component(
                &InteractionRegion::new(
                    "TabRenameInput",
                    TAB_RENAME_INPUT,
                    rename.bounds(),
                    AccessibilityRole::TextInput,
                    "Rename Session",
                )
                .with_parent(TAB_CONTEXT_MENU)
                .with_cursor(CursorFeedback::Text)
                .with_focus(FocusBehavior::TabStop)
                .with_value(self.rename_value.as_deref().unwrap_or_default()),
            );
            context.draw_component(rename);
            context.scene_mut().draw_rect(
                PaintRect::new(rename_view.bounds(), Color::TRANSPARENT)
                    .with_border(Border::uniform(1.0, self.border))
                    .with_corner_radii(CornerRadii::uniform(6.0)),
            );
        });
        context.set_modal_root(TAB_CONTEXT_MENU);
    }
}

pub fn update_tab_context_menu_pointer(
    dispatch: &mut UiDispatch,
    point: Point,
    frame: &InteractionFrame,
) -> zui::ui::DispatchOutcome {
    dispatch.pointer_moved(point, frame)
}

pub(crate) fn tab_context_menu_groups_contain_pointer(
    point: Point,
    frame: &InteractionFrame,
) -> bool {
    let Some(move_to_group) = frame
        .node(TabContextMenuAction::MoveToGroup.element_id())
        .map(|node| node.bounds())
    else {
        return false;
    };
    let Some(groups) = frame
        .node(TAB_CONTEXT_MENU_GROUPS)
        .map(|node| node.bounds())
    else {
        return false;
    };
    move_to_group.contains(point)
        || groups.contains(point)
        || menu_bridge(move_to_group, groups).is_some_and(|bridge| bridge.contains(point))
}

fn button_state(dispatch: &UiDispatch, id: ElementId, enabled: bool) -> ButtonState {
    if !enabled {
        ButtonState::Disabled
    } else if dispatch.is_pressed(id) {
        ButtonState::Pressed
    } else if dispatch.is_hovered(id) {
        ButtonState::Hovered
    } else if dispatch.is_focused(id) {
        ButtonState::Focused
    } else {
        ButtonState::Resting
    }
}

fn menu_button_style(style: TabContextMenuStyle) -> ButtonStyle {
    let backgrounds = ButtonBackgrounds::new(Color::TRANSPARENT)
        .with_hovered(style.hovered)
        .with_focused(Color::TRANSPARENT)
        .with_pressed(style.hovered);
    ButtonStyle::new(backgrounds, menu_text_style(style.text))
        .with_selected_backgrounds(ButtonBackgrounds::new(Color::TRANSPARENT))
        .with_corner_radii(CornerRadii::uniform(MENU_CORNER_RADIUS))
        .with_padding(Edges::new(6.0, 8.0, 6.0, 8.0))
        .with_icon_size(12.0)
        .with_content_gap(8.0)
}

fn menu_text_style(color: Color) -> TextStyle {
    TextStyle::new(13.0, color).with_weight(FontWeight::SemiBold)
}

fn rename_style(style: TabContextMenuStyle) -> InputBoxStyle {
    InputBoxStyle::new(
        InputBoxStateColors::new(style.surface, style.surface, style.surface),
        InputBoxStateColors::new(style.border, style.text, style.text),
        TextStyle::new(12.0, style.text),
        TextStyle::new(12.0, style.text),
    )
    .with_corner_radii(CornerRadii::uniform(3.0))
    .with_padding(Edges::new(4.0, 6.0, 4.0, 6.0))
}

fn union_rect(left: Rect, right: Rect) -> Rect {
    let x = left.origin.x.min(right.origin.x);
    let y = left.origin.y.min(right.origin.y);
    let right_edge = left.right().max(right.right());
    let bottom = (left.origin.y + left.size.height).max(right.origin.y + right.size.height);
    Rect::from_xywh(x, y, right_edge - x, bottom - y)
}

fn menu_bridge(parent: Rect, child: Rect) -> Option<Rect> {
    let top = parent.origin.y.min(child.origin.y);
    let bottom = parent.bottom().max(child.bottom());
    if parent.right() <= child.origin.x {
        return Some(Rect::from_xywh(
            parent.right(),
            top,
            child.origin.x - parent.right(),
            bottom - top,
        ));
    }
    (child.right() <= parent.origin.x).then(|| {
        Rect::from_xywh(
            child.right(),
            top,
            parent.origin.x - child.right(),
            bottom - top,
        )
    })
}
