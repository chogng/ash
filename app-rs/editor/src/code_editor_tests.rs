use super::text_metrics::{
    display_columns, display_columns_until, expand_tabs, visit_display_cell_runs,
};
use super::{
    CodeEditor, CodeEditorCaretStyle, CodeEditorCommand, CodeEditorDocument, CodeEditorFoldState,
    CodeEditorHeader, CodeEditorInlineHighlight, CodeEditorLanguage, CodeEditorLineWrapping,
    CodeEditorNavigation, CodeEditorPresentation, CodeEditorRow, CodeEditorRowSource,
    CodeEditorSelectionMode, CodeEditorStyle, CodeEditorSyntaxToken, CodeEditorTextEdit,
    CodeEditorTokenRole, CodeEditorViewport,
};
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{
    CaretVisibility, Color, Component, FontFamily, Point, Rect, TextBlockWrap,
    TextInputLayoutEngine, TextStyle, UiScene,
};
use zui::ui::{TextInputCompositionCursor, TextInputCompositionEvent};

#[test]
fn theme_text_style_drives_editor_geometry_from_measured_font_metrics() {
    let text_style = TextStyle::new(17.0, Color::rgb(0, 0, 0))
        .with_family(FontFamily::Monospace)
        .with_line_height(26.0);
    let mut text_layout = TextInputLayoutEngine::new();
    let expected_cell_width = text_layout.measure_text("0", &text_style).width;

    let style =
        CodeEditorStyle::from_theme_and_text_style(DEFAULT_UI_THEME, text_style, &mut text_layout)
            .unwrap();

    assert_eq!(style.row_height(), 26.0);
    assert_eq!(style.cell_width(), expected_cell_width);
    assert_eq!(style.text_style().font_size(), 17.0);
}

#[test]
fn color_only_style_changes_preserve_measured_editor_layout() {
    let mut recolored_theme = DEFAULT_UI_THEME;
    recolored_theme.editor_foreground = Color::rgb(240, 240, 240);
    recolored_theme.content_background = Color::rgb(20, 20, 20);
    let mut text_layout = TextInputLayoutEngine::new();
    let original = CodeEditorStyle::from_theme(DEFAULT_UI_THEME, &mut text_layout).unwrap();
    let recolored = CodeEditorStyle::from_theme(recolored_theme, &mut text_layout).unwrap();

    assert_ne!(original, recolored);
    assert!(original.same_layout_as(&recolored));
}

#[test]
fn font_metric_changes_invalidate_editor_layout() {
    let mut text_layout = TextInputLayoutEngine::new();
    let original = CodeEditorStyle::from_theme(DEFAULT_UI_THEME, &mut text_layout).unwrap();
    let larger_text = TextStyle::new(18.0, DEFAULT_UI_THEME.editor_foreground)
        .with_family(FontFamily::Monospace)
        .with_line_height(28.0);
    let larger =
        CodeEditorStyle::from_theme_and_text_style(DEFAULT_UI_THEME, larger_text, &mut text_layout)
            .unwrap();

    assert!(!original.same_layout_as(&larger));
}

#[test]
fn exact_feature_edit_uses_normal_revision_history_and_unicode_validation() {
    let mut document = CodeEditorDocument::from_text("let 🦀 = value;");
    let revision = document.revision();
    assert!(document.apply_text_edit(CodeEditorTextEdit {
        range: 11..16,
        new_text: "answer".into(),
    }));
    assert_eq!(document.text(), "let 🦀 = answer;");
    assert!(document.revision() > revision);
    assert!(!document.apply_text_edit(CodeEditorTextEdit {
        range: 5..6,
        new_text: "x".into(),
    }));
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "let 🦀 = value;");
}

#[test]
fn document_indexes_lf_crlf_cr_and_replacement_without_rendering_terminators() {
    let mut document = CodeEditorDocument::from_text("one\r\ntwo\nthree\rfour");

    assert_eq!(document.row_count(), 4);
    assert_eq!(document.row(0).unwrap().text, Some("one"));
    assert_eq!(document.row(1).unwrap().text, Some("two"));
    assert_eq!(document.row(2).unwrap().text, Some("three"));
    assert_eq!(document.row(3).unwrap().text, Some("four"));
    assert_eq!(document.text(), "one\r\ntwo\nthree\rfour");

    document.replace_text("replacement\n");
    assert_eq!(document.row_count(), 2);
    assert_eq!(document.row(0).unwrap().text, Some("replacement"));
    assert_eq!(document.row(1).unwrap().text, Some(""));
}

