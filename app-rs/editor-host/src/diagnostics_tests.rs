use ash_editor::{CodeEditorDiagnostic, CodeEditorDiagnosticSeverity};
use zui::ui::{Color, Component, Point, Rect, UiScene};

use super::*;

const TEST_STYLE: EditorOverlayStyle = EditorOverlayStyle::new(
    Color::rgb(246, 246, 247),
    Color::rgb(222, 222, 224),
    Color::rgb(38, 38, 41),
    Color::rgb(126, 126, 132),
    Color::rgb(248, 248, 249),
);
use super::EditorOverlayStyle;

#[test]
fn tooltip_clamps_to_the_editor_and_labels_source_and_code() {
    let diagnostic = CodeEditorDiagnostic::new(
        4..8,
        CodeEditorDiagnosticSeverity::Error,
        "cannot find value",
    )
    .with_source("rustc")
    .with_code("E0425");
    let editor = Rect::from_xywh(10.0, 20.0, 400.0, 200.0);
    let tooltip =
        FileEditorDiagnosticTooltip::new(editor, Point::new(405.0, 215.0), &diagnostic, TEST_STYLE);
    let mut scene = UiScene::new(Color::WHITE);

    tooltip.paint(&mut scene);

    assert!(tooltip.bounds().origin.x >= editor.origin.x);
    assert!(tooltip.bounds().right() <= editor.right());
    assert!(tooltip.bounds().origin.y >= editor.origin.y);
    assert!(tooltip.bounds().bottom() <= editor.bottom());
    assert_eq!(
        scene.text_blocks()[0].text(),
        "rustc(E0425): cannot find value"
    );
}
