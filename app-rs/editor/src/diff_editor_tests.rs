use super::{
    DiffEditor, DiffEditorDocument, DiffEditorLabels, DiffEditorPresentation, DiffEditorSide,
    DiffEditorState, DiffEditorStyle,
};
use crate::CodeEditorLanguage;
use ash_diff::DiffDocument;
use zui::ui::{Color, Component, Point, Rect, UiScene};

fn document() -> DiffEditorDocument {
    editor_document(
        "same\nlet value = 1;\nremoved\n",
        "same\nlet value = 20;\nadded\nextra\n",
    )
}

fn editor_document(original: &str, modified: &str) -> DiffEditorDocument {
    DiffEditorDocument::new(
        DiffDocument::from_text(original, modified).unwrap(),
        CodeEditorLanguage::PlainText,
    )
}

fn editor<'a>(
    document: &'a DiffEditorDocument,
    bounds: Rect,
    state: DiffEditorState,
) -> DiffEditor<'a> {
    DiffEditor::new(
        bounds,
        document,
        state,
        DiffEditorLabels::new("Original · src/main.rs", "Modified · src/main.rs"),
        DiffEditorStyle::light(),
    )
}

#[test]
fn state_clamps_synchronized_vertical_scroll_and_keeps_horizontal_sides_independent() {
    let mut state = DiffEditorState::default();

    state.scroll_rows(6, 10, 3);
    state.set_horizontal_column(DiffEditorSide::Original, 4);
    state.set_horizontal_column(DiffEditorSide::Modified, 11);

    assert_eq!(state.first_visible_row(), 6);
    assert_eq!(state.horizontal_column(DiffEditorSide::Original), 4);
    assert_eq!(state.horizontal_column(DiffEditorSide::Modified), 11);

    state.scroll_rows(20, 10, 3);
    assert_eq!(state.first_visible_row(), 7);
    state.scroll_rows(-2, 10, 3);
    assert_eq!(state.first_visible_row(), 5);
    state.clamp(4, 3);
    assert_eq!(state.first_visible_row(), 1);
}

#[test]
fn side_by_side_paint_includes_headers_mapped_lines_markers_and_inline_highlights() {
    let document = document();
    let editor = editor(
        &document,
        Rect::from_xywh(10.0, 20.0, 640.0, 240.0),
        DiffEditorState::default(),
    );
    let style = DiffEditorStyle::light();
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let texts = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(texts.contains(&"Original · src/main.rs"));
    assert!(texts.contains(&"Modified · src/main.rs"));
    assert!(texts.contains(&"same"));
    assert!(texts.contains(&"let value = 1;"));
    assert!(texts.contains(&"let value = 20;"));
    assert!(texts.contains(&"−"));
    assert!(texts.contains(&"+"));
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == style.removed_line)
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == style.added_line)
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == style.removed_inline)
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == style.added_inline)
    );
}

#[test]
fn diff_document_projects_editor_owned_syntax_into_both_code_panes() {
    let document = DiffEditorDocument::new(
        DiffDocument::from_text("fn before() {}\n", "fn after() {}\n").unwrap(),
        CodeEditorLanguage::Rust,
    );
    let editor = editor(
        &document,
        Rect::from_xywh(0.0, 0.0, 640.0, 80.0),
        DiffEditorState::default(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let code_blocks = scene
        .text_blocks()
        .iter()
        .filter(|block| matches!(block.text(), "fn before() {}" | "fn after() {}"))
        .collect::<Vec<_>>();
    assert_eq!(code_blocks.len(), 2);
    assert!(code_blocks.iter().all(|block| {
        block
            .spans()
            .iter()
            .any(|span| span.text() == "fn" && span.style().color() == Color::rgb(175, 0, 219))
    }));
}

#[test]
fn unified_presentation_stacks_changed_rows_once_without_side_headers() {
    let document = editor_document("same\nbefore\n", "same\nafter\n");
    let editor = editor(
        &document,
        Rect::from_xywh(0.0, 0.0, 320.0, 80.0),
        DiffEditorState::default(),
    )
    .with_presentation(DiffEditorPresentation::Unified);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let texts = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert_eq!(editor.content_height(), 60.0);
    assert_eq!(texts.iter().filter(|text| **text == "same").count(), 1);
    assert!(texts.contains(&"before"));
    assert!(texts.contains(&"after"));
    assert!(texts.contains(&"−"));
    assert!(texts.contains(&"+"));
    assert!(!texts.contains(&"Original · src/main.rs"));
    assert!(!texts.contains(&"Modified · src/main.rs"));

    let removed = editor.location_at(Point::new(80.0, 22.0)).unwrap();
    let added = editor.location_at(Point::new(80.0, 42.0)).unwrap();
    assert_eq!(removed.side, DiffEditorSide::Original);
    assert_eq!(added.side, DiffEditorSide::Modified);
}

#[test]
fn location_maps_both_panes_to_the_same_visible_diff_row() {
    let document = document();
    let editor = editor(
        &document,
        Rect::from_xywh(0.0, 0.0, 601.0, 92.0),
        DiffEditorState::default(),
    );
    let layout = editor.layout();
    let y = layout.original.origin.y + 32.0 + 20.0 + 2.0;

    let original = editor
        .location_at(Point::new(layout.original.origin.x + 2.0, y))
        .unwrap();
    let modified = editor
        .location_at(Point::new(layout.modified.origin.x + 2.0, y))
        .unwrap();

    assert_eq!(original.side, DiffEditorSide::Original);
    assert_eq!(modified.side, DiffEditorSide::Modified);
    assert_eq!(original.row_index, modified.row_index);
    assert_eq!(original.line_number, Some(2));
    assert_eq!(modified.line_number, Some(2));
    assert_eq!(editor.location_at(Point::new(10.0, 10.0)), None);
}

#[test]
fn visible_range_never_paints_more_rows_than_the_body_capacity() {
    let document = document();
    let mut state = DiffEditorState::default();
    state.scroll_rows(isize::MAX, document.diff().rows().len(), 2);
    let editor = editor(&document, Rect::from_xywh(0.0, 0.0, 400.0, 72.0), state);

    assert_eq!(editor.visible_row_capacity(), 2);
    assert_eq!(editor.visible_row_range().len(), 2);
    assert_eq!(editor.visible_row_range().end, document.diff().rows().len());
}

#[test]
fn absent_counterpart_uses_missing_line_background_without_fake_line_number() {
    let document = editor_document("", "new line\n");
    let editor = editor(
        &document,
        Rect::from_xywh(0.0, 0.0, 400.0, 80.0),
        DiffEditorState::default(),
    );
    let style = DiffEditorStyle::light();
    let layout = editor.layout();
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == style.missing_line)
    );
    assert_eq!(
        editor
            .location_at(Point::new(
                layout.original.origin.x + 2.0,
                layout.original.origin.y + 32.0 + 2.0
            ))
            .unwrap()
            .line_number,
        None
    );
}