#[test]
fn committed_text_revision_advances_only_for_text_mutations() {
    let mut document = CodeEditorDocument::from_text("one");
    let initial = document.revision();

    document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
    assert_eq!(document.revision(), initial);
    document.apply(CodeEditorCommand::Insert("!".into()));
    let edited = document.revision();
    assert!(edited > initial);
    document.apply(CodeEditorCommand::Undo);
    assert!(document.revision() > edited);
}

#[test]
fn code_editor_paints_only_visible_numbered_rows_and_optional_header() {
    let document = CodeEditorDocument::from_text("one\ntwo\nthree\nfour\n");
    let editor = CodeEditor::new(
        Rect::from_xywh(10.0, 20.0, 320.0, 72.0),
        &document,
        CodeEditorViewport::new(1),
        CodeEditorHeader::Label("src/main.rs"),
        CodeEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert_eq!(editor.visible_row_capacity(), 2);
    assert_eq!(editor.visible_row_range(), 1..3);
    let texts = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(texts.contains(&"src/main.rs"));
    assert!(texts.contains(&"two"));
    assert!(texts.contains(&"three"));
    assert!(!texts.contains(&"one"));
    assert!(!texts.contains(&"four"));
}

#[test]
fn empty_rows_do_not_emit_zero_width_text_blocks() {
    let document = CodeEditorDocument::from_text("one\n\nthree");
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 60.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(scene.text_blocks().iter().all(|block| {
        !block.text().is_empty() && block.bounds().width > 0.0 && block.bounds().height > 0.0
    }));
    assert_eq!(
        scene
            .text_blocks()
            .iter()
            .filter(|block| matches!(block.text(), "one" | "three"))
            .count(),
        2
    );
}

#[test]
fn compact_presentation_accepts_host_owned_horizontal_padding() {
    let document = CodeEditorDocument::from_text("hello");
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 40.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    )
    .with_presentation(CodeEditorPresentation::Compact)
    .with_content_horizontal_padding(0.0)
    .with_caret_visibility(CaretVisibility::Hidden);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let hello = scene
        .text_blocks()
        .iter()
        .find(|block| block.text() == "hello")
        .unwrap();
    assert_eq!(hello.origin().x, 0.0);
    assert!(scene.text_blocks().iter().all(|block| block.text() != "1"));
    assert!(editor.caret_bounds().is_some());
}

#[test]
fn block_caret_occupies_one_monospace_cell() {
    let document = CodeEditorDocument::from_text("");
    let style = CodeEditorStyle::light();
    let cell_width = style.cell_width();
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 20.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        style,
    )
    .with_presentation(CodeEditorPresentation::Compact)
    .with_caret_style(CodeEditorCaretStyle::Block);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let caret = Rect::from_xywh(8.0, 0.0, cell_width, 20.0);
    assert_eq!(editor.caret_bounds(), Some(caret));
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| { rect.bounds() == caret && rect.fill() == Color::rgb(15, 110, 96) })
    );
}

#[test]
fn ghost_text_paints_at_the_caret_without_mutating_the_document() {
    let mut document = CodeEditorDocument::from_text("git ch");
    document.apply(CodeEditorCommand::SelectAll);
    document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
    let style = CodeEditorStyle::light();
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 40.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        style.clone(),
    )
    .with_presentation(CodeEditorPresentation::Compact)
    .with_ghost_text("eckout");
    let caret = editor.caret_bounds().unwrap();
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let ghost = scene
        .text_blocks()
        .iter()
        .find(|block| block.text() == "eckout")
        .expect("ghost continuation should be painted");
    assert_eq!(ghost.origin().x, caret.origin.x);
    assert_eq!(ghost.style().color(), style.muted_text_style().color());
    assert_eq!(document.text(), "git ch");
}

