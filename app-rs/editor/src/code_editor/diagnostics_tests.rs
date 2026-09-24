use zui::ui::{Color, Component, Point, Rect, UiScene};

use super::*;
use crate::{CodeEditorDocument, CodeEditorHeader, CodeEditorStyle, CodeEditorViewport};

#[test]
fn document_diagnostics_paint_by_severity_and_support_text_hit_testing() {
    let document = CodeEditorDocument::from_text("let value = missing;\n");
    let diagnostics = vec![
        CodeEditorDiagnostic::new(12..19, CodeEditorDiagnosticSeverity::Error, "not found")
            .with_source("rustc")
            .with_code("E0425"),
    ];
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 80.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    )
    .with_diagnostics(&diagnostics);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(180, 38, 38))
    );
    let diagnostic = editor
        .diagnostic_at(Point::new(56.0 + 13.0 * 8.0, 10.0))
        .expect("diagnostic under source text");
    assert_eq!(diagnostic.message(), "not found");
    assert_eq!(diagnostic.source(), Some("rustc"));
    assert_eq!(diagnostic.code(), Some("E0425"));
}

#[test]
fn multiline_and_empty_diagnostics_project_without_crossing_unrelated_rows() {
    let document = CodeEditorDocument::from_text("alpha\nbeta\ngamma");
    let diagnostics = vec![
        CodeEditorDiagnostic::new(2..9, CodeEditorDiagnosticSeverity::Warning, "across lines"),
        CodeEditorDiagnostic::new(11..11, CodeEditorDiagnosticSeverity::Hint, "insert here"),
    ];
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 240.0, 100.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    )
    .with_diagnostics(&diagnostics);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(154, 103, 0))
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(126, 126, 132))
    );
}

#[test]
fn empty_diagnostic_at_a_wrap_boundary_belongs_to_only_the_following_visual_line() {
    assert!(!empty_diagnostic_is_on_visual_line(4, &(0..4), 8));
    assert!(empty_diagnostic_is_on_visual_line(4, &(4..8), 8));
    assert!(empty_diagnostic_is_on_visual_line(8, &(4..8), 8));
    assert!(empty_diagnostic_is_on_visual_line(0, &(0..0), 0));
}

#[test]
fn invalid_utf8_diagnostic_boundaries_are_ignored() {
    let document = CodeEditorDocument::from_text("界 value");
    let diagnostics = vec![CodeEditorDiagnostic::new(
        1..2,
        CodeEditorDiagnosticSeverity::Information,
        "invalid range",
    )];
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 240.0, 60.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    )
    .with_diagnostics(&diagnostics);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(
        !scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(9, 105, 218))
    );
}
