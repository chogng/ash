//! Cross-surface interaction, focus, activation, and semantics regression tests.

use crate::Point;
use crate::Rect;

use super::AccessibilityExpansion;
use super::AccessibilityRole;
use super::CursorFeedback;
use super::DispatchInvalidation;
use super::ElementId;
use super::FocusBehavior;
use super::FocusDirection;
use super::InteractionFrame;
use super::NavigationAxis;
use super::NavigationGroupId;
use super::NodeAction;
use super::UiDispatch;
use super::UiIntent;
use super::UiNode;

const ROOT: ElementId = ElementId::scoped(1, 1);
const INPUT: ElementId = ElementId::scoped(1, 2);
const TOOLBAR: ElementId = ElementId::scoped(1, 3);
const FIRST: ElementId = ElementId::scoped(1, 4);
const SECOND: ElementId = ElementId::scoped(1, 5);
const MENU: ElementId = ElementId::scoped(1, 6);
const MENU_ITEM: ElementId = ElementId::scoped(1, 7);
const FRAGMENT_BUTTON: ElementId = ElementId::scoped(1, 8);
const DISCLOSURE: ElementId = ElementId::scoped(1, 9);
const VALUE: ElementId = ElementId::scoped(1, 10);
const VALUE_INCREMENT: ElementId = ElementId::scoped(1, 11);

fn frame() -> InteractionFrame {
    let mut frame = InteractionFrame::default();
    frame.register(UiNode::new(
        ROOT,
        Rect::from_xywh(0.0, 0.0, 300.0, 200.0),
        AccessibilityRole::Window,
        "app",
    ));
    frame.register(
        UiNode::new(
            INPUT,
            Rect::from_xywh(20.0, 20.0, 260.0, 40.0),
            AccessibilityRole::TextInput,
            "Command input",
        )
        .with_parent(ROOT)
        .with_cursor(CursorFeedback::Text)
        .with_focus(FocusBehavior::TabStop),
    );
    frame.register(
        UiNode::new(
            TOOLBAR,
            Rect::from_xywh(20.0, 80.0, 260.0, 30.0),
            AccessibilityRole::Toolbar,
            "Input context",
        )
        .with_parent(ROOT),
    );
    let group = NavigationGroupId::new(TOOLBAR);
    for (id, x, label) in [(FIRST, 20.0, "Local"), (SECOND, 90.0, "Working directory")] {
        frame.register(
            UiNode::new(
                id,
                Rect::from_xywh(x, 80.0, 60.0, 24.0),
                AccessibilityRole::Button,
                label,
            )
            .with_parent(TOOLBAR)
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(group, NavigationAxis::Horizontal),
        );
    }
    frame
}

fn frame_with_modal_menu() -> InteractionFrame {
    let mut frame = frame();
    frame.register(
        UiNode::new(
            MENU,
            Rect::from_xywh(100.0, 40.0, 120.0, 80.0),
            AccessibilityRole::Menu,
            "Actions",
        )
        .with_parent(ROOT),
    );
    frame.register(
        UiNode::new(
            MENU_ITEM,
            Rect::from_xywh(102.0, 42.0, 116.0, 30.0),
            AccessibilityRole::MenuItem,
            "Close",
        )
        .with_parent(MENU)
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate),
    );
    frame.set_modal_root(MENU);
    frame
}

fn frame_with_fragment_button() -> InteractionFrame {
    let mut frame = InteractionFrame::default();
    frame.register(
        UiNode::new(
            FRAGMENT_BUTTON,
            Rect::from_xywh(20.0, 20.0, 100.0, 30.0),
            AccessibilityRole::Button,
            "Fragment button",
        )
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_invalidation(DispatchInvalidation::Fragment),
    );
    frame
}

#[test]
fn hit_testing_prefers_the_last_painted_child_and_projects_ancestry_hover() {
    let frame = frame();
    let mut dispatch = UiDispatch::default();

    assert_eq!(
        dispatch
            .pointer_moved(Point::new(25.0, 85.0), &frame)
            .invalidation,
        DispatchInvalidation::Paint
    );
    assert!(dispatch.is_hovered(ROOT));
    assert!(dispatch.is_hovered(TOOLBAR));
    assert!(dispatch.is_hovered(FIRST));
    assert_eq!(dispatch.pointer_feedback(&frame), CursorFeedback::Pointer);
}