#[test]
fn code_rows_keep_chinese_text_and_spaces_on_one_unwrapped_source_line() {
    let text = "中文 空格";
    let mut document = CodeEditorDocument::from_text(text);
    document.apply(CodeEditorCommand::SelectAll);
    document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
    let style = CodeEditorStyle::light();
    let cell_width = style.cell_width();
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 220.0, 40.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        style,
    )
    .with_presentation(CodeEditorPresentation::Compact);
    let caret = editor.caret_bounds().unwrap();
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let glyphs = scene
        .text_blocks()
        .iter()
        .map(|block| {
            (
                block.text(),
                block.origin().x,
                block.bounds().width,
                block.wrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        glyphs,
        vec![
            ("中", 8.0, cell_width * 2.0, TextBlockWrap::None),
            (
                "文",
                8.0 + cell_width * 2.0,
                cell_width * 2.0,
                TextBlockWrap::None,
            ),
            (
                "空",
                8.0 + cell_width * 5.0,
                cell_width * 2.0,
                TextBlockWrap::None,
            ),
            (
                "格",
                8.0 + cell_width * 7.0,
                cell_width * 2.0,
                TextBlockWrap::None,
            ),
        ]
    );
    assert_eq!(caret.origin.x, 8.0 + cell_width * 9.0);
    assert_eq!(document.text(), text);
}

#[test]
fn every_unicode_scalar_preserves_spaces_in_the_display_cell_projection() {
    for codepoint in 0..=char::MAX as u32 {
        let Some(character) = char::from_u32(codepoint) else {
            continue;
        };
        let text = expand_tabs(&format!("界 {character} 界"));
        let expected_columns = display_columns(&text);
        let mut previous_right = 0;
        let projected_columns = visit_display_cell_runs(&text, |run| {
            assert!(
                run.column >= previous_right,
                "overlapping display-cell runs for U+{codepoint:04X}"
            );
            assert_eq!(
                run.columns,
                display_columns(run.text),
                "run width mismatch for U+{codepoint:04X}"
            );
            assert!(
                run.column + run.columns <= expected_columns,
                "run exceeds the caret column for U+{codepoint:04X}"
            );
            previous_right = run.column + run.columns;
        });
        assert_eq!(
            projected_columns, expected_columns,
            "text and caret columns diverged for U+{codepoint:04X}"
        );
    }
}

#[test]
fn multi_scalar_graphemes_keep_text_spaces_and_caret_in_one_projection() {
    let samples = [
        "e\u{301}",
        "क्",
        "क्ष",
        "กำ",
        "한",
        "👩‍💻",
        "👨‍👩‍👧‍👦",
        "👍🏽",
        "🇨🇳",
        "1️⃣",
        "♥︎",
        "♥️",
        "\u{200d}",
        "\u{2067}עברית\u{2069}",
        "\u{3000}",
    ];
    let style = CodeEditorStyle::light();
    let cell_width = style.cell_width();

    for sample in samples {
        let text = format!("界 {sample} 界");
        let mut document = CodeEditorDocument::from_text(&text);
        document.apply(CodeEditorCommand::SelectAll);
        document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
        let editor = CodeEditor::new(
            Rect::from_xywh(0.0, 0.0, 480.0, 40.0),
            &document,
            CodeEditorViewport::default(),
            CodeEditorHeader::Hidden,
            style.clone(),
        )
        .with_presentation(CodeEditorPresentation::Compact);
        let mut scene = UiScene::new(Color::WHITE);

        editor.paint(&mut scene);

        assert_eq!(document.text(), text, "document changed for {sample:?}");
        assert_eq!(
            editor.caret_bounds().unwrap().origin.x,
            8.0 + display_columns(&text) as f32 * cell_width,
            "caret drifted for {sample:?}"
        );
        assert!(
            scene
                .text_blocks()
                .iter()
                .all(|block| block.wrap() == TextBlockWrap::None),
            "a text run wrapped for {sample:?}"
        );
    }
}

#[test]
fn viewport_clamps_vertical_scroll_and_retains_horizontal_column() {
    let mut viewport = CodeEditorViewport::default();

    viewport.scroll_rows(20, 10, 3);
    viewport.set_horizontal_column(12);

    assert_eq!(viewport.first_visible_row(), 7);
    assert_eq!(viewport.horizontal_column(), 12);
    viewport.scroll_rows(-2, 10, 3);
    assert_eq!(viewport.first_visible_row(), 5);
    viewport.clamp(4, 3);
    assert_eq!(viewport.first_visible_row(), 1);
    viewport.scroll_rows(-1, 2, 2);
    assert_eq!(viewport.first_visible_row(), 0);
}

#[test]
fn viewport_reveals_rows_above_and_below_the_retained_window() {
    let mut viewport = CodeEditorViewport::new(3);

    viewport.reveal_row(8, 12, 4);
    assert_eq!(viewport.first_visible_row(), 5);
    viewport.reveal_row(2, 12, 4);
    assert_eq!(viewport.first_visible_row(), 2);
}

#[test]
fn soft_wrap_projects_visual_rows_caret_and_pointer_without_changing_text() {
    let mut document = CodeEditorDocument::from_text("abcdefghij");
    document.apply(CodeEditorCommand::SelectAll);
    document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
    let style = CodeEditorStyle::light();
    let cell_width = style.cell_width();
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 56.0, 40.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        style,
    )
    .with_presentation(CodeEditorPresentation::Compact)
    .with_line_wrapping(CodeEditorLineWrapping::Soft);

    assert_eq!(editor.visual_row_count(), 2);
    assert_eq!(editor.visible_row_range(), 0..2);
    assert_eq!(editor.content_height(), 40.0);
    assert_eq!(editor.caret_visual_row(), Some(1));
    assert_eq!(
        editor.caret_bounds().unwrap().origin,
        Point::new(8.0 + cell_width * 5.0, 20.0)
    );
    assert_eq!(
        editor.text_position_at(Point::new(25.0, 25.0)),
        Some(super::CodeEditorPosition {
            row_index: 0,
            byte_offset: 7,
        })
    );
    assert_eq!(
        editor
            .location_at(Point::new(25.0, 25.0))
            .unwrap()
            .line_number,
        None
    );
    assert_eq!(document.text(), "abcdefghij");
}

