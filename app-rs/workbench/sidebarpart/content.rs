//! Sidebar Sessions content, scrollable groups, and list items.

use crate::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarStyle, ActionViewItem, Border,
    ButtonBackgrounds, ButtonState, ButtonStyle, CaretVisibility, Color, Component,
    ComponentContext, ComponentElement, ComputedElement, CornerRadii, Edges, Element, FontWeight,
    Icon, InteractionRegion, ListItem, ListItemBackgrounds, ListItemSelection, ListItemState,
    ListItemStyle, PaintIcon, PaintRect, Point, Rect, ScrollAxis, ScrollMetrics, ScrollState,
    ScrollView, ScrollbarPresentation, Size, TextBlock, TextInput, TextInputLayoutEngine, UiScene,
};
use ash_icons::icons;
use zui::ui::AccessibilityExpansion;
use zui::ui::AccessibilityRole;
use zui::ui::AccessibilitySelection;
use zui::ui::CursorFeedback;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::UiDispatch;
use zui::ui::UiNode;

use super::WorkbenchUiStyle;
use super::header::SIDEBAR_HEADER_HEIGHT;
use super::header::SidebarHeader;
use super::item_dirs_preview::ItemDirsPreview;
#[cfg(test)]
use super::item_dirs_preview::dirs_preview_name_id;
use super::session_items::SessionGroup;
use super::session_items::SessionListItem;
use super::session_items::SessionListItemKind;
pub use super::session_items::mounted_sidebar_item_id;
pub use super::session_items::sidebar_intent_for_element;
pub use super::session_items::sidebar_item_key_for_element;
pub use super::session_items::sidebar_selected_item_id;
pub use super::session_items::sidebar_session_groups;
use super::sessions_toolbar::SessionsToolbar;
use super::sessions_toolbar::TOOLBAR_HEIGHT;
#[cfg(test)]
use crate::SidebarPart;
#[cfg(test)]
use crate::TabInputKey;
use crate::TabStatusKind;

const PART_PADDING: f32 = 10.0;
const TOOLBAR_CONTENT_GAP: f32 = 4.0;
const TAB_HEIGHT: f32 = 52.0;
const TAB_GAP: f32 = 6.0;
const GROUP_ROOT_HEIGHT: f32 = 28.0;
const GROUP_GAP: f32 = 8.0;
const GROUP_CHILD_INDENT: f32 = 16.0;
const TAB_CONTENT_PADDING: f32 = 8.0;
const SESSION_ICON_SIZE: f32 = 18.0;
const SESSION_ICON_GAP: f32 = 10.0;
const CLOSE_SIZE: f32 = 24.0;
const TAB_ACTION_GAP: f32 = 2.0;

fn session_status_icon(kind: TabStatusKind) -> Icon {
    match kind {
        TabStatusKind::Idle => icons::CIRCLE_SMALL,
        TabStatusKind::NeedsInput => icons::ENTER,
        TabStatusKind::Working => icons::SYNC,
        TabStatusKind::ReadyForReview => icons::CODE_REVIEW,
        TabStatusKind::Completed => icons::CIRCLE_SMALL_FILLED,
        TabStatusKind::Failed => icons::ERROR,
        TabStatusKind::Stopped => icons::PAUSE,
    }
}

struct TabContainerLayout {
    header: Rect,
    toolbar: Rect,
    content: Rect,
    list: Rect,
}