#[test]
fn host_resolved_hover_projects_a_stable_element_without_pointer_movement() {
    let frame = frame();
    let mut dispatch = UiDispatch::default();
    dispatch.pointer_moved(Point::new(25.0, 85.0), &frame);

    assert_eq!(
        dispatch.hover_element(SECOND, &frame).invalidation,
        DispatchInvalidation::Paint
    );
    assert!(dispatch.is_hovered(ROOT));
    assert!(dispatch.is_hovered(TOOLBAR));
    assert!(dispatch.is_hovered(SECOND));
    assert!(!dispatch.is_hovered(FIRST));
}

#[test]
fn interaction_checkpoint_restores_nodes_and_modal_scope() {
    let mut frame = frame();
    let checkpoint = frame.checkpoint();
    frame.register(
        UiNode::new(
            MENU,
            Rect::from_xywh(100.0, 40.0, 120.0, 80.0),
            AccessibilityRole::Menu,
            "Actions",
        )
        .with_parent(ROOT),
    );
    frame.set_modal_root(MENU);
    assert_eq!(frame.target_at(Point::new(25.0, 85.0)), None);

    frame.restore(checkpoint);

    assert!(frame.node(MENU).is_none());
    assert_eq!(frame.target_at(Point::new(25.0, 85.0)), Some(FIRST));
}

#[test]
fn pointer_capture_only_activates_when_release_returns_to_the_pressed_button() {
    let frame = frame();
    let mut dispatch = UiDispatch::default();
    dispatch.pointer_moved(Point::new(25.0, 85.0), &frame);

    dispatch.press_primary(&frame);
    dispatch.pointer_moved(Point::new(200.0, 150.0), &frame);
    assert_eq!(
        dispatch
            .release_primary(Point::new(200.0, 150.0), &frame)
            .intent,
        None
    );

    dispatch.pointer_moved(Point::new(25.0, 85.0), &frame);
    dispatch.press_primary(&frame);
    assert_eq!(
        dispatch
            .release_primary(Point::new(25.0, 85.0), &frame)
            .intent,
        Some(UiIntent::Activate(FIRST))
    );
}

#[test]
fn fragment_nodes_keep_fast_pointer_interaction_on_the_retained_path() {
    let frame = frame_with_fragment_button();
    let mut dispatch = UiDispatch::default();
    let point = Point::new(25.0, 25.0);

    let hover = dispatch.pointer_moved(point, &frame);
    assert_eq!(hover.invalidation, DispatchInvalidation::Fragment);
    assert_eq!(hover.fragment, Some(FRAGMENT_BUTTON));
    assert_eq!(
        dispatch.press_primary(&frame).invalidation,
        DispatchInvalidation::Fragment
    );
    let release = dispatch.release_primary(point, &frame);
    assert_eq!(release.invalidation, DispatchInvalidation::Fragment);
    assert_eq!(release.fragment, Some(FRAGMENT_BUTTON));
    assert_eq!(release.intent, Some(UiIntent::Activate(FRAGMENT_BUTTON)));
}

#[test]
fn fragment_hover_falls_back_to_full_paint_when_crossing_a_paint_boundary() {
    let mut frame = frame();
    frame.register(
        UiNode::new(
            FRAGMENT_BUTTON,
            Rect::from_xywh(20.0, 20.0, 100.0, 30.0),
            AccessibilityRole::Button,
            "Fragment button",
        )
        .with_cursor(CursorFeedback::Pointer)
        .with_invalidation(DispatchInvalidation::Fragment),
    );
    let mut dispatch = UiDispatch::default();

    assert_eq!(
        dispatch
            .pointer_moved(Point::new(25.0, 25.0), &frame)
            .invalidation,
        DispatchInvalidation::Fragment
    );
    let crossing = dispatch.pointer_moved(Point::new(25.0, 85.0), &frame);
    assert_eq!(crossing.invalidation, DispatchInvalidation::Paint);
    assert_eq!(crossing.fragment, None);
    let entering = dispatch.pointer_moved(Point::new(25.0, 25.0), &frame);
    assert_eq!(entering.invalidation, DispatchInvalidation::Paint);
    assert_eq!(entering.fragment, None);
}

