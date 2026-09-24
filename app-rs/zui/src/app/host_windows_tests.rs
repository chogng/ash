use super::all_child_first_close_order;
use super::child_first_close_order;
use crate::window::WindowId;

fn id(value: u64) -> WindowId {
    WindowId::from_raw(value)
}

#[test]
fn close_order_is_stable_depth_first_and_ignores_unrelated_windows() {
    let relationships = [
        (id(1), None),
        (id(4), Some(id(1))),
        (id(2), Some(id(1))),
        (id(3), Some(id(2))),
        (id(5), None),
    ];

    assert_eq!(
        child_first_close_order(id(1), &relationships),
        vec![id(3), id(2), id(4), id(1)]
    );
    assert_eq!(child_first_close_order(id(99), &relationships), Vec::new());
}

#[test]
fn close_order_defensively_terminates_if_relationships_contain_a_cycle() {
    let relationships = [(id(1), Some(id(2))), (id(2), Some(id(1)))];

    assert_eq!(
        child_first_close_order(id(1), &relationships),
        vec![id(2), id(1)]
    );
}

#[test]
fn application_exit_orders_every_tree_child_first_and_stably() {
    let relationships = [
        (id(5), None),
        (id(2), Some(id(1))),
        (id(1), None),
        (id(4), Some(id(3))),
        (id(3), Some(id(99))),
    ];

    assert_eq!(
        all_child_first_close_order(&relationships),
        vec![id(2), id(1), id(4), id(3), id(5)]
    );
}

#[test]
fn application_exit_order_defensively_covers_cyclic_windows_once() {
    let relationships = [(id(1), Some(id(2))), (id(2), Some(id(1))), (id(3), None)];

    assert_eq!(
        all_child_first_close_order(&relationships),
        vec![id(3), id(2), id(1)]
    );
}
