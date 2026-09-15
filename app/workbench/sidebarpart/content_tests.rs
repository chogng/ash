//! Workbench Sidebar Session content tests.

use std::path::PathBuf;

use super::SidebarView;
use super::mounted_sidebar_item_id;
use super::sidebar_intent_for_element;
use super::sidebar_selected_item_id;
use crate::Color;
use crate::FontWeight;
use crate::Point;
use crate::Rect;
use crate::ScrollAxis;
use crate::ScrollCommand;
use crate::ScrollState;
use crate::ScrollbarPresentation;
use crate::ScrollbarState;
use crate::SidebarIntent;
use crate::SidebarPart;
use crate::TabGroupId;
use crate::TabInput;
use crate::TabInputKey;
use crate::TabInputMetadata;
use crate::TabStatus;
use crate::TabStatusKind;
use crate::sidebarpart::identity::{
    CODE_MODE, COWORK_MODE, FIRST_TAB_CONTAINER_SESSION_TAB, SIDEBAR_MODE_SWITCH,
    TAB_CONTAINER_SETTINGS_ACTION, TAB_CONTAINER_SETTINGS_CLOSE, TAB_CONTAINER_SETTINGS_TAB,
    session_tab_action_id, session_tab_close_id, session_tab_id, sidebar_group_root_id,
    tab_group_list_id,
};
use crate::sidebarpart::test_style;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use zui::ui::AccessibilityExpansion;
use zui::ui::AccessibilityRole;
use zui::ui::AccessibilitySelection;
use zui::ui::BoxShadow;
use zui::ui::InteractionFrame;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;
use zui::ui::UiIntent;