impl TabContainerLayout {
    fn for_bounds(bounds: Rect) -> Self {
        let header = Rect::from_xywh(
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            SIDEBAR_HEADER_HEIGHT.min(bounds.size.height),
        );
        let toolbar = Rect::from_xywh(
            bounds.origin.x,
            header.bottom() + PART_PADDING,
            bounds.size.width,
            TOOLBAR_HEIGHT.min((bounds.bottom() - header.bottom() - PART_PADDING).max(1.0)),
        );
        let content = Rect::from_xywh(
            bounds.origin.x,
            toolbar.bottom() + TOOLBAR_CONTENT_GAP,
            bounds.size.width,
            (bounds.bottom() - toolbar.bottom() - TOOLBAR_CONTENT_GAP).max(1.0),
        );
        let list = Rect::from_xywh(
            content.origin.x + PART_PADDING,
            content.origin.y,
            (content.size.width - PART_PADDING * 2.0).max(1.0),
            (content.size.height - PART_PADDING).max(1.0),
        );
        Self {
            header,
            toolbar,
            content,
            list,
        }
    }
}

struct GroupLayout {
    group_index: usize,
    list_id: ElementId,
    bounds: Rect,
    label_bounds: Option<Rect>,
    list_bounds: Rect,
    item_bounds: Vec<Rect>,
}

/// Application-owned Sidebar with a mode header and Sessions content page.
pub struct SidebarView<'a> {
    bounds: Rect,
    viewport: Rect,
    layout: TabContainerLayout,
    header: SidebarHeader,
    toolbar: SessionsToolbar,
    groups: Vec<SessionGroup<'a>>,
    selected_id: ElementId,
    visible_action_bar_tab: Option<ElementId>,
    scroll: ScrollState,
    scrollbar_presentation: ScrollbarPresentation,
    style: WorkbenchUiStyle,
    dispatch: &'a UiDispatch,
}

impl<'a> SidebarView<'a> {
    pub fn new(
        bounds: Rect,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        mode: crate::SidebarMode,
        groups: Vec<SessionGroup<'a>>,
        selected_id: ElementId,
        style: WorkbenchUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
    ) -> Self {
        let layout = TabContainerLayout::for_bounds(bounds);
        let header = SidebarHeader::new(layout.header, mode, style.clone(), text_layout, dispatch);
        let toolbar = SessionsToolbar::new(
            layout.toolbar,
            search_input,
            caret_visibility,
            style.clone(),
            text_layout,
            dispatch,
        );
        Self {
            bounds,
            viewport: bounds,
            layout,
            header,
            toolbar,
            groups,
            selected_id,
            visible_action_bar_tab: None,
            scroll: ScrollState::default(),
            scrollbar_presentation: ScrollbarPresentation::default(),
            style,
            dispatch,
        }
    }

    /// Supplies the window viewport used to place overlays outside the Sidebar bounds.
    pub fn with_viewport(mut self, viewport: Rect) -> Self {
        self.viewport = viewport;
        self
    }

    /// Keeps one mounted tab's action bar visible independently of pointer and focus state.
    pub fn with_visible_action_bar(mut self, tab: ElementId) -> Self {
        self.visible_action_bar_tab = Some(tab);
        self
    }

    /// Supplies retained vertical scroll state for the body-mounted tab list.
    pub const fn with_scroll_state(mut self, scroll: ScrollState) -> Self {
        self.scroll = scroll;
        self
    }

    /// Supplies the retained scrollbar visibility and interaction state.
    pub const fn with_scrollbar_presentation(
        mut self,
        presentation: ScrollbarPresentation,
    ) -> Self {
        self.scrollbar_presentation = presentation;
        self
    }

    /// Returns the body-mounted list viewport and content extents.
    pub fn scroll_metrics(&self) -> ScrollMetrics {
        self.scroll_view().metrics()
    }

    #[cfg(test)]
    pub fn from_sidebar_part(
        bounds: Rect,
        sidebar_part: &'a SidebarPart,
        selected: Option<&TabInputKey>,
        style: WorkbenchUiStyle,
        dispatch: &'a UiDispatch,
    ) -> Self {
        let mut text_layout = TextInputLayoutEngine::new();
        Self::new(
            bounds,
            &TextInput::new(),
            CaretVisibility::Visible,
            sidebar_part.mode(),
            sidebar_session_groups(sidebar_part, |_| true),
            sidebar_selected_item_id(sidebar_part, selected),
            style,
            &mut text_layout,
            dispatch,
        )
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.toolbar.search_caret_bounds()
    }

