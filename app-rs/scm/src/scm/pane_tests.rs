use std::time::Instant;

use super::{EditorPane, EditorPaneState};
use crate::CHANGES_PANE;
use crate::ChangesActivation;
use crate::MULTI_DIFF_EDITOR;
use crate::MULTI_DIFF_SCROLLBAR;
use crate::TEST_SCM_PANE_STYLE;
use ash_diff::DiffDocument;
use ash_editor::CodeEditorStyle;
use ash_editor::MultiDiffEditorStyle;
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{AccessibilityRole, InteractionFrame, UiDispatch, UiFrame};
use zui::ui::{Color, Component, FontFamily, Rect, TextInputLayoutEngine, TextStyle, UiScene};

const TEST_PARENT: zui::ui::ElementId = zui::ui::ElementId::scoped(99, 1);

fn document(original: &str, modified: &str) -> DiffDocument {
    DiffDocument::from_text(original, modified).unwrap()
}

#[test]
fn changed_files_retain_independent_diff_viewports_in_one_multi_diff_state() {
    let mut state = EditorPaneState::default();
    state.open_diff(
        "alpha.rs",
        "alpha.rs (base)",
        "alpha.rs (working)",
        document("old alpha\n", "new alpha\n"),
    );
    let second_text = (0..24)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    state.open_diff(
        "beta.rs",
        "beta.rs (base)",
        "beta.rs (working)",
        document("", &second_text),
    );

    state
        .diff_mut(1)
        .unwrap()
        .editor_state_mut()
        .scroll_rows(8, 24, 6);
    assert!(state.scroll(120.0, zui::ui::Size::new(320.0, 300.0), Instant::now(),));

    assert_eq!(state.diffs.len(), 2);
    assert_eq!(state.diffs[0].editor_state.first_visible_row(), 0);
    assert_eq!(state.diffs[1].editor_state.first_visible_row(), 8);
    assert_eq!(state.scroll_state.vertical_offset(), 120.0);
}

#[test]
fn style_changes_remeasure_only_when_editor_geometry_changes() {
    let mut state = EditorPaneState::default();
    state.open_diff(
        "alpha.rs",
        "alpha.rs (base)",
        "alpha.rs (working)",
        document("old alpha\n", "new alpha\n"),
    );
    let retained_extent = 777.0;
    state
        .measured_layout
        .update_section_extent(0, retained_extent);
    let mut recolored_theme = DEFAULT_UI_THEME;
    recolored_theme.content_background = Color::rgb(20, 20, 20);
    recolored_theme.diff_inserted_line = Color::rgb(10, 80, 30);
    let mut text_layout = TextInputLayoutEngine::new();
    let recolored_editor = CodeEditorStyle::from_theme(recolored_theme, &mut text_layout).unwrap();

    state.set_style(MultiDiffEditorStyle::from_theme(
        recolored_theme,
        recolored_editor,
    ));

    assert_eq!(
        state.measured_layout.section_extent(0),
        Some(retained_extent)
    );

    let larger_text = TextStyle::new(18.0, DEFAULT_UI_THEME.editor_foreground)
        .with_family(FontFamily::Monospace)
        .with_line_height(28.0);
    let larger_editor =
        CodeEditorStyle::from_theme_and_text_style(DEFAULT_UI_THEME, larger_text, &mut text_layout)
            .unwrap();

    state.set_style(MultiDiffEditorStyle::from_theme(
        DEFAULT_UI_THEME,
        larger_editor,
    ));

    assert_ne!(
        state.measured_layout.section_extent(0),
        Some(retained_extent)
    );
}

#[test]
fn changed_file_identity_and_viewport_state_survive_snapshot_reordering() {
    let mut state = EditorPaneState::default();
    state.replace_test_diffs(vec![
        (
            "alpha.rs".to_string(),
            document("old alpha\n", "new alpha\n"),
        ),
        ("beta.rs".to_string(), document("old beta\n", "new beta\n")),
    ]);
    let alpha_identity = state.diffs[0].identity;
    let beta_identity = state.diffs[1].identity;
    state
        .diff_mut(1)
        .unwrap()
        .editor_state_mut()
        .scroll_rows(8, 24, 6);

    state.replace_test_diffs(vec![
        (
            "beta.rs".to_string(),
            document("old beta refreshed\n", "new beta refreshed\n"),
        ),
        (
            "alpha.rs".to_string(),
            document("old alpha refreshed\n", "new alpha refreshed\n"),
        ),
    ]);

    assert_eq!(state.diffs[0].identity, beta_identity);
    assert_eq!(state.diffs[1].identity, alpha_identity);
    assert_eq!(state.diffs[0].editor_state.first_visible_row(), 8);
    assert_eq!(state.diffs[1].editor_state.first_visible_row(), 0);
}

