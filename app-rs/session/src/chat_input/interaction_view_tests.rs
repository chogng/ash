use super::highlighted_spans;
use zui::ui::Color;
use zui::ui::FontWeight;
use zui::ui::TextStyle;

#[test]
fn slash_label_and_description_emphasize_only_matched_characters() {
    let base = TextStyle::new(12.0, Color::WHITE);
    let label = highlighted_spans("/config", "cofig", base.clone(), Color::WHITE, 1);
    assert_eq!(
        label
            .iter()
            .map(|span| span.style().weight())
            .collect::<Vec<_>>(),
        [
            FontWeight::Normal,
            FontWeight::Bold,
            FontWeight::Bold,
            FontWeight::Normal,
            FontWeight::Bold,
            FontWeight::Bold,
            FontWeight::Bold,
        ]
    );
    let description = highlighted_spans(
        "Open configuration",
        "cofig",
        base.with_color(Color::rgb(80, 80, 80)),
        Color::WHITE,
        0,
    );
    assert_eq!(description[0].style().color(), Color::rgb(80, 80, 80));
    assert_eq!(description[5].style().color(), Color::WHITE);
    assert_eq!(
        description
            .iter()
            .filter(|span| span.style().weight() == FontWeight::Bold)
            .map(|span| span.text())
            .collect::<String>(),
        "cofig"
    );
}
