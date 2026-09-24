use super::{KeycapSequence, KeycapStyle};
use crate::{Color, Point, UiScene};

#[test]
fn sequence_uses_small_gaps_within_a_chord_and_larger_gaps_between_chords() {
    let style = KeycapStyle::new(Color::rgb(48, 48, 52), Color::WHITE)
        .with_key_gap(3.0)
        .with_chord_gap(9.0);
    let sequence = KeycapSequence::new(
        Point::new(10.0, 5.0),
        vec![
            vec!["⌘".to_owned(), "K".to_owned()],
            vec!["⌘".to_owned(), "C".to_owned()],
        ],
        style,
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.draw_component(&sequence);

    assert_eq!(scene.rects().len(), 4);
    assert_eq!(scene.text_blocks().len(), 4);
    assert_eq!(scene.text_blocks()[0].text(), "⌘");
    assert_eq!(
        scene.rects()[2].bounds().origin.x - scene.rects()[1].bounds().right(),
        9.0
    );
    assert_eq!(sequence.bounds().origin, Point::new(10.0, 5.0));
}