    fn group_layouts(&self) -> Vec<GroupLayout> {
        let mut cursor = self.scroll_view().viewport().content_origin().y;
        self.groups
            .iter()
            .enumerate()
            .map(|(group_index, group)| {
                let group_top = cursor;
                let label_bounds = group.label.map(|_| {
                    let bounds = Rect::from_xywh(
                        self.layout.list.origin.x,
                        cursor,
                        self.layout.list.size.width,
                        GROUP_ROOT_HEIGHT,
                    );
                    cursor = bounds.bottom();
                    bounds
                });
                let visible_tabs = if group.collapsed { 0 } else { group.tabs.len() };
                let height = visible_tabs as f32 * TAB_HEIGHT
                    + visible_tabs.saturating_sub(1) as f32 * TAB_GAP;
                let indent = if group.label.is_some() {
                    GROUP_CHILD_INDENT
                } else {
                    0.0
                };
                let list_bounds = Rect::from_xywh(
                    self.layout.list.origin.x + indent,
                    cursor,
                    (self.layout.list.size.width - indent).max(1.0),
                    height,
                );
                let item_bounds = (0..visible_tabs)
                    .map(|index| {
                        Rect::from_xywh(
                            list_bounds.origin.x,
                            list_bounds.origin.y + index as f32 * (TAB_HEIGHT + TAB_GAP),
                            list_bounds.size.width,
                            TAB_HEIGHT,
                        )
                    })
                    .collect();
                cursor = list_bounds.bottom();
                let group_bottom = cursor.max(label_bounds.map_or(group_top, Rect::bottom));
                cursor += GROUP_GAP;
                GroupLayout {
                    group_index,
                    list_id: super::identity::tab_group_list_id(group.id),
                    bounds: Rect::from_xywh(
                        self.layout.list.origin.x,
                        group_top,
                        self.layout.list.size.width,
                        (group_bottom - group_top).max(0.0),
                    ),
                    label_bounds,
                    list_bounds,
                    item_bounds,
                }
            })
            .collect()
    }

    fn content_height(&self) -> f32 {
        self.groups
            .iter()
            .map(|group| {
                let label_height = group.label.map_or(0.0, |_| GROUP_ROOT_HEIGHT);
                let visible_tabs = if group.collapsed { 0 } else { group.tabs.len() };
                let tabs_height = visible_tabs as f32 * TAB_HEIGHT
                    + visible_tabs.saturating_sub(1) as f32 * TAB_GAP;
                label_height + tabs_height + GROUP_GAP
            })
            .sum::<f32>()
            + PART_PADDING
    }

    pub(crate) fn scroll_view(&self) -> ScrollView {
        ScrollView::new(
            self.layout.content,
            Size::new(self.layout.content.size.width, self.content_height()),
            self.scroll,
            ScrollAxis::Vertical,
            self.style.scroll_view,
        )
        .with_scrollbar_presentation(self.scrollbar_presentation)
    }

    fn item_style(&self) -> ListItemStyle {
        let backgrounds = ListItemBackgrounds::new(Color::TRANSPARENT)
            .with_hovered(self.style.colors.tab_hover_background)
            .with_focused(self.style.colors.tab_hover_background)
            .with_pressed(self.style.colors.tab_hover_background);
        ListItemStyle::new(backgrounds)
            .with_selected_backgrounds(ListItemBackgrounds::new(
                self.style.colors.tab_active_background,
            ))
            .with_corner_radii(CornerRadii::uniform(4.0))
    }

    fn item_state(&self, id: ElementId) -> ListItemState {
        if self.dispatch.is_pressed(id) {
            ListItemState::Pressed
        } else if self.dispatch.is_focused(id) {
            ListItemState::Focused
        } else if self.dispatch.is_hovered(id) {
            ListItemState::Hovered
        } else {
            ListItemState::Resting
        }
    }