fn session(id: &str, title: &str) -> Session {
    Session {
        session_id: SessionId::new(id).unwrap(),
        title: title.to_owned(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    }
}

fn part_with_two_sessions() -> (SidebarPart, TabInputKey, TabInputKey) {
    let first = session("session-1", "First terminal");
    let second = session("session-2", "Second terminal");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let mut part = SidebarPart::default();
    part.upsert_session_input(TabInput::session(
        first.session_id,
        TabInputMetadata::new(first.title)
            .with_dirs([PathBuf::from("~/first")])
            .with_status(TabStatus::new(TabStatusKind::Working)),
    ));
    part.upsert_session_input(TabInput::session(
        second.session_id,
        TabInputMetadata::new(second.title)
            .with_dirs([PathBuf::from("~/second")])
            .with_status(TabStatus::new(TabStatusKind::Completed)),
    ));
    (part, first_key, second_key)
}

#[test]
fn session_status_icons_cover_the_terminal_manager_states() {
    for (status, icon) in [
        (TabStatusKind::Idle, ash_icons::icons::CIRCLE_SMALL),
        (TabStatusKind::NeedsInput, ash_icons::icons::ENTER),
        (TabStatusKind::Working, ash_icons::icons::SYNC),
        (TabStatusKind::ReadyForReview, ash_icons::icons::CODE_REVIEW),
        (
            TabStatusKind::Completed,
            ash_icons::icons::CIRCLE_SMALL_FILLED,
        ),
        (TabStatusKind::Failed, ash_icons::icons::ERROR),
        (TabStatusKind::Stopped, ash_icons::icons::PAUSE),
    ] {
        assert_eq!(super::session_status_icon(status), icon);
    }
}

#[test]
fn tab_container_resolves_stable_ui_identity_for_each_tab_input() {
    let (part, first_key, second_key) = part_with_two_sessions();

    assert_eq!(
        sidebar_selected_item_id(&part, Some(&first_key)),
        FIRST_TAB_CONTAINER_SESSION_TAB
    );
    assert_eq!(
        sidebar_selected_item_id(&part, Some(&second_key)),
        session_tab_id(part.tab_id(&second_key).unwrap())
    );
    assert_eq!(
        mounted_sidebar_item_id(
            &part,
            &TabInputKey::session(SessionId::new("missing-session").unwrap()),
        ),
        None
    );
}

#[test]
fn sidebar_header_mounts_a_radio_based_mode_switcher() {
    let (part, first_key, _) = part_with_two_sessions();
    let dispatch = UiDispatch::default();
    let sidebar = SidebarView::from_sidebar_part(
        Rect::from_xywh(0.0, 0.0, 220.0, 700.0),
        &part,
        Some(&first_key),
        test_style(),
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&sidebar);

    let switcher = frame.interaction().node(SIDEBAR_MODE_SWITCH).unwrap();
    let cowork = frame.interaction().node(COWORK_MODE).unwrap();
    let code = frame.interaction().node(CODE_MODE).unwrap();
    assert_eq!(switcher.role(), AccessibilityRole::RadioGroup);
    assert_eq!(switcher.label(), "Product mode switcher");
    assert_eq!(switcher.bounds(), Rect::from_xywh(10.0, 8.0, 200.0, 28.0));
    assert_eq!(cowork.parent(), Some(SIDEBAR_MODE_SWITCH));
    assert_eq!(code.parent(), Some(SIDEBAR_MODE_SWITCH));
    assert_eq!(cowork.bounds(), Rect::from_xywh(10.0, 8.0, 98.0, 28.0));
    assert_eq!(code.bounds(), Rect::from_xywh(112.0, 8.0, 98.0, 28.0));
    assert_eq!(cowork.role(), AccessibilityRole::RadioButton);
    assert_eq!(cowork.selection(), AccessibilitySelection::Unselected);
    assert_eq!(code.role(), AccessibilityRole::RadioButton);
    assert_eq!(code.selection(), AccessibilitySelection::Selected);
    let cowork_icon = frame
        .scene()
        .icons()
        .iter()
        .find(|icon| icon.icon() == ash_icons::icons::COWORK)
        .expect("Cowork mode icon");
    let code_icon = frame
        .scene()
        .icons()
        .iter()
        .find(|icon| icon.icon() == ash_icons::icons::CODE)
        .expect("Code mode icon");
    let cowork_label = frame
        .scene()
        .text_blocks()
        .iter()
        .find(|text| text.text() == "Cowork")
        .expect("Cowork mode label");
    let code_label = frame
        .scene()
        .text_blocks()
        .iter()
        .find(|text| text.text() == "Code")
        .expect("Code mode label");
    assert_eq!(cowork_label.origin().x - cowork_icon.bounds().right(), 6.0);
    assert_eq!(code_label.origin().x - code_icon.bounds().right(), 6.0);
    assert_eq!(
        sidebar_intent_for_element(&part, COWORK_MODE),
        Some(SidebarIntent::SetMode(crate::SidebarMode::Cowork))
    );
    let radio_group = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "RadioGroup")
        .expect("ModeSwitcher should compose RadioGroup");
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(radio_group.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        ["SidebarView", "SidebarHeader", "ModeSwitcher", "RadioGroup"]
    );
}

