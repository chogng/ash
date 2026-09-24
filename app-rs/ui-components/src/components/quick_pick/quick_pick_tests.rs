use super::{QuickPick, QuickPickItem, QuickPickSelection, QuickPickStyle};
use crate::{
    CaretVisibility, Color, CornerRadii, Edges, ElementId, FontFamily, InputBoxStateColors,
    InputBoxStyle, InteractionFrame, Point, QuickInputIds, QuickInputMessageKind, QuickInputStyle,
    Rect, ScrollViewStyle, ScrollbarStyle, SearchBoxStyle, TextInput, TextInputLayoutEngine,
    TextStyle, UiDispatch, UiFrame,
};
use ash_icons::icons;

const PARENT: ElementId = ElementId::scoped(77, 1);
const ROOT: ElementId = ElementId::scoped(77, 2);
const CLOSE: ElementId = ElementId::scoped(77, 3);
const SEARCH: ElementId = ElementId::scoped(77, 4);
const FIRST: ElementId = ElementId::scoped(77, 5);

fn style() -> QuickPickStyle {
    let text = TextStyle::new(13.0, Color::rgb(32, 32, 32))
        .with_family(FontFamily::SansSerif)
        .with_line_height(18.0);
    let input_box = InputBoxStyle::new(
        InputBoxStateColors::new(Color::WHITE, Color::WHITE, Color::WHITE),
        InputBoxStateColors::new(
            Color::rgb(220, 220, 220),
            Color::rgb(220, 220, 220),
            Color::rgb(60, 120, 200),
        ),
        text,
        TextStyle::new(13.0, Color::rgb(120, 120, 120)).with_line_height(18.0),
    )
    .with_corner_radii(CornerRadii::uniform(6.0))
    .with_padding(Edges::new(8.0, 10.0, 8.0, 10.0));
    let input = QuickInputStyle::new(
        Color::rgba(0, 0, 0, 72),
        Color::WHITE,
        Color::rgb(220, 220, 220),
        Color::rgb(32, 32, 32),
        Color::rgb(120, 120, 120),
        Color::rgb(176, 54, 64),
        Color::rgb(235, 235, 235),
        SearchBoxStyle::new(input_box, icons::SEARCH, Color::rgb(120, 120, 120)),
    );
    QuickPickStyle::new(
        input,
        Color::rgb(245, 245, 245),
        Color::rgb(230, 240, 238),
        ScrollViewStyle::new(ScrollbarStyle::new(
            Color::TRANSPARENT,
            Color::rgb(120, 120, 120),
        )),
    )
}

fn quick_pick<'a>(
    items: Vec<QuickPickItem>,
    dispatch: &'a UiDispatch,
    text_layout: &mut TextInputLayoutEngine,
    input: &TextInput,
) -> QuickPick<'a> {
    QuickPick::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        "Commands",
        "Search commands",
        input,
        CaretVisibility::Visible,
        items,
        QuickInputIds::new(PARENT, ROOT, CLOSE, SEARCH),
        style(),
        text_layout,
        dispatch,
    )
}

#[test]
fn quick_pick_composes_search_close_and_visible_items() {
    let dispatch = UiDispatch::default();
    let input = TextInput::default();
    let mut text_layout = TextInputLayoutEngine::default();
    let items = (0..20)
        .map(|index| {
            QuickPickItem::new(
                if index == 0 {
                    FIRST
                } else {
                    ElementId::scoped(77, 5 + index as u32)
                },
                format!("Item {index}"),
            )
        })
        .collect();
    let quick_pick = quick_pick(items, &dispatch, &mut text_layout, &input)
        .with_selection(QuickPickSelection::Item(0))
        .with_message("Choose a command.", QuickInputMessageKind::Status);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&quick_pick);

    assert!(frame.interaction().node(CLOSE).is_some());
    assert!(frame.interaction().node(SEARCH).is_some());
    assert!(frame.interaction().node(FIRST).is_some());
    assert!(
        frame
            .interaction()
            .target_at(Point::new(0.0, 0.0))
            .is_none()
    );
    assert!(
        frame
            .interaction()
            .node(ElementId::scoped(77, 24))
            .is_none()
    );
}

#[test]
fn selected_item_is_projected_into_the_visible_list_viewport() {
    let dispatch = UiDispatch::default();
    let input = TextInput::default();
    let mut text_layout = TextInputLayoutEngine::default();
    let items = (0..20)
        .map(|index| {
            QuickPickItem::new(
                ElementId::scoped(78, 10 + index as u32),
                format!("Item {index}"),
            )
        })
        .collect();
    let last = ElementId::scoped(78, 29);
    let quick_pick = quick_pick(items, &dispatch, &mut text_layout, &input)
        .with_selection(QuickPickSelection::Item(19));
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&quick_pick);

    assert!(frame.interaction().node(last).is_some());
    assert!(
        quick_pick.list_view().item_bounds(19).unwrap().bottom()
            <= quick_pick.input.content_bounds().bottom()
    );
}
