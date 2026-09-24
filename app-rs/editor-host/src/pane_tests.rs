use ash_editor::{
    CodeEditorCommand, CodeEditorDiagnostic, CodeEditorDiagnosticSeverity, CodeEditorStyle,
};
use ash_text_file::{TextFileAccess, TextFileDiskVersion, TextFileModifiedAt, TextFileSnapshot};
use zui::ui::{
    CaretVisibility, Color, Component, Rect, TextInputCommand, TextInputLayoutEngine, UiScene,
};

use super::*;
use crate::interaction::{
    FILE_EDITOR_DOCUMENT, FILE_EDITOR_FIND_INPUT, FILE_EDITOR_NOTICE, FILE_EDITOR_PANE,
    FILE_EDITOR_REPLACE_INPUT, FILE_EDITOR_TABS, FileEditorAction, file_editor_close_id,
    file_editor_tab_id,
};
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{AccessibilityRole, InteractionFrame, UiDispatch, UiFrame, UiNode};

const WINDOW: zui::ui::ElementId = zui::ui::ElementId::scoped(90, 1);
const MAIN_SURFACE: zui::ui::ElementId = zui::ui::ElementId::scoped(90, 2);

fn open(host: &mut FileEditorHost, path: &str, content: &str) {
    host.open(TextFileSnapshot::new(
        path.into(),
        content.into(),
        TextFileDiskVersion::new(
            content.len() as u64,
            TextFileModifiedAt::KnownMillis(1),
            TextFileAccess::Writable,
        ),
    ));
}

#[test]
fn pane_paints_tabs_dirty_state_and_only_the_active_document() {
    let mut host = FileEditorHost::default();
    open(&mut host, "src/main.rs", "fn main() {}\n");
    open(&mut host, "README.md", "read me\n");
    host.apply(CodeEditorCommand::Insert("dirty ".into()));
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    );
    let mut scene = UiScene::new(Color::WHITE);

    pane.paint(&mut scene);

    let texts = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(texts.contains(&"main.rs"));
    assert!(texts.contains(&"README.md •"));
    assert!(texts.contains(&"dirty read me"));
    assert!(!texts.contains(&"fn main() {}"));
    assert_eq!(
        scene
            .text_blocks()
            .iter()
            .find(|block| block.text() == "main.rs")
            .unwrap()
            .style()
            .color(),
        DEFAULT_UI_THEME.muted_foreground
    );
    assert_eq!(
        scene
            .text_blocks()
            .iter()
            .find(|block| block.text() == "README.md •")
            .unwrap()
            .style()
            .color(),
        DEFAULT_UI_THEME.foreground
    );
    assert!(
        scene
            .inspection()
            .nodes()
            .iter()
            .any(|node| node.name() == "RadioGroup")
    );
    assert!(pane.caret_bounds().is_some());
}

#[test]
fn empty_host_paints_only_the_file_surface() {
    let host = FileEditorHost::default();
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 200.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Hidden,
    );
    let mut scene = UiScene::new(Color::WHITE);

    pane.paint(&mut scene);

    assert!(scene.text_blocks().is_empty());
    assert_eq!(pane.caret_bounds(), None);
}

#[test]
fn pane_paints_editor_diagnostics_and_hover_details() {
    let mut host = FileEditorHost::default();
    open(&mut host, "src/main.rs", "fn main() {}\n");
    let diagnostics = vec![
        CodeEditorDiagnostic::new(3..7, CodeEditorDiagnosticSeverity::Error, "missing item")
            .with_source("rustc"),
    ];
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    )
    .with_diagnostics(&diagnostics)
    .with_pointer_position(Some(zui::ui::Point::new(80.0, 42.0)));
    let mut scene = UiScene::new(Color::WHITE);

    pane.paint(&mut scene);

    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == DEFAULT_UI_THEME.error)
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "rustc: missing item")
    );
}

#[test]
fn pane_registers_tabs_and_the_active_document_as_desktop_interactions() {
    let mut host = FileEditorHost::default();
    open(&mut host, "src/main.rs", "fn main() {}\n");
    open(&mut host, "README.md", "read me\n");
    let bounds = Rect::from_xywh(0.0, 0.0, 480.0, 240.0);
    let pane = FileEditorPane::new(
        bounds,
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.interaction_mut().register(UiNode::new(
        WINDOW,
        bounds,
        AccessibilityRole::Window,
        "Window",
    ));
    frame.interaction_mut().register(
        UiNode::new(MAIN_SURFACE, bounds, AccessibilityRole::Group, "Workspace")
            .with_parent(WINDOW),
    );

    frame.draw_component(&pane);
    let scene = frame.scene();
    let nodes = frame
        .interaction()
        .accessibility_nodes(&UiDispatch::default());

    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == FILE_EDITOR_PANE)
            .unwrap()
            .role,
        AccessibilityRole::Group
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == FILE_EDITOR_TABS)
            .unwrap()
            .role,
        AccessibilityRole::RadioGroup
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == file_editor_tab_id(1))
            .unwrap()
            .role,
        AccessibilityRole::RadioButton
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == file_editor_close_id(1))
            .unwrap()
            .role,
        AccessibilityRole::Button
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == FILE_EDITOR_DOCUMENT)
            .unwrap()
            .role,
        AccessibilityRole::TextInput
    );
    let editor_target = scene
        .inspection()
        .target_at(zui::ui::Point::new(100.0, 42.0))
        .expect("active editor should be inspectable");
    let ancestry = scene
        .inspection()
        .ancestry(editor_target.id())
        .iter()
        .map(|node| node.name())
        .collect::<Vec<_>>();
    assert!(ancestry.contains(&"FileEditorPane"));
    assert!(ancestry.contains(&"FileEditorDocument"));
    assert!(
        pane.text_position_at(zui::ui::Point::new(100.0, 42.0))
            .is_some()
    );
}