#[test]
fn body_mount_arranges_tabs_vertically_with_session_names_only() {
    let (part, first_key, _) = part_with_two_sessions();
    let dispatch = UiDispatch::default();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&first_key), test_style(), &dispatch);
    let layouts = container.group_layouts();
    let first_bounds = layouts[0].item_bounds[0];
    let second_bounds = layouts[0].item_bounds[1];
    assert_eq!(second_bounds.origin.y - first_bounds.bottom(), 6.0);
    drop(layouts);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&container);

    let inspected_search = frame
        .scene()
        .inspection()
        .target_at(Point::new(
            container.layout.toolbar.origin.x + 20.0,
            container.layout.toolbar.origin.y + 2.0,
        ))
        .expect("Sidebar content should expose the search input hierarchy");
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(inspected_search.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        ["SidebarView", "SessionsToolbar", "SearchBox", "InputBox",]
    );
    let inspected_tab = frame
        .scene()
        .inspection()
        .target_at(Point::new(
            first_bounds.origin.x + 2.0,
            first_bounds.origin.y + 2.0,
        ))
        .expect("tab container content should expose the tab hierarchy");
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(inspected_tab.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        [
            "SidebarView",
            "SidebarContent",
            "ScrollView",
            "SessionGroup",
            "SessionList",
            "SessionListItem",
        ]
    );
    let tab_list = frame
        .scene()
        .inspection()
        .node(inspected_tab.parent().expect("tab inspection parent"))
        .expect("tab list inspection node");
    let inspected_tabs = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .filter(|node| node.parent() == Some(tab_list.id()) && node.name() == "SessionListItem")
        .collect::<Vec<_>>();
    assert_eq!(
        inspected_tabs
            .iter()
            .map(|node| (node.name(), node.label()))
            .collect::<Vec<_>>(),
        [
            ("SessionListItem", Some("First terminal, Working")),
            ("SessionListItem", Some("Second terminal, Completed")),
            ("SessionListItem", Some("Settings")),
        ]
    );

    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .map(|text| text.text())
            .collect::<Vec<_>>(),
        [
            "Cowork",
            "Code",
            "Search sessions...",
            "First terminal",
            "Second terminal",
            "Settings",
        ]
    );
    let selected = frame
        .interaction()
        .accessibility_nodes(&dispatch)
        .into_iter()
        .find(|node| node.id == FIRST_TAB_CONTAINER_SESSION_TAB)
        .unwrap();
    assert_eq!(selected.role, AccessibilityRole::ListItem);
    assert_eq!(selected.selection, AccessibilitySelection::Selected);
    assert_eq!(
        selected.parent,
        Some(tab_group_list_id(TabGroupId::DEFAULT))
    );
    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .find(|text| text.text() == "First terminal")
            .unwrap()
            .style()
            .weight(),
        FontWeight::Medium
    );
    assert_eq!(
        frame
            .scene()
            .icons()
            .iter()
            .filter(|icon| icon.icon() == ash_icons::icons::SYNC)
            .count(),
        1
    );
    assert_eq!(
        frame
            .scene()
            .icons()
            .iter()
            .filter(|icon| icon.icon() == ash_icons::icons::CIRCLE_SMALL_FILLED)
            .count(),
        1
    );
}

#[test]
fn body_mount_scrolls_overflowing_tabs_inside_its_viewport() {
    let mut part = SidebarPart::default();
    let mut keys = Vec::new();
    for index in 0..8 {
        let session = session(&format!("session-{index}"), &format!("Session {index}"));
        let key = TabInputKey::session(session.session_id.clone());
        part.upsert_session_input(TabInput::session(
            session.session_id,
            TabInputMetadata::new(session.title)
                .with_dirs([PathBuf::from(format!("~/session-{index}"))])
                .with_status(TabStatus::new(TabStatusKind::Idle)),
        ));
        keys.push(key);
    }
    let first = mounted_sidebar_item_id(&part, &keys[0]).unwrap();
    let last = mounted_sidebar_item_id(&part, &keys[7]).unwrap();
    let dispatch = UiDispatch::default();
    let bounds = Rect::from_xywh(0.0, 0.0, 220.0, 180.0);
    let initial =
        SidebarView::from_sidebar_part(bounds, &part, Some(&keys[0]), test_style(), &dispatch);
    let content_bounds = initial.layout.content;
    let scroll_view = initial.scroll_view();
    assert_eq!(
        scroll_view.bounds(),
        Rect::from_xywh(
            bounds.origin.x,
            content_bounds.origin.y,
            bounds.size.width,
            content_bounds.size.height,
        )
    );
    assert_eq!(
        scroll_view
            .vertical_scrollbar()
            .expect("overflowing tab list scrollbar")
            .track_bounds()
            .right(),
        bounds.right()
    );
    assert_eq!(
        initial.group_layouts()[0].list_bounds.right(),
        bounds.right() - 10.0
    );
    let mut scroll = ScrollState::default();
    assert!(scroll.apply(
        ScrollCommand::ToEnd(ScrollAxis::Vertical),
        initial.scroll_metrics(),
        ScrollAxis::Vertical,
    ));
    drop(initial);
    let scrolled =
        SidebarView::from_sidebar_part(bounds, &part, Some(&keys[0]), test_style(), &dispatch)
            .with_scroll_state(scroll)
            .with_scrollbar_presentation(ScrollbarPresentation::new(ScrollbarState::Hovered, 1.0));
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&scrolled);

    let inspected_scrollbar = frame
        .scene()
        .inspection()
        .target_at(Point::new(
            bounds.right() - 1.0,
            content_bounds.origin.y + 1.0,
        ))
        .expect("tab container scrollbar should be inspectable");
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(inspected_scrollbar.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        [
            "SidebarView",
            "SidebarContent",
            "ScrollView",
            "VerticalScrollbar"
        ]
    );
    assert!(frame.interaction().node(first).is_none());
    assert!(frame.interaction().node(last).is_some());
    assert!(
        frame
            .interaction()
            .node(TAB_CONTAINER_SETTINGS_TAB)
            .is_some()
    );
    let inspected_tabs = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .filter(|node| node.name() == "SessionListItem")
        .collect::<Vec<_>>();
    assert!(
        inspected_tabs
            .iter()
            .all(|node| node.element_id().is_some())
    );
    assert!(
        inspected_tabs
            .iter()
            .all(|node| node.element_id() != Some(first))
    );
    assert!(
        inspected_tabs
            .iter()
            .any(|node| node.element_id() == Some(last))
    );
    assert!(
        inspected_tabs
            .iter()
            .any(|node| node.element_id() == Some(TAB_CONTAINER_SETTINGS_TAB))
    );
    assert_eq!(
        frame.scene().rects().last().unwrap().fill(),
        Color::rgb(90, 90, 96)
    );
}