#[test]
fn leaving_a_fragment_clears_the_retained_hover_identity() {
    let frame = frame_with_fragment_button();
    let mut dispatch = UiDispatch::default();

    dispatch.pointer_moved(Point::new(25.0, 25.0), &frame);
    let leaving = dispatch.pointer_moved(Point::new(200.0, 150.0), &frame);
    assert_eq!(leaving.invalidation, DispatchInvalidation::Fragment);
    assert_eq!(leaving.fragment, Some(FRAGMENT_BUTTON));
    assert_eq!(
        dispatch.pointer_left().invalidation,
        DispatchInvalidation::None
    );
    let reentering = dispatch.pointer_moved(Point::new(25.0, 25.0), &frame);
    assert_eq!(reentering.invalidation, DispatchInvalidation::Fragment);
    assert_eq!(reentering.fragment, Some(FRAGMENT_BUTTON));
}

#[test]
fn tab_order_and_horizontal_navigation_share_the_same_focus_owner() {
    let frame = frame();
    let mut dispatch = UiDispatch::default();
    dispatch.reconcile_focus(&frame, INPUT);
    assert!(dispatch.is_focused(INPUT));

    dispatch.focus_in_order(&frame, FocusDirection::Next);
    assert!(dispatch.is_focused(FIRST));
    dispatch.focus_within_group(&frame, FocusDirection::Next, NavigationAxis::Horizontal);
    assert!(dispatch.is_focused(SECOND));
    dispatch.focus_in_order(&frame, FocusDirection::Previous);
    assert!(dispatch.is_focused(FIRST));
}

#[test]
fn ancestry_fails_closed_when_parent_links_form_a_cycle() {
    let first = ElementId::scoped(3, 1);
    let second = ElementId::scoped(3, 2);
    let mut frame = InteractionFrame::default();
    frame.register(
        UiNode::new(
            first,
            Rect::from_xywh(0.0, 0.0, 100.0, 24.0),
            AccessibilityRole::Group,
            "First",
        )
        .with_parent(second),
    );
    frame.register(
        UiNode::new(
            second,
            Rect::from_xywh(0.0, 24.0, 100.0, 24.0),
            AccessibilityRole::Group,
            "Second",
        )
        .with_parent(first),
    );

    assert!(frame.ancestry(first).is_empty());
}

#[test]
fn keyboard_activation_and_accessibility_use_the_focused_node_identity() {
    let frame = frame();
    let mut dispatch = UiDispatch::default();
    dispatch.reconcile_focus(&frame, FIRST);

    assert_eq!(
        dispatch.activate_focused(&frame).intent,
        Some(UiIntent::Activate(FIRST))
    );
    let nodes = frame.accessibility_nodes(&dispatch);
    let button = nodes.iter().find(|node| node.id == FIRST).unwrap();
    assert_eq!(button.parent, Some(TOOLBAR));
    assert_eq!(button.role, AccessibilityRole::Button);
    assert_eq!(button.label, "Local");
    assert_eq!(button.value, None);
    assert_eq!(
        button.selection,
        super::AccessibilitySelection::NotApplicable
    );
    assert!(button.focusable);
    assert!(button.focused);
    assert_eq!(button.bounds, Rect::from_xywh(20.0, 80.0, 60.0, 24.0));
}

#[test]
fn disclosure_activation_toggles_view_state_and_unmounted_controls_reset_it() {
    let mut disclosure_frame = frame();
    disclosure_frame.register(
        UiNode::new(
            DISCLOSURE,
            Rect::from_xywh(160.0, 80.0, 100.0, 24.0),
            AccessibilityRole::Button,
            "Show all",
        )
        .with_parent(TOOLBAR)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::ToggleExpansion)
        .with_expansion(AccessibilityExpansion::Collapsed),
    );
    let mut dispatch = UiDispatch::default();
    dispatch.pointer_moved(Point::new(170.0, 85.0), &disclosure_frame);
    dispatch.press_primary(&disclosure_frame);

    let outcome = dispatch.release_primary(Point::new(170.0, 85.0), &disclosure_frame);

    assert_eq!(outcome.intent, None);
    assert!(dispatch.is_expanded(DISCLOSURE));
    assert_eq!(
        dispatch.reconcile_focus(&frame(), INPUT).invalidation,
        DispatchInvalidation::Paint
    );
    assert!(!dispatch.is_expanded(DISCLOSURE));
}

