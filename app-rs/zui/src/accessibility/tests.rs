use accesskit::Action;
use accesskit::ActionRequest;
use accesskit::NodeId;
use accesskit::Role;
use accesskit::TreeId;
use accesskit::Uuid;

use super::AccessibilityActionKind;
use super::AccessibilitySnapshot;
use super::requested_action;
use crate::runtime::AccessibilityNode;
use crate::ui::foundation::AccessibilityExpansion;
use crate::ui::foundation::AccessibilityRole;
use crate::ui::foundation::AccessibilitySelection;
use crate::ui::foundation::ElementId;
use crate::ui::foundation::NodeAction;
use crate::ui::foundation::Rect;
use crate::window::WindowId;

fn button(id: ElementId, parent: Option<ElementId>) -> AccessibilityNode {
    AccessibilityNode {
        id,
        parent,
        role: AccessibilityRole::Button,
        label: "Run".to_owned(),
        value: None,
        bounds: Rect::from_xywh(10.0, 20.0, 80.0, 30.0),
        focusable: true,
        focused: true,
        action: NodeAction::Activate,
        selection: AccessibilitySelection::NotApplicable,
        level: None,
        expansion: AccessibilityExpansion::NotApplicable,
    }
}

#[test]
fn full_tree_preserves_hierarchy_focus_bounds_and_actions() {
    let group_id = ElementId::scoped(1, 1);
    let button_id = ElementId::scoped(1, 2);
    let mut group = button(group_id, None);
    group.role = AccessibilityRole::Group;
    group.action = NodeAction::None;
    group.focusable = false;
    group.focused = false;
    let snapshot = AccessibilitySnapshot::with_scale_factor(
        "Test window".to_owned(),
        vec![group, button(button_id, Some(group_id))],
        1.0,
    );

    let update = snapshot.full_update();
    assert_eq!(update.tree.as_ref().unwrap().root, snapshot.root);
    assert_eq!(update.focus, NodeId(button_id.into_raw()));
    let root = &update.nodes[0].1;
    assert_eq!(root.label(), Some("Test window"));
    assert_eq!(root.children(), &[NodeId(group_id.into_raw())]);
    let group = &update.nodes[1].1;
    assert_eq!(group.children(), &[NodeId(button_id.into_raw())]);
    let button = &update.nodes[2].1;
    assert!(button.supports_action(Action::Focus));
    assert!(button.supports_action(Action::Click));
    assert_eq!(button.bounds().unwrap().x0, 10.0);
}

#[test]
fn full_tree_preserves_optional_semantics() {
    let target = ElementId::scoped(1, 3);
    let mut node = button(target, None);
    node.value = Some("Running".to_owned());
    node.selection = AccessibilitySelection::Selected;
    node.level = Some(2);
    node.expansion = AccessibilityExpansion::Expanded;
    let snapshot =
        AccessibilitySnapshot::with_scale_factor("Test window".to_owned(), vec![node], 1.0);

    let node = &snapshot.full_update().nodes[1].1;
    assert_eq!(node.value(), Some("Running"));
    assert_eq!(node.is_selected(), Some(true));
    assert_eq!(node.level(), Some(2));
    assert_eq!(node.is_expanded(), Some(true));
}

#[test]
fn full_tree_maps_radio_group_and_radio_button_roles() {
    let group_id = ElementId::scoped(1, 10);
    let radio_id = ElementId::scoped(1, 11);
    let mut group = button(group_id, None);
    group.role = AccessibilityRole::RadioGroup;
    group.action = NodeAction::None;
    group.focusable = false;
    group.focused = false;
    let mut radio = button(radio_id, Some(group_id));
    radio.role = AccessibilityRole::RadioButton;
    radio.selection = AccessibilitySelection::Selected;
    let snapshot =
        AccessibilitySnapshot::with_scale_factor("Test window".to_owned(), vec![group, radio], 1.0);

    let update = snapshot.full_update();
    assert_eq!(update.nodes[1].1.role(), Role::RadioGroup);
    assert_eq!(update.nodes[2].1.role(), Role::RadioButton);
    assert_eq!(update.nodes[2].1.is_selected(), Some(true));
}

#[test]
fn bounds_are_published_in_physical_pixels() {
    let target = ElementId::scoped(2, 1);
    let snapshot = AccessibilitySnapshot::with_scale_factor(
        "Test window".to_owned(),
        vec![button(target, None)],
        2.0,
    );

    let bounds = snapshot.full_update().nodes[1].1.bounds().unwrap();
    assert_eq!(bounds.x0, 20.0);
    assert_eq!(bounds.y0, 40.0);
    assert_eq!(bounds.x1, 180.0);
    assert_eq!(bounds.y1, 100.0);
}

#[test]
fn invalid_scale_factors_fall_back_to_logical_pixels() {
    let target = ElementId::scoped(2, 1);
    for scale_factor in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let snapshot = AccessibilitySnapshot::with_scale_factor(
            "Test window".to_owned(),
            vec![button(target, None)],
            scale_factor,
        );

        assert_eq!(snapshot.full_update().nodes[1].1.bounds().unwrap().x0, 10.0);
    }
}

#[test]
fn only_advertised_actions_target_real_snapshot_nodes() {
    let target = ElementId::scoped(4, 9);
    let snapshot = AccessibilitySnapshot::with_scale_factor(
        "Test window".to_owned(),
        vec![button(target, None)],
        1.0,
    );
    let window = WindowId::from_raw(7);
    let action_request = |action| ActionRequest {
        action,
        target_tree: TreeId::ROOT,
        target_node: NodeId(target.into_raw()),
        data: None,
    };
    let focus = requested_action(window, action_request(Action::Focus), &snapshot).unwrap();
    assert_eq!(focus.kind(), AccessibilityActionKind::Focus);
    let action = requested_action(window, action_request(Action::Click), &snapshot).unwrap();
    assert_eq!(action.window(), window);
    assert_eq!(action.target(), target);
    assert_eq!(action.kind(), AccessibilityActionKind::Activate);

    assert!(requested_action(window, action_request(Action::SetValue), &snapshot).is_none());
    assert!(
        requested_action(
            window,
            ActionRequest {
                target_tree: TreeId(Uuid::from_u128(1)),
                ..action_request(Action::Click)
            },
            &snapshot,
        )
        .is_none()
    );
}

#[test]
fn unsupported_focus_and_click_requests_are_rejected() {
    let passive_id = ElementId::scoped(5, 1);
    let mut passive = button(passive_id, None);
    passive.focusable = false;
    passive.focused = false;
    passive.action = NodeAction::None;
    let snapshot =
        AccessibilitySnapshot::with_scale_factor("Test window".to_owned(), vec![passive], 1.0);
    let window = WindowId::from_raw(7);

    for action in [Action::Focus, Action::Click] {
        assert!(
            requested_action(
                window,
                ActionRequest {
                    action,
                    target_tree: TreeId::ROOT,
                    target_node: NodeId(passive_id.into_raw()),
                    data: None,
                },
                &snapshot,
            )
            .is_none()
        );
    }
}