#[test]
fn close_button_is_a_child_action_and_resolves_to_the_stable_tab_key() {
    let (part, first_key, _) = part_with_two_sessions();
    let mut dispatch = UiDispatch::default();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let tab_id = part.tab_id(&first_key).unwrap();
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&first_key), test_style(), &dispatch)
            .with_visible_action_bar(session_tab_id(tab_id));
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    frame.draw_component(&container);
    let close_id = session_tab_close_id(tab_id);
    let close_node = frame
        .interaction()
        .accessibility_nodes(&dispatch)
        .into_iter()
        .find(|node| node.id == close_id)
        .unwrap();
    let point = Point::new(
        close_node.bounds.origin.x + 2.0,
        close_node.bounds.origin.y + 2.0,
    );

    assert_eq!(frame.interaction().target_at(point), Some(close_id));
    dispatch.pointer_moved(point, frame.interaction());
    dispatch.press_primary(frame.interaction());
    let outcome = dispatch.release_primary(point, frame.interaction());

    assert_eq!(close_node.role, AccessibilityRole::Button);
    assert_eq!(close_node.parent, Some(session_tab_id(tab_id)));
    assert_eq!(outcome.intent, Some(UiIntent::Activate(close_id)));
    assert_eq!(
        sidebar_intent_for_element(&part, close_id),
        Some(SidebarIntent::Close(first_key))
    );
}