    fn compose_visible_groups(&self, context: &mut ComponentContext<'_, '_>) {
        for layout in self.group_layouts() {
            if layout.bounds.intersection(self.layout.list).is_empty() {
                continue;
            }
            context.draw_component(&SessionGroupView {
                container: self,
                layout,
            });
        }
    }

    fn compose_dirs_preview(&self, context: &mut ComponentContext<'_, '_>) {
        let hovered = self.group_layouts().into_iter().find_map(|layout| {
            self.groups[layout.group_index]
                .tabs
                .iter()
                .enumerate()
                .find_map(|(index, tab)| {
                    (tab.kind == SessionListItemKind::Session && self.dispatch.is_hovered(tab.id))
                        .then(|| {
                            (
                                tab,
                                layout
                                    .item_bounds
                                    .get(index)
                                    .copied()
                                    .expect("hovered tab has layout bounds"),
                            )
                        })
                })
        });
        let Some((tab, tab_bounds)) = hovered else {
            return;
        };
        context.draw_component(&ItemDirsPreview::new(
            self.viewport,
            tab_bounds,
            tab,
            self.style.clone(),
        ));
    }

    fn tab_region(
        &self,
        tab: &SessionListItem<'_>,
        bounds: Rect,
        list_id: ElementId,
    ) -> InteractionRegion {
        let label = match tab.kind {
            SessionListItemKind::Session => format!("{}, {}", tab.name, tab.status.label()),
            SessionListItemKind::Settings => "Settings".to_owned(),
        };
        InteractionRegion::new(
            "SessionListItem",
            tab.id,
            bounds,
            AccessibilityRole::ListItem,
            label,
        )
        .with_parent(list_id)
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_navigation(
            NavigationGroupId::new(list_id),
            zui::ui::NavigationAxis::Vertical,
        )
        .with_selection(if tab.id == self.selected_id {
            AccessibilitySelection::Selected
        } else {
            AccessibilitySelection::Unselected
        })
    }

