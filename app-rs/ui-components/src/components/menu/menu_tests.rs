use super::{Menu, MenuIds, MenuItem, MenuScrollConfiguration, MenuSelection, MenuStyle};
use crate::{
    AccessibilitySelection, ActionBarSeparatorStyle, ActionViewItem, BoxShadow, ButtonBackgrounds,
    ButtonState, ButtonStyle, Color, CornerRadii, ElementId, Point, Rect, ScrollAxis,
    ScrollCommand, ScrollMetrics, ScrollState, ScrollViewStyle, ScrollbarStyle, Size, TextStyle,
    UiDispatch, UiFrame, UiScene,
};
use zui::ui::{Icon, IconDefinition, IconId, InteractionFrame};

const PARENT: ElementId = ElementId::scoped(91, 1);
const ROOT: ElementId = ElementId::scoped(91, 2);
const FIRST: ElementId = ElementId::scoped(91, 3);
const SECOND: ElementId = ElementId::scoped(91, 4);
const SURFACE: Color = Color::rgb(240, 241, 242);
const SELECTED: Color = Color::rgb(210, 211, 212);
const SEPARATOR: Color = Color::rgb(180, 181, 182);
const TEST_ICON: Icon = Icon::new(
    IconId::new("menu-action"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10"/></svg>"#,
    ),
);

fn style() -> MenuStyle {
    MenuStyle::new(
        SURFACE,
        ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            TextStyle::new(13.0, Color::rgb(0, 0, 0)),
        )
        .with_selected_backgrounds(ButtonBackgrounds::new(SELECTED)),
        Size::new(120.0, 28.0),
    )
}

fn menu(items: Vec<MenuItem>) -> Menu {
    Menu::new(
        Rect::from_xywh(30.0, 20.0, 124.0, 60.0),
        "Actions",
        items,
        MenuIds::new(PARENT, ROOT),
        style(),
    )
}

#[test]
fn owns_native_menu_shadow_padding_and_corner_radius() {
    let menu = menu(vec![
        MenuItem::action(FIRST, ActionViewItem::label("Pin", ButtonState::Resting)),
        MenuItem::action(SECOND, ActionViewItem::label("Close", ButtonState::Resting)),
    ]);
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&menu);

    assert_eq!(
        menu.content_bounds(),
        Rect::from_xywh(
            menu.bounds().origin.x + 4.0,
            menu.bounds().origin.y + 4.0,
            menu.bounds().size.width - 8.0,
            menu.bounds().size.height - 8.0
        )
    );
    assert_eq!(
        menu.item_bounds(0).unwrap().origin,
        menu.content_bounds().origin
    );
    assert_eq!(
        scene.rects()[0].shadow(),
        Some(
            BoxShadow::new(Color::rgba(0, 0, 0, 64))
                .with_offset(Point::new(0.0, 4.0))
                .with_blur_radius(26.352_942)
        )
    );
    assert_eq!(scene.rects()[0].corner_radii(), CornerRadii::uniform(4.0));
    assert_eq!(scene.rects()[0].clip_bounds(), None);
}

#[test]
fn selection_skips_disabled_items_and_drives_hit_geometry() {
    let menu = menu(vec![
        MenuItem::action(
            FIRST,
            ActionViewItem::label("Disabled", ButtonState::Disabled),
        ),
        MenuItem::action(
            SECOND,
            ActionViewItem::label("First enabled", ButtonState::Focused),
        ),
    ]);
    let selected_bounds = menu.item_bounds(1).unwrap();
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&menu);

    assert_eq!(menu.selected_index(), Some(1));
    assert_eq!(scene.rects()[2].fill(), SELECTED);
    assert_eq!(
        menu.hit_test(Point::new(
            selected_bounds.origin.x + 1.0,
            selected_bounds.origin.y + 1.0
        )),
        Some(1)
    );
}

#[test]
fn explicit_selection_is_reflected_in_the_accessibility_tree() {
    let menu = menu(vec![
        MenuItem::action(FIRST, ActionViewItem::label("Pin", ButtonState::Resting)),
        MenuItem::action(SECOND, ActionViewItem::label("Close", ButtonState::Focused)),
    ])
    .with_selection(MenuSelection::Item(1));
    let dispatch = UiDispatch::default();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&menu);

    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    let root = nodes.iter().find(|node| node.id == ROOT).unwrap();
    let first = nodes.iter().find(|node| node.id == FIRST).unwrap();
    let second = nodes.iter().find(|node| node.id == SECOND).unwrap();
    assert_eq!(root.label, "Actions");
    assert_eq!(root.parent, Some(PARENT));
    assert_eq!(first.parent, Some(ROOT));
    assert_eq!(second.parent, Some(ROOT));
    assert_eq!(first.selection, AccessibilitySelection::Unselected);
    assert_eq!(second.selection, AccessibilitySelection::Selected);
}