#[test]
fn value_adjustment_clamps_and_resets_when_its_target_unmounts() {
    let mut value_frame = frame();
    value_frame.register(UiNode::new(
        VALUE,
        Rect::from_xywh(160.0, 110.0, 100.0, 24.0),
        AccessibilityRole::Group,
        "Scroll position",
    ));
    value_frame.register(
        UiNode::new(
            VALUE_INCREMENT,
            Rect::from_xywh(160.0, 140.0, 100.0, 24.0),
            AccessibilityRole::Button,
            "Scroll down",
        )
        .with_action(NodeAction::AdjustValue {
            target: VALUE,
            delta: 3,
            minimum: 0,
            maximum: 5,
        }),
    );
    let mut dispatch = UiDispatch::default();
    for _ in 0..2 {
        dispatch.pointer_moved(Point::new(170.0, 145.0), &value_frame);
        dispatch.press_primary(&value_frame);
        dispatch.release_primary(Point::new(170.0, 145.0), &value_frame);
    }

    assert_eq!(dispatch.value(VALUE), 5);
    assert_eq!(
        dispatch.reconcile_focus(&frame(), INPUT).invalidation,
        DispatchInvalidation::Paint
    );
    assert_eq!(dispatch.value(VALUE), 0);
}

#[test]
fn tree_item_accessibility_retains_level_and_expansion() {
    let tree = ElementId::scoped(2, 1);
    let item = ElementId::scoped(2, 2);
    let mut frame = InteractionFrame::default();
    frame.register(UiNode::new(
        tree,
        Rect::from_xywh(0.0, 0.0, 200.0, 100.0),
        AccessibilityRole::Tree,
        "Files",
    ));
    frame.register(
        UiNode::new(
            item,
            Rect::from_xywh(0.0, 0.0, 200.0, 24.0),
            AccessibilityRole::TreeItem,
            "src",
        )
        .with_parent(tree)
        .with_level(2)
        .with_expansion(AccessibilityExpansion::Expanded),
    );

    let nodes = frame.accessibility_nodes(&UiDispatch::default());
    let item = nodes.iter().find(|node| node.id == item).unwrap();
    assert_eq!(item.level, Some(2));
    assert_eq!(item.expansion, AccessibilityExpansion::Expanded);
}

#[test]
fn window_blur_clears_transient_pointer_state_but_retains_focus_identity() {
    let frame = frame();
    let mut dispatch = UiDispatch::default();
    dispatch.reconcile_focus(&frame, FIRST);
    dispatch.pointer_moved(Point::new(25.0, 85.0), &frame);
    dispatch.press_primary(&frame);

    dispatch.window_blurred();

    assert!(!dispatch.is_hovered(FIRST));
    assert!(!dispatch.is_pressed(FIRST));
    assert!(!dispatch.is_focused(FIRST));
    assert_eq!(dispatch.focused(), Some(FIRST));
    dispatch.window_focused();
    assert!(dispatch.is_focused(FIRST));
}

#[test]
fn modal_root_makes_background_pointer_targets_inert() {
    let frame = frame_with_modal_menu();
    let mut dispatch = UiDispatch::default();

    assert_eq!(frame.target_at(Point::new(25.0, 25.0)), None);
    assert_eq!(frame.target_at(Point::new(110.0, 50.0)), Some(MENU_ITEM));
    dispatch.pointer_moved(Point::new(25.0, 25.0), &frame);
    assert!(!dispatch.is_hovered(ROOT));
    assert!(!dispatch.is_hovered(INPUT));
    dispatch.pointer_moved(Point::new(110.0, 50.0), &frame);
    assert!(dispatch.is_hovered(MENU));
    assert!(dispatch.is_hovered(MENU_ITEM));
    assert!(!dispatch.is_hovered(ROOT));
}

#[test]
fn modal_root_traps_focus_and_activation_in_its_subtree() {
    let base_frame = frame();
    let modal_frame = frame_with_modal_menu();
    let mut dispatch = UiDispatch::default();
    dispatch.reconcile_focus(&base_frame, INPUT);

    dispatch.reconcile_focus(&modal_frame, INPUT);

    assert!(dispatch.is_focused(MENU_ITEM));
    assert_eq!(
        modal_frame.focus_order().collect::<Vec<_>>(),
        vec![MENU_ITEM]
    );
    dispatch.focus_element(&modal_frame, INPUT);
    assert!(dispatch.is_focused(MENU_ITEM));
    assert_eq!(
        dispatch.activate_focused(&modal_frame).intent,
        Some(UiIntent::Activate(MENU_ITEM))
    );
    let nodes = modal_frame.accessibility_nodes(&dispatch);
    assert!(
        !nodes
            .iter()
            .find(|node| node.id == INPUT)
            .unwrap()
            .focusable
    );
    assert!(
        nodes
            .iter()
            .find(|node| node.id == MENU_ITEM)
            .unwrap()
            .focusable
    );
}