#[test]
fn unified_presentation_collapses_and_reveals_long_unchanged_regions() {
    let original = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = (1..=20)
        .map(|line| {
            if line == 11 {
                "changed 11".to_string()
            } else {
                format!("line {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let document = editor_document(&original, &modified);
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, 400.0);
    let collapsed = editor(&document, bounds, DiffEditorState::default())
        .with_presentation(DiffEditorPresentation::Unified);
    let mut collapsed_scene = UiScene::new(Color::WHITE);

    collapsed.paint(&mut collapsed_scene);

    let collapsed_text = collapsed_scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert_eq!(collapsed.content_height(), 200.0);
    assert!(collapsed_text.contains(&"Show 7 unchanged lines"));
    assert!(collapsed_text.contains(&"Show 6 unchanged lines"));
    assert!(!collapsed_text.contains(&"line 1"));
    assert!(collapsed_text.contains(&"line 10"));
    assert!(collapsed_text.contains(&"changed 11"));
    assert_eq!(collapsed.fold_controls().len(), 2);
    assert_eq!(collapsed.fold_controls()[0].region_index(), 0);
    assert_eq!(collapsed.fold_controls()[0].line_count(), 7);
    assert_eq!(
        collapsed.fold_controls()[0].state(),
        super::DiffEditorFoldState::Collapsed
    );
    assert_eq!(
        collapsed.fold_controls()[0].bounds(),
        Rect::from_xywh(0.0, 0.0, 320.0, 20.0)
    );
    assert_eq!(collapsed.location_at(Point::new(100.0, 10.0)), None);

    let mut state = DiffEditorState::default();
    state.expand_unchanged_region(0);
    let expanded =
        editor(&document, bounds, state).with_presentation(DiffEditorPresentation::Unified);
    let mut expanded_scene = UiScene::new(Color::WHITE);

    expanded.paint(&mut expanded_scene);

    let expanded_text = expanded_scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert_eq!(expanded.content_height(), 340.0);
    assert!(expanded_text.contains(&"Hide 7 unchanged lines"));
    assert!(expanded_text.contains(&"line 1"));
    assert_eq!(
        expanded.fold_controls()[0].state(),
        super::DiffEditorFoldState::Expanded
    );
}

#[test]
fn unchanged_region_state_can_toggle_and_collapse_again() {
    let mut state = DiffEditorState::default();

    state.toggle_unchanged_region(2);
    assert!(state.is_unchanged_region_expanded(2));
    state.collapse_unchanged_region(2);
    assert!(!state.is_unchanged_region_expanded(2));
}

#[test]
fn expanded_large_unified_diff_maps_a_distant_visual_row_without_materializing_every_row() {
    let original = (1..=2_000)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = original.replace("line 1001", "changed 1001");
    let document = editor_document(&original, &modified);
    let mut state = DiffEditorState::default();
    state.expand_unchanged_region(0);
    state.expand_unchanged_region(1);
    state.scroll_rows(1_800, 2_003, 4);
    let editor = editor(&document, Rect::from_xywh(0.0, 0.0, 320.0, 80.0), state)
        .with_presentation(DiffEditorPresentation::Unified);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert_eq!(editor.content_height(), 2_003.0 * 20.0);
    assert_eq!(
        editor
            .location_at(Point::new(100.0, 2.0))
            .unwrap()
            .line_number,
        Some(1_798)
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "line 1798")
    );
    assert!(scene.text_blocks().len() < 12);
}