#[test]
fn wrapped_vertical_navigation_moves_between_visual_segments_and_source_rows() {
    let mut document = CodeEditorDocument::from_text("abcdefghij\nxy");
    let navigation = CodeEditorNavigation::SoftWrapped {
        columns: 5,
        page_rows: 2,
    };

    document.apply_in_view(
        CodeEditorCommand::MoveDown(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), 5);
    document.apply_in_view(
        CodeEditorCommand::MoveDown(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), 11);
    document.apply_in_view(
        CodeEditorCommand::MoveUp(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), 5);
}

#[test]
fn location_maps_visible_geometry_back_to_document_rows() {
    let document = CodeEditorDocument::from_text("one\ntwo\nthree\n");
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 300.0, 40.0),
        &document,
        CodeEditorViewport::new(1),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    );

    let location = editor.location_at(Point::new(10.0, 4.0)).unwrap();

    assert_eq!(location.row_index, 1);
    assert_eq!(location.line_number, Some(2));
    assert_eq!(editor.location_at(Point::new(10.0, 45.0)), None);
    assert_eq!(editor.caret_bounds(), None);
}

#[test]
fn unicode_width_and_tabs_share_inline_column_mapping() {
    let text = "a\t界👩‍💻z";
    let emoji_end = text.find('z').unwrap();

    assert_eq!(expand_tabs(text), "a   界👩‍💻z");
    assert_eq!(display_columns_until(text, "a\t".len()), 4);
    assert_eq!(display_columns_until(text, emoji_end), 8);
    assert_eq!(display_columns(text), 9);
}

struct DecoratedRows;

impl CodeEditorRowSource for DecoratedRows {
    fn row_count(&self) -> usize {
        1
    }

    fn largest_line_number(&self) -> usize {
        1
    }

    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>> {
        (index == 0).then(|| {
            CodeEditorRow::new(1, "let value = 1;").with_inline_highlights(vec![
                CodeEditorInlineHighlight::new(4..9, Color::rgb(220, 230, 255)),
                CodeEditorInlineHighlight::new(1..usize::MAX, Color::rgb(255, 0, 0)),
            ])
        })
    }
}

#[test]
fn row_source_decorations_are_shared_and_invalid_utf8_ranges_are_ignored() {
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 300.0, 40.0),
        &DecoratedRows,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(220, 230, 255))
    );
    assert!(
        !scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(255, 0, 0))
    );
}

#[test]
fn multiline_keyboard_editing_preserves_graphemes_and_vertical_columns() {
    let mut document = CodeEditorDocument::from_text("hello\nworld");
    document.apply(CodeEditorCommand::MoveToLineEnd(
        CodeEditorSelectionMode::Move,
    ));
    document.apply(CodeEditorCommand::MoveDown(CodeEditorSelectionMode::Move));
    assert_eq!(document.cursor(), document.text().len());

    document.apply(CodeEditorCommand::Insert(" 👩‍💻".into()));
    document.apply(CodeEditorCommand::Backspace);
    assert_eq!(document.text(), "hello\nworld ");

    document.apply(CodeEditorCommand::MoveUp(CodeEditorSelectionMode::Move));
    assert_eq!(document.cursor(), 5);
    document.apply(CodeEditorCommand::Newline);
    assert_eq!(document.text(), "hello\n\nworld ");
}