#[test]
fn tab_actions_button_is_hidden_at_rest_and_opens_actions_for_the_stable_tab_key() {
    let (part, first_key, second_key) = part_with_two_sessions();
    let tab_id = part.tab_id(&first_key).unwrap();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let tab_element = session_tab_id(tab_id);
    let action_element = session_tab_action_id(tab_id);
    let close_element = session_tab_close_id(tab_id);
    let mut dispatch = UiDispatch::default();
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch);
    let mut initial = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    initial.draw_component(&container);
    assert!(initial.interaction().node(action_element).is_none());
    assert!(
        initial
            .interaction()
            .node(TAB_CONTAINER_SETTINGS_ACTION)
            .is_none()
    );
    let tab_bounds = initial.interaction().node(tab_element).unwrap().bounds();
    drop(container);

    dispatch.pointer_moved(
        Point::new(tab_bounds.origin.x + 2.0, tab_bounds.origin.y + 2.0),
        initial.interaction(),
    );
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch);
    let mut hovered = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    hovered.draw_component(&container);

    assert_eq!(
        hovered.interaction().node(action_element).unwrap().role(),
        AccessibilityRole::Button
    );
    assert_eq!(
        sidebar_intent_for_element(&part, action_element),
        Some(SidebarIntent::OpenActions(first_key))
    );
    assert_eq!(
        sidebar_intent_for_element(&part, TAB_CONTAINER_SETTINGS_ACTION),
        Some(SidebarIntent::OpenActions(TabInputKey::Settings))
    );
    assert_eq!(
        hovered
            .scene()
            .icons()
            .iter()
            .filter(|icon| icon.icon() == ash_icons::icons::ELLIPSIS)
            .count(),
        1
    );
    let tab_background = hovered
        .scene()
        .rects()
        .iter()
        .find(|rect| rect.bounds() == tab_bounds)
        .expect("hovered tab background");
    assert_eq!(tab_background.fill(), Color::rgb(226, 226, 228));
    let action_bounds = hovered
        .interaction()
        .node(action_element)
        .expect("visible tab action")
        .bounds();
    let close_bounds = hovered
        .interaction()
        .node(close_element)
        .expect("visible tab close")
        .bounds();
    let action_bar_bounds = Rect::from_xywh(
        action_bounds.origin.x,
        action_bounds.origin.y,
        close_bounds.right() - action_bounds.origin.x,
        action_bounds.size.height,
    );
    let action_background = hovered
        .scene()
        .rects()
        .iter()
        .find(|rect| rect.bounds() == action_bar_bounds)
        .expect("tab action background");
    assert_eq!(action_background.fill(), Color::rgb(245, 245, 246));
    assert_eq!(
        hovered
            .scene()
            .icons()
            .iter()
            .find(|icon| icon.icon() == ash_icons::icons::ELLIPSIS)
            .expect("tab actions icon")
            .color(),
        Color::rgb(126, 126, 132)
    );
}

#[test]
fn pinned_status_uses_the_close_slot_until_the_action_bar_is_visible() {
    let (mut part, first_key, second_key) = part_with_two_sessions();
    assert!(part.pin_tab(&first_key));
    let tab_id = part.tab_id(&first_key).unwrap();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let tab_element = session_tab_id(tab_id);
    let close_element = session_tab_close_id(tab_id);
    let mut dispatch = UiDispatch::default();
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch);
    let mut resting = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    resting.draw_component(&container);
    let tab_bounds = resting.interaction().node(tab_element).unwrap().bounds();
    let tab = &container.groups[0].tabs[0];
    let expected_pin_bounds = container.pinned_action_icon_bounds(tab, tab_bounds);
    let pinned_icon = resting
        .scene()
        .icons()
        .iter()
        .find(|icon| icon.icon() == ash_icons::icons::PINNED)
        .expect("resting pinned status");

    assert_eq!(pinned_icon.bounds(), expected_pin_bounds);
    assert!(resting.interaction().node(close_element).is_none());
    drop(container);

    dispatch.pointer_moved(
        Point::new(tab_bounds.origin.x + 2.0, tab_bounds.origin.y + 2.0),
        resting.interaction(),
    );
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch);
    let mut hovered = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    hovered.draw_component(&container);

    assert!(hovered.interaction().node(close_element).is_some());
    assert!(
        hovered
            .scene()
            .icons()
            .iter()
            .all(|icon| icon.icon() != ash_icons::icons::PINNED)
    );
    assert_eq!(
        hovered
            .scene()
            .icons()
            .iter()
            .filter(|icon| icon.icon() == ash_icons::icons::CLOSE)
            .count(),
        1
    );
}

#[test]
fn focused_tab_reveals_its_action_bar() {
    let (part, first_key, second_key) = part_with_two_sessions();
    let tab_id = part.tab_id(&first_key).unwrap();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let mut dispatch = UiDispatch::default();
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch);
    let mut resting = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    resting.draw_component(&container);
    drop(container);

    dispatch.focus_element(resting.interaction(), session_tab_id(tab_id));
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch);
    let mut focused = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    focused.draw_component(&container);

    assert!(
        focused
            .interaction()
            .node(session_tab_action_id(tab_id))
            .is_some()
    );
    assert!(
        focused
            .interaction()
            .node(session_tab_close_id(tab_id))
            .is_some()
    );
}

