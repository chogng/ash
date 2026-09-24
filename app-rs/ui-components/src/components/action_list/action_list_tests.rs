use super::ActionList;
use super::ActionListStyle;
use crate::ActionViewItem;
use crate::ButtonBackgrounds;
use crate::ButtonState;
use crate::ButtonStyle;
use crate::Color;
use crate::Rect;
use crate::TextStyle;
use zui::ui::InteractionFrame;
use zui::ui::Point;
use zui::ui::UiFrame;

fn style() -> ActionListStyle {
    ActionListStyle::new(
        ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            TextStyle::new(12.0, Color::WHITE),
        ),
        24.0,
    )
    .with_gap(2.0)
}

#[test]
fn action_list_arranges_action_view_items_in_vertical_rows() {
    let list = ActionList::new(
        Rect::from_xywh(10.0, 20.0, 180.0, 76.0),
        vec![
            ActionViewItem::label("First", ButtonState::Resting),
            ActionViewItem::label("Second", ButtonState::Disabled),
            ActionViewItem::label("Third", ButtonState::Hovered),
        ],
        style(),
    );

    assert_eq!(
        list.item_bounds(0),
        Some(Rect::from_xywh(10.0, 20.0, 180.0, 24.0))
    );
    assert_eq!(
        list.item_bounds(2),
        Some(Rect::from_xywh(10.0, 72.0, 180.0, 24.0))
    );
    assert_eq!(list.interactive_item_bounds(1), None);
    assert_eq!(list.hit_test(Point::new(20.0, 75.0)), Some(2));
}

#[test]
fn action_list_keeps_action_view_item_in_its_inspection_hierarchy() {
    let list = ActionList::new(
        Rect::from_xywh(0.0, 0.0, 160.0, 24.0),
        vec![ActionViewItem::label("Directory", ButtonState::Resting)],
        style(),
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&list);

    let action_bar = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "ActionBar")
        .expect("ActionList should compose ActionBar");
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(action_bar.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        ["ActionList", "ActionBar"]
    );
    assert!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .any(|text| text.text() == "Directory")
    );
}
