use super::ChatInputEditor;
use super::ChatInputFocus;
use ash_editor::{CodeEditorCommand, CodeEditorLanguage};
use zui::ui::{CaretVisibility, Color, Component, Rect, UiScene};

#[test]
fn compact_editor_grows_until_eight_visible_rows() {
    let mut editor = ChatInputEditor::default();
    assert_eq!(editor.preferred_height(), 44.0);

    editor.apply(CodeEditorCommand::Insert("one\ntwo\nthree".to_owned()));
    assert_eq!(editor.visible_row_count(), 3);
    assert_eq!(editor.preferred_height(), 84.0);

    editor.set_text(
        (0..12)
            .map(|row| format!("row {row}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    assert_eq!(editor.visible_row_count(), 8);
    assert_eq!(editor.preferred_height(), 184.0);
}

#[test]
fn page_navigation_uses_the_chat_input_visible_row_cap() {
    let mut editor = ChatInputEditor::default();
    editor.set_text(
        (0..10)
            .map(|row| row.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
    );

    editor.apply(CodeEditorCommand::MovePageUp(
        ash_editor::CodeEditorSelectionMode::Move,
    ));
    editor.apply(CodeEditorCommand::Insert("x".to_owned()));

    assert!(editor.text().starts_with("0\n1x\n2"));
}

#[test]
fn empty_editor_paints_placeholder_and_only_exposes_a_focused_visible_caret() {
    let editor = ChatInputEditor::default();
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, editor.preferred_height());
    let mut scene = UiScene::new(Color::WHITE);
    let blurred = editor.view(
        bounds,
        "Ask Ash anything…",
        ChatInputFocus::Blurred,
        Color::rgb(126, 126, 132),
    );

    assert_eq!(blurred.caret_bounds(), None);
    blurred.paint(&mut scene);
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "Ask Ash anything…")
    );

    let focused = editor.view(
        bounds,
        "Ask Ash anything…",
        ChatInputFocus::Focused(CaretVisibility::Visible),
        Color::rgb(126, 126, 132),
    );
    assert_eq!(
        focused.caret_bounds(),
        Some(Rect::from_xywh(
            0.0,
            12.0,
            editor.style.cell_width(),
            editor.style.row_height(),
        ))
    );

    focused.paint(&mut scene);
    let placeholder = scene
        .text_blocks()
        .iter()
        .find(|block| block.text() == "Ask Ash anything…")
        .unwrap();
    assert_eq!(
        placeholder.origin().x,
        focused.caret_bounds().unwrap().origin.x
    );
    assert_eq!(placeholder.origin().y, 12.0);
}

#[test]
fn shell_highlighting_projects_syntax_tokens_into_code_editor() {
    let mut editor = ChatInputEditor::default();
    editor.set_text("just app");
    editor.set_language(CodeEditorLanguage::Shell);
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, editor.preferred_height());
    let mut scene = UiScene::new(Color::WHITE);

    editor
        .view(
            bounds,
            "",
            ChatInputFocus::Blurred,
            Color::rgb(126, 126, 132),
        )
        .paint(&mut scene);

    let code = scene
        .text_blocks()
        .iter()
        .find(|block| block.text() == "just app")
        .expect("code line should be painted once");
    assert!(
        code.spans().iter().any(|span| {
            span.text() == "just" && span.style().color() == Color::rgb(121, 94, 38)
        })
    );
}

#[test]
fn focused_chat_input_shows_ghost_text_without_committing_it() {
    let mut editor = ChatInputEditor::default();
    editor.set_text("git ch");
    editor.show_ghost_text("eckout".to_owned());
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, editor.preferred_height());
    let mut scene = UiScene::new(Color::WHITE);

    editor
        .view(
            bounds,
            "",
            ChatInputFocus::Focused(CaretVisibility::Visible),
            Color::rgb(126, 126, 132),
        )
        .paint(&mut scene);

    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "eckout")
    );
    assert_eq!(editor.text(), "git ch");

    let mut blurred_scene = UiScene::new(Color::WHITE);
    editor
        .view(
            bounds,
            "",
            ChatInputFocus::Blurred,
            Color::rgb(126, 126, 132),
        )
        .paint(&mut blurred_scene);
    assert!(
        blurred_scene
            .text_blocks()
            .iter()
            .all(|block| block.text() != "eckout")
    );
}