#[test]
fn selection_replacement_and_undo_redo_are_atomic() {
    let mut document = CodeEditorDocument::from_text("hello");
    document.apply(CodeEditorCommand::MoveRight(
        CodeEditorSelectionMode::Extend,
    ));
    document.apply(CodeEditorCommand::MoveRight(
        CodeEditorSelectionMode::Extend,
    ));
    assert_eq!(document.selected_text(), Some("he"));

    document.apply(CodeEditorCommand::Insert("HE".into()));
    assert_eq!(document.text(), "HEllo");
    assert!(document.can_undo());
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "hello");
    assert_eq!(document.selected_text(), Some("he"));
    assert!(document.can_redo());
    document.apply(CodeEditorCommand::Redo);
    assert_eq!(document.text(), "HEllo");
}

#[test]
fn ime_preedit_is_uncommitted_until_commit_and_commit_is_undoable() {
    let mut document = CodeEditorDocument::from_text("let value = ");
    document.apply(CodeEditorCommand::MoveToLineEnd(
        CodeEditorSelectionMode::Move,
    ));
    document.apply_composition(TextInputCompositionEvent::Preedit {
        text: "ni".into(),
        cursor: TextInputCompositionCursor::Visible(2..2),
    });

    assert_eq!(document.text(), "let value = ");
    assert_eq!(document.composition().unwrap().text, "ni");

    document.apply_composition(TextInputCompositionEvent::Commit("你".into()));
    assert_eq!(document.text(), "let value = 你");
    assert_eq!(document.composition(), None);
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "let value = ");
}

#[test]
fn syntax_tokens_selection_caret_and_preedit_are_projected_into_the_scene() {
    let mut document =
        CodeEditorDocument::from_text_with_language("let value = 1;", CodeEditorLanguage::Rust);
    document.apply(CodeEditorCommand::MoveRight(
        CodeEditorSelectionMode::Extend,
    ));
    document.apply_composition(TextInputCompositionEvent::Preedit {
        text: "x".into(),
        cursor: TextInputCompositionCursor::Visible(1..1),
    });
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 40.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(editor.caret_bounds().is_some());
    let code_blocks = scene
        .text_blocks()
        .iter()
        .filter(|block| block.text() == "let value = 1;")
        .collect::<Vec<_>>();
    assert_eq!(code_blocks.len(), 1);
    assert!(
        code_blocks[0].spans().iter().any(|span| {
            span.text() == "let" && span.style().color() == Color::rgb(175, 0, 219)
        })
    );
    assert!(
        !scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "let")
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgba(68, 139, 202, 72))
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(15, 110, 96))
    );
    assert!(scene.text_blocks().iter().any(|block| block.text() == "x"));
}

struct NestedSyntaxRows;

impl CodeEditorRowSource for NestedSyntaxRows {
    fn row_count(&self) -> usize {
        1
    }

    fn largest_line_number(&self) -> usize {
        1
    }

    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>> {
        (index == 0).then(|| {
            CodeEditorRow::new(1, "outer\tinner end").with_syntax_tokens(vec![
                CodeEditorSyntaxToken::new(0..15, CodeEditorTokenRole::Function),
                CodeEditorSyntaxToken::new(6..11, CodeEditorTokenRole::Keyword),
            ])
        })
    }
}

#[test]
fn syntax_text_shapes_once_with_nested_tokens_and_shared_tab_columns() {
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 40.0),
        &NestedSyntaxRows,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let code_blocks = scene
        .text_blocks()
        .iter()
        .filter(|block| block.text() == "outer   inner end")
        .collect::<Vec<_>>();
    assert_eq!(code_blocks.len(), 1);
    assert_eq!(
        code_blocks[0]
            .spans()
            .iter()
            .map(|span| (span.text(), span.style().color()))
            .collect::<Vec<_>>(),
        vec![
            ("outer   ", Color::rgb(121, 94, 38)),
            ("inner", Color::rgb(175, 0, 219)),
            (" end", Color::rgb(121, 94, 38)),
        ]
    );
}