#[test]
fn external_change_notice_exposes_safe_reload_and_overwrite_actions() {
    let mut host = FileEditorHost::default();
    open(&mut host, "notes.txt", "base");
    host.apply(CodeEditorCommand::Insert("local ".into()));
    host.observe_external(TextFileSnapshot::new(
        "notes.txt".into(),
        "disk".into(),
        TextFileDiskVersion::new(
            4,
            TextFileModifiedAt::KnownMillis(2),
            TextFileAccess::Writable,
        ),
    ));
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.interaction_mut().register(UiNode::new(
        WINDOW,
        Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
        AccessibilityRole::Window,
        "Window",
    ));
    frame.interaction_mut().register(
        UiNode::new(
            MAIN_SURFACE,
            Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
            AccessibilityRole::Group,
            "Workspace",
        )
        .with_parent(WINDOW),
    );

    frame.draw_component(&pane);

    assert!(frame.interaction().node(FILE_EDITOR_NOTICE).is_some());
    assert!(
        frame
            .interaction()
            .node(FileEditorAction::Reload.element_id())
            .is_some()
    );
    assert!(
        frame
            .interaction()
            .node(FileEditorAction::Overwrite.element_id())
            .is_some()
    );
    assert!(pane.editor_bounds().origin.y > 32.0);
}

#[test]
fn dirty_close_confirmation_traps_interaction_in_its_decision_bar() {
    let mut host = FileEditorHost::default();
    open(&mut host, "notes.txt", "base");
    host.apply(CodeEditorCommand::Insert("local ".into()));
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    )
    .with_prompt(FileEditorPrompt::ConfirmClose);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.interaction_mut().register(UiNode::new(
        WINDOW,
        Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
        AccessibilityRole::Window,
        "Window",
    ));
    frame.interaction_mut().register(
        UiNode::new(
            MAIN_SURFACE,
            Rect::from_xywh(0.0, 0.0, 480.0, 240.0),
            AccessibilityRole::Group,
            "Workspace",
        )
        .with_parent(WINDOW),
    );

    frame.draw_component(&pane);

    assert!(
        frame
            .interaction()
            .ancestry(FILE_EDITOR_DOCUMENT)
            .is_empty()
    );
    assert_eq!(
        frame
            .interaction()
            .ancestry(FileEditorAction::SaveAndClose.element_id()),
        vec![
            FILE_EDITOR_NOTICE,
            FileEditorAction::SaveAndClose.element_id()
        ]
    );
    assert!(
        frame
            .interaction()
            .node(FileEditorAction::DiscardAndClose.element_id())
            .is_some()
    );
    assert!(
        frame
            .interaction()
            .node(FileEditorAction::CancelClose.element_id())
            .is_some()
    );
}

#[test]
fn file_pane_soft_wrap_drives_visual_viewport_and_caret_reveal() {
    let mut host = FileEditorHost::default();
    open(&mut host, "notes.txt", "abcdefghijklmnopqrstuvwxyz1234");
    host.apply(CodeEditorCommand::SelectAll);
    host.apply(CodeEditorCommand::MoveRight(
        ash_editor::CodeEditorSelectionMode::Move,
    ));
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 160.0, 72.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    );

    assert_eq!(pane.visible_row_capacity(), 2);
    assert_eq!(pane.visual_row_count(), 3);
    assert_eq!(pane.caret_visual_row(), Some(2));
    assert_eq!(pane.caret_bounds(), None);

    host.reveal_active_visual_row(2, 3, 2);
    let pane = FileEditorPane::new(
        Rect::from_xywh(0.0, 0.0, 160.0, 72.0),
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Visible,
    );
    assert!(pane.caret_bounds().is_some());
}

#[test]
fn find_replace_bar_projects_desktop_inputs_and_editor_owned_match_count() {
    let mut host = FileEditorHost::default();
    open(&mut host, "notes.txt", "one fish two fish");
    let mut search = FileEditorSearchState::default();
    search.show_replace();
    search.apply_query(TextInputCommand::Insert("fish".to_owned()));
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let bounds = Rect::from_xywh(0.0, 0.0, 640.0, 260.0);
    let pane = FileEditorPane::new(
        bounds,
        &host,
        CodeEditorStyle::light(),
        DEFAULT_UI_THEME,
        CaretVisibility::Hidden,
    )
    .with_search(
        &search,
        &mut text_layout,
        &dispatch,
        CaretVisibility::Visible,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.interaction_mut().register(UiNode::new(
        WINDOW,
        bounds,
        AccessibilityRole::Window,
        "Window",
    ));
    frame.interaction_mut().register(
        UiNode::new(MAIN_SURFACE, bounds, AccessibilityRole::Group, "Workspace")
            .with_parent(WINDOW),
    );
    frame.draw_component(&pane);
    let scene = frame.scene();

    assert!(frame.interaction().node(FILE_EDITOR_FIND_INPUT).is_some());
    assert!(
        frame
            .interaction()
            .node(FILE_EDITOR_REPLACE_INPUT)
            .is_some()
    );
    assert!(
        frame
            .interaction()
            .node(FileEditorAction::FindNext.element_id())
            .is_some()
    );
    assert!(
        frame
            .interaction()
            .node(FileEditorAction::ReplaceAll.element_id())
            .is_some()
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "2 matches")
    );
    assert_eq!(pane.editor_bounds().origin.y, 104.0);
}
