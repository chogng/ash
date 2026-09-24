use super::TAB_CONTEXT_MENU;
use super::TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP;
use super::TAB_RENAME_INPUT;
use super::TabContextMenu;
use super::TabContextMenuAction;
use super::TabContextMenuState;
use super::TabContextMenuStyle;
use super::tab_group_menu_element_id;
use crate::SidebarPart;
use crate::TabInputKey;
use crate::sidebarpart::identity::WINDOW;
use ash_protocol::SessionId;
use zui::ui::AccessibilityRole;
use zui::ui::Border;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::CornerRadii;
use zui::ui::ElementId;
use zui::ui::FontWeight;
use zui::ui::InteractionFrame;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

fn session_tab() -> TabInputKey {
    TabInputKey::session(SessionId::new("session-1").unwrap())
}

fn style() -> TabContextMenuStyle {
    TabContextMenuStyle::new(
        Color::WHITE,
        Color::rgb(220, 220, 220),
        Color::rgb(30, 30, 30),
        Color::rgb(226, 226, 228),
        Color::rgb(210, 32, 32),
    )
}

#[test]
fn menu_owns_current_generic_tab_actions() {
    let mut state = TabContextMenuState::default();
    let target = session_tab();
    state.open_unpinned(target.clone(), Point::new(80.0, 120.0), None);
    let dispatch = UiDispatch::default();
    let part = SidebarPart::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    frame.draw_component(&menu);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);

    assert_eq!(state.target_tab(), Some(&target));
    assert_eq!(
        TabContextMenuAction::ALL.map(|action| action.label(false, false)),
        [
            "Pin",
            "Rename",
            "Fork",
            "Move to group",
            "Archive",
            "Delete"
        ]
    );
    assert_eq!(menu.item_bounds(0).unwrap().size.width, 140.0);
    assert_eq!(menu.item_bounds(0).unwrap().size.height, 28.0);
    assert_eq!(
        menu.item_bounds(4).unwrap().origin.y - menu.item_bounds(2).unwrap().bottom(),
        8.0
    );
    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .map(|text| text.text())
            .collect::<Vec<_>>(),
        [
            "Pin",
            "Rename",
            "Fork",
            "Move to group",
            "Archive",
            "Delete"
        ]
    );
    assert_eq!(frame.scene().icons().len(), 1);
    assert_eq!(
        frame.scene().icons()[0].icon(),
        ash_icons::icons::CHEVRON_RIGHT
    );
    let surface = frame
        .scene()
        .rects()
        .iter()
        .copied()
        .find(|rect| rect.shadow().is_some())
        .expect("menu surface");
    assert_eq!(
        surface.border(),
        Border::uniform(1.0, Color::rgb(220, 220, 220))
    );
    assert_eq!(surface.corner_radii(), CornerRadii::uniform(10.0));
    let first_item = menu.item_bounds(0).unwrap();
    assert_eq!(first_item.origin.x - surface.bounds().origin.x, 6.0);
    assert_eq!(
        frame
            .scene()
            .rects()
            .iter()
            .find(|rect| rect.bounds() == first_item)
            .expect("menu item background")
            .corner_radii(),
        CornerRadii::uniform(10.0)
    );
    assert!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .all(|text| text.style().weight() == FontWeight::SemiBold)
    );
    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .find(|text| text.text() == "Delete")
            .unwrap()
            .style()
            .color(),
        Color::rgb(210, 32, 32)
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == TAB_CONTEXT_MENU)
            .unwrap()
            .role,
        AccessibilityRole::Menu
    );
}

#[test]
fn pinned_target_changes_the_first_action_to_unpin() {
    let mut state = TabContextMenuState::default();
    state.open_pinned(
        session_tab(),
        Point::new(20.0, 30.0),
        Some(ElementId::from_raw(99)),
    );
    let dispatch = UiDispatch::default();
    let part = SidebarPart::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 500.0, 400.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();

    assert!(state.target_is_pinned());
    assert_eq!(TabContextMenuAction::TogglePin.label(true, false), "Unpin");
    assert!(menu.item_bounds(0).is_some());
}

#[test]
fn command_menu_uses_the_dark_fill_for_pointer_hover_even_on_the_focused_item() {
    let mut state = TabContextMenuState::default();
    state.open_unpinned(session_tab(), Point::new(80.0, 120.0), None);
    let mut dispatch = UiDispatch::default();
    let part = SidebarPart::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let first_bounds = menu.item_bounds(0).unwrap();
    let second_bounds = menu.item_bounds(1).unwrap();
    let mut initial = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    initial.draw_component(&menu);
    let first_id = TabContextMenuAction::TogglePin.element_id();
    dispatch.focus_element(initial.interaction(), first_id);
    assert_eq!(dispatch.focused(), Some(first_id));
    drop(initial);
    drop(menu);

    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut focused = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    focused.draw_component(&menu);
    let first_background = focused
        .scene()
        .rects()
        .iter()
        .find(|rect| rect.bounds() == first_bounds)
        .expect("focused command item background");

    assert_eq!(first_background.fill(), Color::TRANSPARENT);
    dispatch.pointer_moved(
        Point::new(first_bounds.origin.x + 2.0, first_bounds.origin.y + 2.0),
        focused.interaction(),
    );
    drop(focused);
    drop(menu);

    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut first_hovered = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    first_hovered.draw_component(&menu);
    let first_background = first_hovered
        .scene()
        .rects()
        .iter()
        .find(|rect| rect.bounds() == first_bounds)
        .expect("hovered focused command item background");

    assert_eq!(first_background.fill(), Color::rgb(226, 226, 228));
    dispatch.pointer_moved(
        Point::new(second_bounds.origin.x + 2.0, second_bounds.origin.y + 2.0),
        first_hovered.interaction(),
    );
    drop(first_hovered);
    drop(menu);

    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut hovered = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    hovered.draw_component(&menu);
    let second_background = hovered
        .scene()
        .rects()
        .iter()
        .find(|rect| rect.bounds() == second_bounds)
        .expect("hovered command item background");

    assert_eq!(second_background.fill(), Color::rgb(226, 226, 228));
}