#[test]
fn explicitly_visible_action_bar_remains_rendered_without_hover() {
    let (part, first_key, second_key) = part_with_two_sessions();
    let tab_id = part.tab_id(&first_key).unwrap();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let tab_element = session_tab_id(tab_id);
    let dispatch = UiDispatch::default();
    let container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&second_key), test_style(), &dispatch)
            .with_visible_action_bar(tab_element);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&container);

    assert!(
        frame
            .interaction()
            .node(session_tab_action_id(tab_id))
            .is_some()
    );
    assert!(
        frame
            .interaction()
            .node(session_tab_close_id(tab_id))
            .is_some()
    );
    assert!(!dispatch.is_hovered(tab_element));
}

#[test]
fn every_hovered_tab_has_an_action_bar() {
    let (part, first_key, second_key) = part_with_two_sessions();
    let first_id = part.tab_id(&first_key).unwrap();
    let second_id = part.tab_id(&second_key).unwrap();
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let tab_ids = [
        session_tab_id(first_id),
        session_tab_id(second_id),
        TAB_CONTAINER_SETTINGS_TAB,
    ];
    let close_ids = [
        session_tab_close_id(first_id),
        session_tab_close_id(second_id),
        TAB_CONTAINER_SETTINGS_CLOSE,
    ];
    let expected = [
        SidebarIntent::Close(first_key.clone()),
        SidebarIntent::Close(second_key),
        SidebarIntent::Close(TabInputKey::Settings),
    ];
    for ((tab_id, close_id), expected) in tab_ids.into_iter().zip(close_ids).zip(expected) {
        let mut dispatch = UiDispatch::default();
        let container = SidebarView::from_sidebar_part(
            bounds,
            &part,
            Some(&first_key),
            test_style(),
            &dispatch,
        );
        let mut initial = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
        initial.draw_component(&container);
        let tab_bounds = initial.interaction().node(tab_id).unwrap().bounds();
        drop(container);
        dispatch.pointer_moved(
            Point::new(tab_bounds.origin.x + 2.0, tab_bounds.origin.y + 2.0),
            initial.interaction(),
        );
        drop(initial);
        let container = SidebarView::from_sidebar_part(
            bounds,
            &part,
            Some(&first_key),
            test_style(),
            &dispatch,
        );
        let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
        frame.draw_component(&container);
        let node = frame.interaction().node(close_id).unwrap();
        assert_eq!(node.role(), AccessibilityRole::Button);
        assert_eq!(sidebar_intent_for_element(&part, close_id), Some(expected));
        assert_eq!(
            frame
                .scene()
                .icons()
                .iter()
                .filter(|icon| icon.icon() == ash_icons::icons::CLOSE)
                .count(),
            1
        );
    }
}

#[test]
fn browser_style_groups_project_as_separate_tab_lists_with_group_labels() {
    let (mut part, first_key, second_key) = part_with_two_sessions();
    let group = part
        .group_tabs([first_key, second_key], "Terminal work")
        .unwrap();
    let dispatch = UiDispatch::default();
    let bounds = Rect::from_xywh(0.0, 0.0, 240.0, 700.0);
    let container = SidebarView::from_sidebar_part(
        bounds,
        &part,
        part.active_tab_key(),
        test_style(),
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&container);

    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    let root = nodes
        .iter()
        .find(|node| node.id == sidebar_group_root_id(group))
        .unwrap();
    assert_eq!(root.role, AccessibilityRole::TreeItem);
    assert_eq!(root.expansion, AccessibilityExpansion::Expanded);
    assert_eq!(
        sidebar_intent_for_element(&part, root.id),
        Some(SidebarIntent::ToggleGroup(group))
    );
    assert!(nodes.iter().any(|node| node.id == tab_group_list_id(group)));
    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .filter(|text| text.text() == "Terminal work")
            .count(),
        1
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == FIRST_TAB_CONTAINER_SESSION_TAB)
            .unwrap()
            .parent,
        Some(tab_group_list_id(group))
    );
    assert!(
        nodes
            .iter()
            .any(|node| node.id == TAB_CONTAINER_SETTINGS_TAB)
    );

    assert!(part.toggle_group(group));
    let collapsed = SidebarView::from_sidebar_part(
        bounds,
        &part,
        part.active_tab_key(),
        test_style(),
        &dispatch,
    );
    let mut collapsed_frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    collapsed_frame.draw_component(&collapsed);
    assert_eq!(
        collapsed_frame
            .interaction()
            .node(sidebar_group_root_id(group))
            .unwrap()
            .expansion(),
        AccessibilityExpansion::Collapsed
    );
    assert!(
        collapsed_frame
            .interaction()
            .node(FIRST_TAB_CONTAINER_SESSION_TAB)
            .is_none()
    );
}

