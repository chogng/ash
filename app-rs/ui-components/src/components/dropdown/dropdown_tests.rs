use super::{Dropdown, DropdownStyle};
use crate::{
    ActionViewItem, ButtonBackgrounds, ButtonState, ButtonStyle, Color, ElementId, MenuIds,
    MenuItem, MenuSelection, MenuStyle, PaintRect, Point, Rect, Size, TextStyle, UiDispatch,
    UiFrame, UiScene,
};
use zui::ui::InteractionFrame;

const PARENT: ElementId = ElementId::scoped(92, 1);
const ROOT: ElementId = ElementId::scoped(92, 2);
const FIRST: ElementId = ElementId::scoped(92, 3);
const SECOND: ElementId = ElementId::scoped(92, 4);
const SURFACE: Color = Color::rgb(240, 241, 242);
const HEADER: Color = Color::rgb(210, 211, 212);

fn style() -> MenuStyle {
    MenuStyle::new(
        SURFACE,
        ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            TextStyle::new(13.0, Color::rgb(0, 0, 0)),
        ),
        Size::new(120.0, 28.0),
    )
}

#[test]
fn anchors_menu_content_and_keeps_its_interaction_tree() {
    let dropdown = Dropdown::new(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Rect::from_xywh(30.0, 20.0, 1.0, 1.0),
        "Tab actions",
        vec![
            MenuItem::action(
                FIRST,
                ActionViewItem::label("Pin", ButtonState::Resting).with_main_axis_extent(32.0),
            ),
            MenuItem::separator(),
            MenuItem::action(SECOND, ActionViewItem::label("Close", ButtonState::Resting)),
        ],
        MenuIds::new(PARENT, ROOT),
        DropdownStyle::new(style()),
    )
    .with_selection(MenuSelection::None);
    let dispatch = UiDispatch::default();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&dropdown);

    assert_eq!(dropdown.menu_root(), ROOT);
    assert_eq!(dropdown.bounds().origin, Point::new(30.0, 21.0));
    assert_eq!(dropdown.bounds().size.height, 76.0);
    assert_eq!(dropdown.content_bounds().origin, Point::new(34.0, 25.0));
    assert_eq!(
        dropdown.item_bounds(0).unwrap().origin,
        dropdown.content_bounds().origin
    );
    assert_eq!(dropdown.item_bounds(1), None);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    assert!(nodes.iter().any(|node| node.id == ROOT));
    assert!(nodes.iter().any(|node| node.id == FIRST));
    assert!(nodes.iter().any(|node| node.id == SECOND));
}

#[test]
fn header_content_is_composed_inside_the_anchored_menu() {
    let dropdown = Dropdown::new(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Rect::from_xywh(30.0, 260.0, 80.0, 24.0),
        "Branches",
        vec![MenuItem::action(
            FIRST,
            ActionViewItem::label("main", ButtonState::Resting),
        )],
        MenuIds::new(PARENT, ROOT),
        DropdownStyle::new(style().with_header_height(36.0)),
    );
    let header_bounds = dropdown.header_bounds().unwrap();
    let mut scene = UiScene::new(Color::TRANSPARENT);

    dropdown.paint_with_header(&mut scene, |scene, bounds| {
        scene.draw_rect(PaintRect::new(bounds, HEADER));
    });

    assert_eq!(header_bounds.origin, dropdown.content_bounds().origin);
    assert_eq!(
        dropdown.item_bounds(0).unwrap().origin.y,
        header_bounds.bottom()
    );
    assert_eq!(dropdown.bounds().size.height, 72.0);
    assert!(scene.rects().iter().any(|rect| rect.fill() == HEADER));
}