    fn action_regions(
        &self,
        tab: &SessionListItem<'_>,
        tab_bounds: Rect,
    ) -> [InteractionRegion; 2] {
        let action_bar = self.tab_action_bar(tab, tab_bounds);
        [
            InteractionRegion::new(
                "TabActionsButton",
                tab.action_id,
                action_bar
                    .interactive_item_bounds(0)
                    .expect("tab actions button is enabled"),
                AccessibilityRole::Button,
                format!("Actions for {}", tab.name),
            )
            .with_parent(tab.id)
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate),
            InteractionRegion::new(
                "TabClose",
                tab.close_id,
                action_bar
                    .interactive_item_bounds(1)
                    .expect("tab close button is enabled"),
                AccessibilityRole::Button,
                format!("Close {}", tab.name),
            )
            .with_parent(tab.id)
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate),
        ]
    }

    fn tab_action_bar(&self, tab: &SessionListItem<'_>, tab_bounds: Rect) -> ActionBar {
        let size = CLOSE_SIZE;
        let width = size * 2.0 + TAB_ACTION_GAP;
        let bounds = Rect::from_xywh(
            tab_bounds.right() - TAB_CONTENT_PADDING - width,
            tab_bounds.origin.y + (tab_bounds.size.height - size) * 0.5,
            width,
            size,
        );
        let button_style = ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT)
                .with_hovered(self.style.colors.control_hover_background)
                .with_focused(Color::TRANSPARENT)
                .with_pressed(self.style.colors.border),
            self.style
                .label_text
                .clone()
                .with_color(self.style.colors.muted_foreground),
        )
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_padding(Edges::uniform(3.0))
        .with_icon_size(self.action_icon_size());
        ActionBar::new(
            bounds,
            ActionBarOrientation::Horizontal,
            vec![
                ActionBarItem::Action(ActionViewItem::icon(
                    icons::ELLIPSIS,
                    format!("Actions for {}", tab.name),
                    self.button_state(tab.action_id),
                )),
                ActionBarItem::Action(ActionViewItem::icon(
                    self.style.close_icon,
                    format!("Close {}", tab.name),
                    self.button_state(tab.close_id),
                )),
            ],
            ActionBarStyle::new(button_style, Size::new(size, size)).with_gap(TAB_ACTION_GAP),
        )
    }

    fn tab_action_bar_visible(&self, tab: &SessionListItem<'_>) -> bool {
        self.visible_action_bar_tab == Some(tab.id)
            || self.dispatch.is_hovered(tab.id)
            || self.dispatch.is_focused(tab.id)
            || self.dispatch.is_hovered(tab.action_id)
            || self.dispatch.is_hovered(tab.close_id)
            || self.dispatch.is_focused(tab.action_id)
            || self.dispatch.is_focused(tab.close_id)
            || self.dispatch.is_pressed(tab.action_id)
            || self.dispatch.is_pressed(tab.close_id)
    }

    fn paint_tab_action_bar(
        &self,
        scene: &mut UiScene,
        tab: &SessionListItem<'_>,
        tab_bounds: Rect,
    ) {
        let action_bar = self.tab_action_bar(tab, tab_bounds);
        scene.draw_rect(
            PaintRect::new(action_bar.bounds(), self.style.colors.action_bar_background)
                .with_corner_radii(CornerRadii::uniform(4.0)),
        );
        scene.draw_component(&action_bar);
    }

    fn action_icon_size(&self) -> f32 {
        16.0
    }

    fn pinned_action_icon_bounds(&self, tab: &SessionListItem<'_>, tab_bounds: Rect) -> Rect {
        let close_bounds = self
            .tab_action_bar(tab, tab_bounds)
            .item_bounds(1)
            .expect("tab close slot");
        let icon_size = self.action_icon_size();
        Rect::from_xywh(
            close_bounds.origin.x + (close_bounds.size.width - icon_size) * 0.5,
            close_bounds.origin.y + (close_bounds.size.height - icon_size) * 0.5,
            icon_size,
            icon_size,
        )
    }

    fn paint_pinned_action_status(
        &self,
        scene: &mut UiScene,
        tab: &SessionListItem<'_>,
        tab_bounds: Rect,
    ) {
        scene.draw_icon(PaintIcon::new(
            self.style.pinned_icon,
            self.pinned_action_icon_bounds(tab, tab_bounds),
            self.style.colors.muted_foreground,
        ));
    }

    fn button_state(&self, id: ElementId) -> ButtonState {
        if self.dispatch.is_pressed(id) {
            ButtonState::Pressed
        } else if self.dispatch.is_focused(id) {
            ButtonState::Focused
        } else if self.dispatch.is_hovered(id) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        }
    }

    fn group_region(&self, layout: &GroupLayout) -> Option<InteractionRegion> {
        let group = &self.groups[layout.group_index];
        let (label, bounds) = group.label.zip(layout.label_bounds)?;
        Some(
            InteractionRegion::new(
                "SessionGroupRoot",
                super::identity::sidebar_group_root_id(group.id),
                bounds,
                AccessibilityRole::TreeItem,
                label,
            )
            .with_parent(super::identity::TAB_CONTAINER)
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_level(1)
            .with_expansion(if group.collapsed {
                AccessibilityExpansion::Collapsed
            } else {
                AccessibilityExpansion::Expanded
            }),
        )
    }

    fn paint_group_root(&self, scene: &mut UiScene, layout: &GroupLayout) {
        let group = &self.groups[layout.group_index];
        if let (Some(label), Some(bounds)) = (group.label, layout.label_bounds) {
            let icon_size = 14.0;
            let icon_bounds = Rect::from_xywh(
                bounds.origin.x + 4.0,
                bounds.origin.y + (bounds.size.height - icon_size) * 0.5,
                icon_size,
                icon_size,
            );
            scene.draw_icon(PaintIcon::new(
                if group.collapsed {
                    icons::CHEVRON_RIGHT
                } else {
                    icons::CHEVRON_DOWN
                },
                icon_bounds,
                self.style.colors.muted_foreground,
            ));
            scene.draw_text(TextBlock::new(
                label,
                Point::new(icon_bounds.right() + 4.0, bounds.origin.y + 5.0),
                Size::new((bounds.right() - icon_bounds.right() - 4.0).max(1.0), 18.0),
                self.style
                    .label_text
                    .clone()
                    .with_weight(FontWeight::Medium),
            ));
        }
    }

    fn paint_items(&self, scene: &mut UiScene, layout: &GroupLayout) {
        for (tab, tab_bounds) in self.groups[layout.group_index]
            .tabs
            .iter()
            .zip(layout.item_bounds.iter().copied())
        {
            scene.draw_component(
                &ListItem::new(tab_bounds, self.item_state(tab.id), self.item_style())
                    .with_selection(if tab.id == self.selected_id {
                        ListItemSelection::Selected
                    } else {
                        ListItemSelection::Unselected
                    }),
            );
            self.paint_tab(scene, tab, tab_bounds);
        }
    }

    fn paint_tab(&self, scene: &mut UiScene, tab: &SessionListItem<'_>, tab_bounds: Rect) {
        let action_bar_visible = self.tab_action_bar_visible(tab);
        let icon_bounds = Rect::from_xywh(
            tab_bounds.origin.x + TAB_CONTENT_PADDING,
            tab_bounds.origin.y + (tab_bounds.size.height - SESSION_ICON_SIZE) * 0.5,
            SESSION_ICON_SIZE,
            SESSION_ICON_SIZE,
        );
        if tab.kind == SessionListItemKind::Settings {
            self.paint_settings_icon(scene, icon_bounds, SESSION_ICON_SIZE);
        } else {
            scene.draw_icon(PaintIcon::new(
                session_status_icon(tab.status.kind()),
                icon_bounds,
                self.style.session_status_color(tab.status.kind()),
            ));
        }
        let text_x = icon_bounds.right() + SESSION_ICON_GAP;
        let text_right = if action_bar_visible {
            self.tab_action_bar(tab, tab_bounds).bounds().origin.x - 6.0
        } else if tab.pinned {
            self.pinned_action_icon_bounds(tab, tab_bounds).origin.x - 6.0
        } else {
            tab_bounds.right() - TAB_CONTENT_PADDING
        };
        let text_width = (text_right - text_x).max(1.0);
        scene.draw_text(TextBlock::new(
            tab.name,
            Point::new(text_x, tab_bounds.origin.y + 17.0),
            Size::new(text_width, 18.0),
            self.style.control_text.clone(),
        ));
        if action_bar_visible {
            self.paint_tab_action_bar(scene, tab, tab_bounds);
        } else if tab.pinned {
            self.paint_pinned_action_status(scene, tab, tab_bounds);
        }
    }

    fn paint_settings_icon(&self, scene: &mut UiScene, bounds: Rect, icon_size: f32) {
        let icon_bounds = Rect::from_xywh(
            bounds.origin.x + (bounds.size.width - icon_size) * 0.5,
            bounds.origin.y + (bounds.size.height - icon_size) * 0.5,
            icon_size,
            icon_size,
        );
        scene.draw_icon(PaintIcon::new(
            self.style.settings_icon,
            icon_bounds,
            self.style.colors.muted_foreground,
        ));
    }
}