#[test]
fn dirs_preview_lists_every_directory_with_icons_and_exposes_rename() {
    let session = session("session-roots", "Directory session");
    let key = TabInputKey::session(session.session_id.clone());
    let roots = (1..=12)
        .map(|index| PathBuf::from(format!("/dir/root-{index}")))
        .collect::<Vec<_>>();
    let mut part = SidebarPart::default();
    part.upsert_session_input(TabInput::session(
        session.session_id,
        TabInputMetadata::new(session.title)
            .with_dirs(roots.clone())
            .with_status(TabStatus::new(TabStatusKind::ReadyForReview)),
    ));
    let tab_id = part.tab_id(&key).unwrap();
    let tab_element = session_tab_id(tab_id);
    let name = super::dirs_preview_name_id(tab_element);
    let bounds = Rect::from_xywh(0.0, 36.0, 220.0, 664.0);
    let viewport = Rect::from_xywh(0.0, 0.0, 900.0, 700.0);
    let mut dispatch = UiDispatch::default();
    let initial_container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&key), test_style(), &dispatch)
            .with_viewport(viewport);
    let mut initial = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    initial.draw_component(&initial_container);
    let tab_bounds = initial.interaction().node(tab_element).unwrap().bounds();
    drop(initial_container);
    dispatch.pointer_moved(
        Point::new(tab_bounds.origin.x + 2.0, tab_bounds.origin.y + 2.0),
        initial.interaction(),
    );
    let hovered_container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&key), test_style(), &dispatch)
            .with_viewport(viewport);
    let mut hovered = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    hovered.draw_component(&hovered_container);
    let hovered_text = hovered
        .scene()
        .text_blocks()
        .iter()
        .map(|text| text.text())
        .collect::<Vec<_>>();
    assert!(hovered.scene().rects().iter().any(|rect| {
        rect.fill() == Color::rgb(45, 46, 51)
            && rect.shadow()
                == Some(
                    BoxShadow::new(Color::rgba(0, 0, 0, 48))
                        .with_offset(Point::new(0.0, 4.0))
                        .with_blur_radius(12.0),
                )
    }));
    for root in &roots {
        assert!(hovered_text.contains(&root.to_string_lossy().as_ref()));
    }
    let header = hovered
        .scene()
        .text_blocks()
        .iter()
        .find(|text| text.text() == "Directory session  Ready for review")
        .expect("Session status should follow its name in one text line");
    assert_eq!(header.spans().len(), 2);
    assert_eq!(
        hovered
            .scene()
            .icons()
            .iter()
            .filter(|icon| icon.icon() == ash_icons::icons::FOLDERS)
            .count(),
        roots.len()
    );
    let rename = hovered.interaction().node(name).unwrap();
    assert_eq!(rename.role(), AccessibilityRole::Button);
    assert_eq!(
        sidebar_intent_for_element(&part, name),
        Some(SidebarIntent::Rename(key.clone()))
    );
    let action_list = hovered
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "ActionList")
        .expect("directory preview should compose ActionList");
    assert!(
        hovered
            .scene()
            .inspection()
            .ancestry(action_list.id())
            .iter()
            .any(|node| node.name() == "ContextView")
    );

    drop(hovered_container);
    dispatch.pointer_moved(Point::new(850.0, 650.0), hovered.interaction());
    let closed_container =
        SidebarView::from_sidebar_part(bounds, &part, Some(&key), test_style(), &dispatch)
            .with_viewport(viewport);
    let mut closed = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    closed.draw_component(&closed_container);
    assert!(closed.interaction().node(name).is_none());
}
