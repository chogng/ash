//! Session Pane canvas tests.

use super::{SessionCanvasLayout, SessionHeader, SessionHeaderStyle};
use zui::ui::Component;
use zui::ui::Rect;
use zui::ui::UiScene;

#[test]
fn session_canvas_reserves_a_stable_header_above_the_thread_timeline() {
    let output = Rect::from_xywh(200.0, 32.0, 600.0, 500.0);

    let layout = SessionCanvasLayout::for_output(output);

    assert_eq!(layout.header(), Rect::from_xywh(200.0, 32.0, 600.0, 64.0));
    assert_eq!(
        layout.timeline(),
        Rect::from_xywh(200.0, 96.0, 600.0, 436.0)
    );
}

#[test]
fn empty_session_header_shows_ready_environment_context() {
    let header = SessionHeader::new(
        Rect::from_xywh(0.0, 0.0, 700.0, 64.0),
        "",
        "Local  ·  ~/Desktop/ash  ·  main  ·  Changes 2".to_owned(),
        None,
        SessionHeaderStyle::new(
            zui::ui::Color::WHITE,
            zui::ui::Color::rgb(222, 222, 224),
            zui::ui::Color::rgb(246, 246, 247),
            zui::ui::Color::rgb(38, 38, 41),
            zui::ui::Color::rgb(126, 126, 132),
            zui::ui::Color::rgb(16, 124, 16),
            zui::ui::Color::rgb(15, 110, 96),
            zui::ui::Color::rgb(154, 103, 0),
            zui::ui::Color::rgb(180, 38, 38),
        ),
        zui::ui::ElementId::scoped(1, 3),
    );
    let mut scene = UiScene::new(zui::ui::Color::rgb(252, 252, 253));

    header.paint(&mut scene);

    let text = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(text.contains(&"New session"));
    assert!(text.contains(&"Ready"));
    assert!(
        text.iter()
            .any(|line| line.contains("~/Desktop/ash") && line.contains("Changes 2"))
    );
}
