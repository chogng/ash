use ash_keybinding::HostPlatform;
use ash_keybinding::parse_key_sequence;
use zui::ui::Color;
use zui::ui::Rect;
use zui::ui::UiScene;

use super::paint_chord_hint;

#[test]
fn chord_hint_reuses_keycaps_and_explains_the_pending_state() {
    let sequence = parse_key_sequence("primary+k primary+c").expect("chord sequence");
    let mut scene = UiScene::new(Color::WHITE);

    paint_chord_hint(
        &mut scene,
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &sequence,
        1,
        HostPlatform::MacOs,
    );

    assert!(scene.text_blocks().iter().any(|text| text.text() == "⌘"));
    assert!(scene.text_blocks().iter().any(|text| text.text() == "K"));
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|text| text.text() == "waiting for next key…")
    );
}
