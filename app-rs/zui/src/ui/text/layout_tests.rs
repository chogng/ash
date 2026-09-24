use super::{TextLayoutEngine, TextLayoutWidth};
use crate::{Color, FontWeight, Point, TextSpan, TextStyle};

#[test]
fn measures_wrapped_rich_text_as_one_shaped_paragraph() {
    let style = TextStyle::new(12.0, Color::rgb(30, 30, 30)).with_line_height(18.0);
    let spans = vec![
        TextSpan::new("alpha ", style.clone()),
        TextSpan::new("beta gamma", style.clone().with_weight(FontWeight::Bold)),
    ];
    let mut engine = TextLayoutEngine::new();

    let unbounded = engine.measure_spans(&spans, &style, TextLayoutWidth::Unbounded);
    let wrapped =
        engine.measure_spans(&spans, &style, TextLayoutWidth::Wrap(unbounded.width * 0.6));

    assert!(unbounded.width > 0.0);
    assert_eq!(unbounded.height, 18.0);
    assert!(wrapped.height >= 36.0);
}

#[test]
fn empty_text_has_no_layout_extent() {
    let mut engine = TextLayoutEngine::new();
    let style = TextStyle::new(12.0, Color::rgb(30, 30, 30));

    assert_eq!(
        engine.measure_text("", &style, TextLayoutWidth::Unbounded),
        crate::Size::new(0.0, 0.0)
    );
}

#[test]
fn exposes_wrapped_visual_fragments_for_each_rich_text_span() {
    let style = TextStyle::new(12.0, Color::rgb(30, 30, 30)).with_line_height(18.0);
    let spans = vec![
        TextSpan::new("alpha ", style.clone()),
        TextSpan::new(
            "beta gamma delta",
            style.clone().with_weight(FontWeight::Bold),
        ),
    ];
    let mut engine = TextLayoutEngine::new();
    let width = engine
        .measure_spans(&spans, &style, TextLayoutWidth::Unbounded)
        .width
        * 0.45;

    let layout = engine.layout_spans(&spans, &style, TextLayoutWidth::Wrap(width));

    assert!(layout.size().height >= 36.0);
    assert!(!layout.span_fragments(0).is_empty());
    assert!(layout.span_fragments(1).len() >= 2);
    assert!(
        layout
            .span_fragments(1)
            .iter()
            .all(|fragment| fragment.size.width > 0.0 && fragment.size.height == 18.0)
    );
    assert!(layout.span_fragments(99).is_empty());
}

#[test]
fn maps_points_and_utf8_ranges_to_shaped_visual_geometry() {
    let style = TextStyle::new(14.0, Color::rgb(30, 30, 30)).with_line_height(20.0);
    let spans = [TextSpan::new("alpha 世界 beta", style.clone())];
    let mut engine = TextLayoutEngine::new();
    let layout = engine.layout_spans(&spans, &style, TextLayoutWidth::Wrap(70.0));

    let fragments = layout.range_fragments(6.."alpha 世界".len());
    assert!(!fragments.is_empty());
    let first = fragments[0];
    let hit = layout
        .hit_test(Point::new(
            first.origin.x + first.size.width * 0.5,
            first.origin.y + first.size.height * 0.5,
        ))
        .unwrap();
    assert!((6..="alpha 世界".len()).contains(&hit));
}
