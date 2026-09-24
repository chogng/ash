use super::{QuickInput, QuickInputIds, QuickInputMessageKind, QuickInputStyle};
use crate::{
    CaretVisibility, Color, CornerRadii, Edges, ElementId, FontFamily, InputBoxStateColors,
    InputBoxStyle, InteractionFrame, Point, Rect, SearchBoxStyle, TextInput, TextInputLayoutEngine,
    TextStyle, UiDispatch, UiFrame,
};
use ash_icons::icons;

const PARENT: ElementId = ElementId::scoped(76, 1);
const ROOT: ElementId = ElementId::scoped(76, 2);
const CLOSE: ElementId = ElementId::scoped(76, 3);
const SEARCH: ElementId = ElementId::scoped(76, 4);

fn style() -> QuickInputStyle {
    let text = TextStyle::new(13.0, Color::rgb(32, 32, 32))
        .with_family(FontFamily::SansSerif)
        .with_line_height(18.0);
    let input = InputBoxStyle::new(
        InputBoxStateColors::new(Color::WHITE, Color::WHITE, Color::WHITE),
        InputBoxStateColors::new(
            Color::rgb(220, 220, 220),
            Color::rgb(220, 220, 220),
            Color::rgb(60, 120, 200),
        ),
        text.clone(),
        TextStyle::new(13.0, Color::rgb(120, 120, 120)).with_line_height(18.0),
    )
    .with_corner_radii(CornerRadii::uniform(6.0))
    .with_padding(Edges::new(8.0, 10.0, 8.0, 10.0));
    QuickInputStyle::new(
        Color::rgba(0, 0, 0, 72),
        Color::WHITE,
        Color::rgb(220, 220, 220),
        Color::rgb(32, 32, 32),
        Color::rgb(120, 120, 120),
        Color::rgb(176, 54, 64),
        Color::rgb(235, 235, 235),
        SearchBoxStyle::new(input, icons::SEARCH, Color::rgb(120, 120, 120)),
    )
}

#[test]
fn quick_input_registers_search_and_close_inside_one_dialog() {
    let input = TextInput::default();
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::default();
    let quick_input = QuickInput::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        "Commands",
        "Search commands",
        &input,
        CaretVisibility::Visible,
        QuickInputIds::new(PARENT, ROOT, CLOSE, SEARCH),
        style(),
        &mut text_layout,
        &dispatch,
    )
    .with_message("Choose a command.", QuickInputMessageKind::Status);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&quick_input);

    assert!(frame.interaction().node(CLOSE).is_some());
    assert!(frame.interaction().node(SEARCH).is_some());
    assert!(
        frame
            .interaction()
            .target_at(Point::new(0.0, 0.0))
            .is_none()
    );
    assert!(quick_input.content_bounds().origin.y > quick_input.search_box.bounds().bottom());
}