#[test]
fn snapshot_splice_preserves_the_visible_file_anchor_when_items_are_inserted_above_it() {
    let mut state = EditorPaneState::default();
    let large_document = || {
        document(
            &(0..20)
                .map(|line| format!("old {line}"))
                .collect::<Vec<_>>()
                .join("\n"),
            &(0..20)
                .map(|line| format!("new {line}"))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    state.replace_test_diffs(vec![
        ("alpha.rs".to_string(), large_document()),
        ("beta.rs".to_string(), large_document()),
        ("gamma.rs".to_string(), large_document()),
    ]);
    let first_extent = state.measured_layout.section_extent(0).unwrap();
    state.scroll(
        first_extent + 19.0,
        zui::ui::Size::new(320.0, 80.0),
        Instant::now(),
    );
    let beta_identity = state.diffs[1].identity;
    let anchor_before = state
        .measured_layout
        .scroll_anchor(state.scroll_state.vertical_offset())
        .unwrap();

    state.replace_test_diffs(vec![
        ("inserted.rs".to_string(), large_document()),
        ("alpha.rs".to_string(), large_document()),
        ("beta.rs".to_string(), large_document()),
        ("gamma.rs".to_string(), large_document()),
    ]);

    let anchor_after = state
        .measured_layout
        .scroll_anchor(state.scroll_state.vertical_offset())
        .unwrap();
    assert_eq!(
        state.diffs[anchor_after.item_index()].identity,
        beta_identity
    );
    assert_eq!(anchor_after.item_index(), 2);
    assert_eq!(
        anchor_after.distance_from_item_start(),
        anchor_before.distance_from_item_start()
    );
}

#[test]
fn removed_changed_files_report_their_identity_for_animation_cleanup() {
    let mut state = EditorPaneState::default();
    state.replace_test_diffs(vec![
        (
            "alpha.rs".to_string(),
            document("old alpha\n", "new alpha\n"),
        ),
        ("beta.rs".to_string(), document("old beta\n", "new beta\n")),
    ]);
    let beta_identity = state.diffs[1].identity;

    let removed = state.replace_test_diffs(vec![(
        "alpha.rs".to_string(),
        document("old alpha refreshed\n", "new alpha refreshed\n"),
    )]);

    assert_eq!(removed, vec![beta_identity]);
    assert_eq!(state.diffs.len(), 1);
    assert_eq!(state.diffs[0].identity.slot(), 1);
}

#[test]
fn scrollbar_thumb_drag_and_track_click_update_the_shared_scroll_state() {
    let mut state = EditorPaneState::default();
    let changed = (0..80)
        .map(|line| format!("changed {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    state.open_diff(
        "long.rs",
        "long.rs (base)",
        "long.rs (working)",
        document("", &changed),
    );
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, 240.0);
    let scrollbar = state
        .scroll_view(bounds)
        .vertical_scrollbar()
        .expect("long diff should overflow");
    let thumb = scrollbar.thumb_bounds();
    let now = Instant::now();
    let press = state.press_scrollbar(
        zui::ui::Point::new(thumb.origin.x + 2.0, thumb.origin.y + 2.0),
        bounds,
        now,
    );
    assert!(press.handled);

    let drag = state.scrollbar_pointer_moved(
        zui::ui::Point::new(
            thumb.origin.x + 2.0,
            scrollbar.track_bounds().bottom() - 2.0,
        ),
        bounds,
        now,
    );
    assert!(drag.handled);
    assert!(state.scroll_state.vertical_offset() > 0.0);
    assert!(
        state
            .release_scrollbar(zui::ui::Point::new(-1.0, -1.0), bounds, now)
            .handled
    );

    let previous = state.scroll_state.vertical_offset();
    let track_point = zui::ui::Point::new(
        scrollbar.track_bounds().origin.x + 2.0,
        scrollbar.track_bounds().origin.y + 1.0,
    );
    assert!(state.press_scrollbar(track_point, bounds, now).handled);
    assert!(state.scroll_state.vertical_offset() < previous);
}

#[test]
fn overflowing_editor_registers_an_accessible_scrollbar_region() {
    let mut state = EditorPaneState::default();
    let changed = (0..80)
        .map(|line| format!("changed {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    state.open_diff("long.rs", "base", "working", document("", &changed));
    let pane = EditorPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 240.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);

    let nodes = frame
        .interaction()
        .accessibility_nodes(&UiDispatch::default());
    let scrollbar = nodes
        .iter()
        .find(|node| node.id == MULTI_DIFF_SCROLLBAR)
        .unwrap();
    assert_eq!(scrollbar.parent, Some(MULTI_DIFF_EDITOR));
    assert_eq!(scrollbar.role, AccessibilityRole::ScrollBar);
}

#[test]
fn editor_pane_paints_all_visible_file_diffs_as_unified_sections_without_tab_selection() {
    let mut state = EditorPaneState::default();
    state.open_diff(
        "alpha.rs",
        "alpha base",
        "alpha working",
        document("old alpha\n", "new alpha\n"),
    );
    state.open_diff(
        "beta.rs",
        "beta base",
        "beta working",
        document("old beta\n", "new beta\n"),
    );
    let pane = EditorPane::new(
        Rect::from_xywh(680.0, 212.0, 320.0, 488.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);
    let scene = frame.scene();

    let visible_text = scene
        .text_blocks()
        .iter()
        .map(|text| text.text())
        .collect::<Vec<_>>();
    assert!(visible_text.contains(&"alpha.rs"));
    assert!(visible_text.contains(&"beta.rs"));
    assert!(visible_text.contains(&"old alpha"));
    assert!(visible_text.contains(&"new alpha"));
    assert!(visible_text.contains(&"old beta"));
    assert!(visible_text.contains(&"new beta"));
    assert!(!visible_text.contains(&"alpha base"));
    assert!(!visible_text.contains(&"alpha working"));

    let dispatch = UiDispatch::default();
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    let multi_diff = nodes
        .iter()
        .find(|node| node.id == MULTI_DIFF_EDITOR)
        .unwrap();
    assert_eq!(multi_diff.parent, Some(CHANGES_PANE));
    assert_eq!(multi_diff.role, AccessibilityRole::Group);
    assert_eq!(multi_diff.label, "Multiple file differences");
    assert!(
        nodes
            .iter()
            .all(|node| node.role != AccessibilityRole::RadioGroup)
    );
}

#[test]
fn editor_pane_exposes_nested_component_inspection_nodes() {
    let original = (1..=80)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = format!(
        "{}\n{}",
        original.replace("line 41", "changed 41"),
        (81..=120)
            .map(|line| format!("added {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let mut state = EditorPaneState::default();
    state.open_diff(
        "alpha.rs",
        "alpha base",
        "alpha working",
        document(&original, &modified),
    );
    let pane = EditorPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 300.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);

    let inspection = frame.scene().inspection();
    let names = inspection
        .nodes()
        .iter()
        .map(|node| node.name())
        .collect::<Vec<_>>();
    for name in [
        "EditorPane",
        "MultiDiffEditor",
        "ScrollView",
        "MultiDiffSection",
        "MultiDiffFileHeader",
        "DiffEditor",
        "CodeEditor",
        "MultiDiffFoldControl",
        "MultiDiffScrollbar",
    ] {
        assert!(
            names.contains(&name),
            "missing inspection node {name}; found {names:?}"
        );
    }

    let code_editor = inspection
        .nodes()
        .iter()
        .find(|node| node.name() == "CodeEditor")
        .expect("code editor inspection node");
    let ancestry = inspection
        .ancestry(code_editor.id())
        .into_iter()
        .map(|node| node.name())
        .collect::<Vec<_>>();
    assert_eq!(
        ancestry,
        vec![
            "EditorPane",
            "MultiDiffEditor",
            "ScrollView",
            "MultiDiffSection",
            "DiffEditor",
            "CodeEditor",
        ]
    );
}

#[test]
fn empty_editor_pane_exposes_an_honest_empty_state() {
    let state = EditorPaneState::default();
    let pane = EditorPane::new(
        Rect::from_xywh(0.0, 100.0, 320.0, 300.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    let mut scene = UiScene::new(Color::WHITE);

    pane.paint(&mut scene);

    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|text| text.text() == "No changes in this scope")
    );
}

#[test]
fn unchanged_region_controls_are_accessible_and_toggle_retained_diff_state() {
    let original = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = original.replace("line 11", "changed 11");
    let mut state = EditorPaneState::default();
    state.open_diff(
        "alpha.rs",
        "alpha base",
        "alpha working",
        document(&original, &modified),
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    let pane = EditorPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 300.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    frame.draw_component(&pane);
    let nodes = frame
        .interaction()
        .accessibility_nodes(&UiDispatch::default());
    let fold = nodes
        .iter()
        .find(|node| node.label == "Show 7 unchanged lines in alpha.rs")
        .unwrap();
    let section = nodes
        .iter()
        .find(|node| node.label == "Changed file alpha.rs")
        .unwrap();

    assert_eq!(fold.parent, Some(section.id));
    assert_eq!(fold.role, AccessibilityRole::Button);
    assert!(state.toggle_fold_for_element(fold.id));
    assert!(state.diffs[0].editor_state.is_unchanged_region_expanded(0));

    let mut expanded_frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    let expanded_pane = EditorPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 480.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    expanded_frame.draw_component(&expanded_pane);
    assert!(
        expanded_frame
            .interaction()
            .accessibility_nodes(&UiDispatch::default())
            .iter()
            .any(|node| node.label == "Hide 7 unchanged lines in alpha.rs")
    );
}

#[test]
fn file_header_toggles_the_whole_diff_and_exposes_scm_actions() {
    let mut state = EditorPaneState::default();
    state.open_diff(
        "alpha.rs",
        "alpha base",
        "alpha working",
        document("old alpha\n", "new alpha\n"),
    );
    let identity = state.diffs[0].identity;
    let dispatch = UiDispatch::default();
    let pane = EditorPane::new(
        Rect::from_xywh(0.0, 0.0, 420.0, 300.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);

    assert!(
        nodes
            .iter()
            .any(|node| node.id == identity.header_id() && node.label == "Collapse alpha.rs")
    );
    for label in ["Open editor", "Discard changes", "Stage changes"] {
        assert!(nodes.iter().any(|node| node.label == label));
    }
    assert_eq!(
        state.activate(identity.header_action_id(0).unwrap()),
        Some(ChangesActivation::OpenFile("alpha.rs".into()))
    );
    assert_eq!(
        state.activate(identity.header_id()),
        Some(ChangesActivation::Changed)
    );

    let collapsed = EditorPane::new(
        Rect::from_xywh(0.0, 0.0, 420.0, 300.0),
        &state,
        TEST_SCM_PANE_STYLE,
        TEST_PARENT,
    );
    let mut collapsed_frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    collapsed_frame.draw_component(&collapsed);
    assert!(
        collapsed_frame
            .interaction()
            .accessibility_nodes(&dispatch)
            .iter()
            .any(|node| node.id == identity.header_id() && node.label == "Expand alpha.rs")
    );
    assert!(
        collapsed_frame
            .scene()
            .text_blocks()
            .iter()
            .all(|text| !matches!(text.text(), "old alpha" | "new alpha"))
    );
}

#[test]
fn collapsing_one_file_updates_only_its_measurement_and_preserves_the_visible_anchor() {
    let mut state = EditorPaneState::default();
    state.replace_test_diffs(
        ["alpha.rs", "beta.rs", "gamma.rs"]
            .into_iter()
            .map(|name| {
                (
                    name.to_string(),
                    document("old 1\nold 2\nold 3\n", "new 1\nnew 2\nnew 3\n"),
                )
            })
            .collect(),
    );
    let before = (0..3)
        .map(|index| state.measured_layout.section_extent(index).unwrap())
        .collect::<Vec<_>>();
    state.scroll(
        before[0] + 12.0,
        zui::ui::Size::new(320.0, 80.0),
        Instant::now(),
    );
    let anchor_before = state
        .measured_layout
        .scroll_anchor(state.scroll_state.vertical_offset())
        .unwrap();
    let first_identity = state.diffs[0].identity;

    assert_eq!(
        state.activate(first_identity.header_id()),
        Some(ChangesActivation::Changed)
    );

    let anchor_after = state
        .measured_layout
        .scroll_anchor(state.scroll_state.vertical_offset())
        .unwrap();
    assert_eq!(anchor_after.item_index(), anchor_before.item_index());
    assert_eq!(
        anchor_after.distance_from_item_start(),
        anchor_before.distance_from_item_start()
    );
    assert!(state.measured_layout.section_extent(0).unwrap() < before[0]);
    assert_eq!(state.measured_layout.section_extent(1), Some(before[1]));
    assert_eq!(state.measured_layout.section_extent(2), Some(before[2]));
}