#[test]
fn move_to_group_opens_a_secondary_menu_with_existing_and_new_group_targets() {
    let mut part = SidebarPart::default();
    let first = session_tab();
    let second = TabInputKey::session(SessionId::new("session-2").unwrap());
    part.upsert_session_input(crate::TabInput::session(
        first.session_id().unwrap().clone(),
        crate::TabInputMetadata::new("First"),
    ));
    part.upsert_session_input(crate::TabInput::session(
        second.session_id().unwrap().clone(),
        crate::TabInputMetadata::new("Second"),
    ));
    let group = part.group_tabs([second], "Other group").unwrap();
    let mut state = TabContextMenuState::default();
    state.open_unpinned(first, Point::new(80.0, 120.0), None);
    assert_eq!(
        state.activate(TabContextMenuAction::MoveToGroup.element_id()),
        super::TabContextMenuActivation::OpenGroupMenu
    );
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    frame.draw_component(&menu);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);

    assert!(
        nodes
            .iter()
            .any(|node| node.id == tab_group_menu_element_id(group))
    );
    assert!(
        nodes
            .iter()
            .any(|node| node.id == TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP)
    );
    let move_bounds = menu
        .item_bounds(TabContextMenuAction::MoveToGroup.menu_index())
        .unwrap();
    let group_bounds = frame
        .interaction()
        .node(super::TAB_CONTEXT_MENU_GROUPS)
        .unwrap()
        .bounds();
    let bridge = Point::new(
        (move_bounds.right() + group_bounds.origin.x) * 0.5,
        move_bounds.origin.y + 1.0,
    );
    assert!(super::tab_context_menu_groups_contain_pointer(
        Point::new(move_bounds.origin.x + 1.0, move_bounds.origin.y + 1.0),
        frame.interaction()
    ));
    assert!(super::tab_context_menu_groups_contain_pointer(
        Point::new(group_bounds.origin.x + 1.0, group_bounds.origin.y + 1.0),
        frame.interaction()
    ));
    assert!(super::tab_context_menu_groups_contain_pointer(
        bridge,
        frame.interaction()
    ));
    assert!(!super::tab_context_menu_groups_contain_pointer(
        Point::new(
            menu.item_bounds(0).unwrap().origin.x + 1.0,
            menu.item_bounds(0).unwrap().origin.y + 1.0,
        ),
        frame.interaction()
    ));
}

#[test]
fn move_to_group_hover_exposes_the_submenu_transition() {
    let mut state = TabContextMenuState::default();
    state.open_unpinned(session_tab(), Point::new(80.0, 120.0), None);
    let mut dispatch = UiDispatch::default();
    let part = SidebarPart::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let move_bounds = menu.item_bounds(4).unwrap();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    frame.draw_component(&menu);

    super::update_tab_context_menu_pointer(
        &mut dispatch,
        Point::new(move_bounds.origin.x + 2.0, move_bounds.origin.y + 2.0),
        frame.interaction(),
    );

    assert!(dispatch.is_hovered(TabContextMenuAction::MoveToGroup.element_id()));
    assert!(state.open_group_menu());
    assert!(state.is_group_menu_open());
}

#[test]
fn group_menu_closes_back_to_actions() {
    let mut state = TabContextMenuState::default();
    state.open_unpinned(session_tab(), Point::new(80.0, 120.0), None);

    assert!(state.open_group_menu());
    assert!(state.close_group_menu());
    assert!(!state.is_group_menu_open());
    assert!(!state.close_group_menu());
}

#[test]
fn delete_requires_an_explicit_second_activation() {
    let mut state = TabContextMenuState::default();
    let target = session_tab();
    state.open_unpinned(target.clone(), Point::new(80.0, 120.0), None);

    assert_eq!(
        state.activate(TabContextMenuAction::Delete.element_id()),
        super::TabContextMenuActivation::ConfirmDelete
    );
    assert_eq!(
        TabContextMenuAction::Delete.label(false, true),
        "Confirm delete"
    );
    assert_eq!(
        state.activate(TabContextMenuAction::Delete.element_id()),
        super::TabContextMenuActivation::Delete(target)
    );
}

#[test]
fn rename_action_presents_the_workbench_owned_text_input() {
    let mut part = SidebarPart::default();
    let target = session_tab();
    part.upsert_session_input(crate::TabInput::session(
        target.session_id().unwrap().clone(),
        crate::TabInputMetadata::new("First"),
    ));
    let mut state = TabContextMenuState::default();
    state.open_unpinned(target, Point::new(80.0, 120.0), None);
    assert!(matches!(
        state.activate(TabContextMenuAction::Rename.element_id()),
        super::TabContextMenuActivation::BeginRename(_)
    ));
    assert!(state.set_rename_text("Renamed tab"));
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = TabContextMenu::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &part,
        &state,
        CaretVisibility::Visible,
        style(),
        WINDOW,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    frame.draw_component(&menu);
    let rename = frame.interaction().node(TAB_RENAME_INPUT).unwrap();

    assert_eq!(rename.role(), AccessibilityRole::TextInput);
    assert_eq!(rename.value(), Some("Renamed tab"));
    assert!(
        frame
            .scene()
            .inspection()
            .nodes()
            .iter()
            .any(|node| node.name() == "ContextView")
    );
}