struct SessionsContent<'container, 'tabs> {
    container: &'container SidebarView<'tabs>,
}

impl Component for SessionsContent<'_, '_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SidebarContent").in_bounds(self.container.layout.content)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.container
            .scroll_view()
            .draw_components(context, |context, _viewport| {
                self.container.compose_visible_groups(context)
            });
        self.container.compose_dirs_preview(context);
    }

    fn paint(&self, scene: &mut UiScene) {
        self.container
            .scroll_view()
            .draw(scene, |scene, _viewport| {
                for layout in self.container.group_layouts() {
                    scene.draw_component(&SessionGroupView {
                        container: self.container,
                        layout,
                    });
                }
            });
    }
}

struct SessionGroupView<'container, 'tabs> {
    container: &'container SidebarView<'tabs>,
    layout: GroupLayout,
}

impl Component for SessionGroupView<'_, '_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SessionGroup")
            .in_bounds(self.layout.bounds.intersection(self.container.layout.list))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        if let Some(region) = self.container.group_region(&self.layout) {
            context.draw_component(&region);
        }
        self.container
            .paint_group_root(context.scene_mut(), &self.layout);
        context.draw_component(&SessionListView {
            container: self.container,
            layout: &self.layout,
        });
    }

    fn paint(&self, scene: &mut UiScene) {
        self.container.paint_group_root(scene, &self.layout);
        scene.draw_component(&SessionListView {
            container: self.container,
            layout: &self.layout,
        });
    }
}