#[test]
fn action_view_content_and_separator_share_menu_geometry_and_semantics() {
    let menu = Menu::new(
        Rect::from_xywh(30.0, 20.0, 124.0, 68.0),
        "Actions",
        vec![
            MenuItem::action(
                FIRST,
                ActionViewItem::icon(TEST_ICON, "Pin tab", ButtonState::Resting),
            ),
            MenuItem::separator(),
            MenuItem::action(SECOND, ActionViewItem::label("Close", ButtonState::Resting)),
        ],
        MenuIds::new(PARENT, ROOT),
        style().with_separator_style(ActionBarSeparatorStyle::new(SEPARATOR)),
    );
    let dispatch = UiDispatch::default();
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&menu);

    assert_eq!(menu.item_bounds(1), None);
    assert_eq!(
        menu.item_bounds(2).unwrap().origin.y,
        menu.content_bounds().origin.y + 36.0
    );
    assert!(
        frame
            .scene()
            .rects()
            .iter()
            .any(|rect| rect.fill() == SEPARATOR)
    );
    assert_eq!(frame.scene().icons().len(), 1);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    assert_eq!(
        nodes.iter().find(|node| node.id == FIRST).unwrap().label,
        "Pin tab"
    );
    assert_eq!(
        nodes
            .iter()
            .filter(|node| node.parent == Some(ROOT))
            .count(),
        2
    );
}

#[test]
fn reserved_header_shifts_items_and_stays_inside_the_menu_tree() {
    let menu = Menu::new(
        Rect::from_xywh(30.0, 20.0, 124.0, 68.0),
        "Branches",
        vec![MenuItem::action(
            FIRST,
            ActionViewItem::label("main", ButtonState::Resting),
        )],
        MenuIds::new(PARENT, ROOT),
        style().with_header_height(36.0),
    );
    let header_bounds = menu.header_bounds().unwrap();
    let mut scene = UiScene::new(Color::TRANSPARENT);

    menu.paint_with_header(&mut scene, |scene, bounds| {
        scene.draw_rect(crate::PaintRect::new(bounds, SELECTED));
    });

    assert_eq!(header_bounds.origin, menu.content_bounds().origin);
    assert_eq!(header_bounds.size.height, 36.0);
    assert_eq!(
        menu.item_bounds(0).unwrap().origin.y,
        header_bounds.bottom()
    );
    assert!(scene.rects().iter().any(|rect| rect.fill() == SELECTED));
}

#[test]
fn scrollable_menu_caps_height_and_translates_item_geometry() {
    let items = (0..5)
        .map(|index| {
            MenuItem::action(
                ElementId::scoped(91, 10 + index),
                ActionViewItem::label(format!("Folder {index}"), ButtonState::Resting),
            )
        })
        .collect::<Vec<_>>();
    let metrics = ScrollMetrics::new(Size::new(120.0, 56.0), Size::new(120.0, 140.0));
    let mut scroll_state = ScrollState::default();
    assert!(scroll_state.apply(
        ScrollCommand::ToEnd(ScrollAxis::Vertical),
        metrics,
        ScrollAxis::Vertical,
    ));
    let menu = Menu::new_scrollable(
        Rect::from_xywh(30.0, 20.0, 128.0, 100.0),
        "Folders",
        items,
        MenuIds::new(PARENT, ROOT),
        style().with_header_height(36.0),
        MenuScrollConfiguration::new(
            scroll_state,
            ScrollViewStyle::new(ScrollbarStyle::new(Color::TRANSPARENT, SELECTED)),
        ),
    );

    assert_eq!(menu.item_viewport_bounds().size.height, 56.0);
    assert_eq!(menu.scroll_metrics(), Some(metrics));
    assert!(menu.item_bounds(0).unwrap().is_empty());
    assert_eq!(
        menu.item_bounds(3).unwrap().origin.y,
        menu.header_bounds().unwrap().bottom()
    );
    assert!(!menu.item_bounds(4).unwrap().is_empty());
}

#[test]
fn scrollable_menu_only_paints_visible_item_content() {
    let items = (0..100)
        .map(|index| {
            MenuItem::action(
                ElementId::scoped(91, 10 + index),
                ActionViewItem::label(format!("Folder {index}"), ButtonState::Resting),
            )
        })
        .collect::<Vec<_>>();
    let menu = Menu::new_scrollable(
        Rect::from_xywh(30.0, 20.0, 124.0, 60.0),
        "Folders",
        items,
        MenuIds::new(PARENT, ROOT),
        style(),
        MenuScrollConfiguration::new(
            ScrollState::default(),
            ScrollViewStyle::new(ScrollbarStyle::new(Color::TRANSPARENT, SELECTED)),
        ),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&menu);

    assert_eq!(
        scene
            .text_blocks()
            .iter()
            .map(|block| block.text())
            .collect::<Vec<_>>(),
        ["Folder 0", "Folder 1"]
    );
    assert!(menu.interactive_item_bounds(99).unwrap().is_empty());
}
