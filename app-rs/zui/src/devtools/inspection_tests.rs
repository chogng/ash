use super::DevToolsHandle;
use super::DevToolsRequest;
use super::DevToolsRequestSender;
use super::InspectionSelection;
use super::InspectorState;
use crate::ui::Point;
use crate::ui::Rect;
use crate::ui::foundation::Color;
use crate::ui::presentation::Element;
use crate::ui::presentation::UiScene;
use crate::window::WindowId;
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn selection_copies_the_deepest_target_and_its_ancestor_path() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_element(
        Element::column("Parent").in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 80.0)),
        |scene, _| {
            scene.with_element(
                Element::leaf("Child").in_bounds(Rect::from_xywh(10.0, 10.0, 40.0, 30.0)),
                |_, _| {},
            );
        },
    );

    let selection = InspectionSelection::at(scene.inspection(), Point::new(20.0, 20.0))
        .expect("point should select a node");

    assert_eq!(selection.path().len(), 2);
    assert_eq!(selection.path()[0].name(), "Parent");
    assert_eq!(selection.target().map(|node| node.name()), Some("Child"));
    assert_eq!(selection.selected_index(), 1);
}

#[test]
fn inspector_state_separates_hovering_from_locked_selection() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_element(
        Element::leaf("Button").in_bounds(Rect::from_xywh(0.0, 0.0, 80.0, 30.0)),
        |_, _| {},
    );
    let selection = InspectionSelection::at(scene.inspection(), Point::new(10.0, 10.0))
        .expect("point should select a node");
    let mut state = InspectorState::default();

    state.open();
    state.toggle_picking();
    state.set_hovered(Some(selection.clone()));
    assert_eq!(state.selection(), Some(&selection));
    assert!(state.locked_selection().is_none());

    assert!(state.select_index(0));
    assert_eq!(state.locked_selection(), Some(&selection));
    assert!(!state.is_picking());
    assert!(!state.select_index(1));

    state.toggle_picking();
    assert!(!state.stop_picking_or_close());
    assert!(state.is_enabled());
    assert!(state.stop_picking_or_close());
    assert!(!state.is_enabled());
}

#[test]
fn toggling_node_expansion_selects_the_toggled_node() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_element(
        Element::column("Parent").in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 80.0)),
        |scene, _| {
            scene.with_element(
                Element::leaf("Child").in_bounds(Rect::from_xywh(10.0, 10.0, 40.0, 30.0)),
                |_, _| {},
            );
        },
    );
    let frame = scene.inspection().clone();
    let parent = frame.nodes()[0].id();
    let child = frame.nodes()[1].id();
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(frame.clone());
    handle.select(Some(
        InspectionSelection::from_node(&frame, child).expect("child should be selectable"),
    ));

    handle.toggle_node_expansion(parent);

    assert!(handle.is_collapsed(parent));
    assert_eq!(
        handle
            .selection()
            .and_then(|selection| selection.target().map(|node| node.id())),
        Some(parent)
    );
}

#[test]
fn devtools_handle_provides_one_shared_session_for_window_capabilities() {
    let first = DevToolsHandle::new();
    let second = first.clone();

    assert!(!first.is_open());
    assert!(second.toggle());
    assert!(first.is_open());

    second.toggle_picking();
    assert!(first.is_picking());
    first.close();
    assert!(!second.is_open());
    assert!(!second.is_picking());
}

#[test]
fn native_handle_requests_the_default_window_without_changing_session_ownership() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let queue = Arc::clone(&requests);
    let sender: DevToolsRequestSender = Arc::new(move |request| {
        queue.lock().expect("request queue lock").push(request);
    });
    let handle = DevToolsHandle::with_request(WindowId::from_raw(7), sender);

    handle.open();
    handle.close();

    assert_eq!(
        *requests.lock().expect("request queue lock"),
        vec![
            DevToolsRequest::SetOpen {
                owner: WindowId::from_raw(7),
                open: true,
            },
            DevToolsRequest::SetOpen {
                owner: WindowId::from_raw(7),
                open: false,
            },
        ]
    );
}