struct SessionListView<'container, 'layout, 'tabs> {
    container: &'container SidebarView<'tabs>,
    layout: &'layout GroupLayout,
}

impl Component for SessionListView<'_, '_, '_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SessionList")
            .gap(TAB_GAP)
            .in_bounds(
                self.layout
                    .list_bounds
                    .intersection(self.container.layout.list),
            )
            .with_identity(self.layout.list_id)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        let group = &self.container.groups[self.layout.group_index];
        let parent = group
            .label
            .map(|_| super::identity::sidebar_group_root_id(group.id))
            .unwrap_or(super::identity::TAB_CONTAINER);
        Some(
            UiNode::new(
                self.layout.list_id,
                element.bounds(),
                AccessibilityRole::List,
                group.label.unwrap_or("Sessions"),
            )
            .with_parent(parent),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.container.paint_items(context.scene_mut(), self.layout);
        let group = &self.container.groups[self.layout.group_index];
        if !group.collapsed {
            for (index, tab) in group.tabs.iter().enumerate() {
                let tab_bounds =
                    self.layout.item_bounds[index].intersection(self.container.layout.list);
                if tab_bounds.is_empty() {
                    continue;
                }
                context.draw_component(&self.container.tab_region(
                    tab,
                    tab_bounds,
                    self.layout.list_id,
                ));
                if self.container.tab_action_bar_visible(tab) {
                    for region in self.container.action_regions(tab, tab_bounds) {
                        context.draw_component(&region);
                    }
                }
            }
        }
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.container.paint_items(scene, self.layout);
    }
}

impl Component for SidebarView<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SidebarView")
            .in_bounds(self.bounds)
            .with_identity(super::identity::TAB_CONTAINER)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                super::identity::TAB_CONTAINER,
                element.bounds(),
                AccessibilityRole::Group,
                "Workbench tabs",
            )
            .with_parent(super::identity::WINDOW),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.scene_mut().draw_rect(
            PaintRect::new(self.bounds, self.style.colors.side_bar_background).with_border(
                Border::new(Edges::new(0.0, 1.0, 0.0, 0.0), self.style.colors.border),
            ),
        );
        context.draw_component(&self.header);
        context.draw_component(&self.toolbar);
        context.draw_component(&SessionsContent { container: self });
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.colors.side_bar_background).with_border(
                Border::new(Edges::new(0.0, 1.0, 0.0, 0.0), self.style.colors.border),
            ),
        );
        scene.draw_component(&self.header);
        scene.draw_component(&self.toolbar);
        scene.draw_component(&SessionsContent { container: self });
    }
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