#[test]
fn document_folding_owns_visible_rows_controls_and_source_hit_testing() {
    let source = "fn main() {\n    if ready {\n        run();\n    }\n    finish();\n}\nafter();\n";
    let mut document =
        CodeEditorDocument::from_text_with_language(source, CodeEditorLanguage::Rust);
    assert!(
        document
            .folding_ranges()
            .iter()
            .any(|range| { range.start_row() == 0 && range.end_row() == 5 })
    );
    document.set_fold_state(0, CodeEditorFoldState::Collapsed);
    let editor = CodeEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 80.0),
        &document,
        CodeEditorViewport::default(),
        CodeEditorHeader::Hidden,
        CodeEditorStyle::light(),
    );

    assert_eq!(document.row_count(), 3);
    assert_eq!(document.row(0).unwrap().line_number, Some(1));
    assert_eq!(document.row(1).unwrap().line_number, Some(7));
    assert_eq!(document.row(2).unwrap().line_number, Some(8));
    assert_eq!(editor.fold_controls().len(), 1);
    let control = editor.fold_controls()[0];
    assert_eq!(control.state(), CodeEditorFoldState::Collapsed);
    assert_eq!(control.range().start_row(), 0);
    assert_eq!(
        editor.fold_control_at(control.bounds().origin),
        Some(control)
    );

    let position = editor
        .text_position_at(Point::new(100.0, editor.row_height() + 4.0))
        .unwrap();
    assert_eq!(position.row_index, 6);
    assert_eq!(
        document.toggle_fold_control(control),
        Some(CodeEditorFoldState::Expanded)
    );
}

#[test]
fn manual_folds_can_be_created_from_a_selection_and_clear_after_an_edit() {
    let mut document = CodeEditorDocument::from_text("header\nbody\nafter");
    document.set_selection(
        super::CodeEditorPosition {
            row_index: 0,
            byte_offset: 0,
        },
        super::CodeEditorPosition {
            row_index: 2,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::ToggleManualFoldSelection);

    assert_eq!(document.fold_state(0), Some(CodeEditorFoldState::Expanded));
    document.set_fold_state(0, CodeEditorFoldState::Collapsed);
    assert_eq!(document.row_count(), 2);
    assert_eq!(document.row(1).unwrap().line_number, Some(3));
    document.set_selection(
        super::CodeEditorPosition {
            row_index: 0,
            byte_offset: 0,
        },
        super::CodeEditorPosition {
            row_index: 0,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::Insert("!".into()));

    assert_eq!(document.fold_state(0), None);
    assert_eq!(document.row_count(), 3);
}

#[test]
fn explicit_manual_folding_range_rejects_duplicates_and_invalid_rows() {
    let mut document = CodeEditorDocument::from_text("header\nbody\nafter");
    let range = super::CodeEditorFoldingRange::new(0, 1).unwrap();

    assert!(document.add_manual_folding_range(range));
    assert!(!document.add_manual_folding_range(range));
    assert!(!document.add_manual_folding_range(super::CodeEditorFoldingRange::new(1, 3).unwrap()));
    assert!(document.remove_manual_folding_range(range));
    assert!(!document.remove_manual_folding_range(range));
}

#[test]
fn vertical_navigation_skips_collapsed_rows_and_horizontal_navigation_reveals_them() {
    let source = "{\n  \"one\": 1,\n  \"two\": 2\n}\nafter\n";
    let mut document =
        CodeEditorDocument::from_text_with_language(source, CodeEditorLanguage::Json);
    document.set_fold_state(0, CodeEditorFoldState::Collapsed);

    document.apply(CodeEditorCommand::MoveDown(CodeEditorSelectionMode::Move));
    assert_eq!(document.cursor(), source.find("after").unwrap());
    document.apply(CodeEditorCommand::MoveUp(CodeEditorSelectionMode::Move));
    assert_eq!(document.cursor(), 0);
    document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
    document.apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));

    assert_eq!(document.fold_state(0), Some(CodeEditorFoldState::Expanded));
    assert_eq!(document.cursor(), 2);
}

#[test]
fn collapsing_a_range_moves_hidden_selection_endpoints_to_the_header() {
    let source = "{\n  \"one\": 1\n}\n";
    let mut document =
        CodeEditorDocument::from_text_with_language(source, CodeEditorLanguage::Json);
    document.set_selection(
        super::CodeEditorPosition {
            row_index: 1,
            byte_offset: 2,
        },
        super::CodeEditorPosition {
            row_index: 2,
            byte_offset: 0,
        },
    );

    document.set_fold_state(0, CodeEditorFoldState::Collapsed);

    assert_eq!(document.anchor(), 1);
    assert_eq!(document.cursor(), 1);
    assert_eq!(document.selected_text(), None);
}
