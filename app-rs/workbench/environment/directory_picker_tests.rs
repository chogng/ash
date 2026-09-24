use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    DirectoryPicker, DirectoryPickerAction, DirectoryPickerActivation, DirectoryPickerState,
    directory_item_id,
};
use ash_ui_components::{ScrollAxis, ScrollCommand};
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{AccessibilityRole, InteractionFrame, UiDispatch, UiFrame};
use zui::ui::{CaretVisibility, Point, Rect, TextInputCommand, TextInputLayoutEngine};

const COMPOSER: zui::ui::ElementId = zui::ui::ElementId::scoped(91, 1);

static NEXT_PICKER_ID: AtomicU64 = AtomicU64::new(0);

#[test]
fn picker_lists_current_parent_and_sorted_child_directories() {
    let root = picker_fixture();
    std::fs::create_dir_all(root.join("zulu")).unwrap();
    std::fs::create_dir_all(root.join("Alpha")).unwrap();
    std::fs::write(root.join("ignored.txt"), "file").unwrap();
    let mut state = DirectoryPickerState::default();

    state
        .open(
            Rect::from_xywh(40.0, 640.0, 180.0, 24.0),
            &root,
            None,
            Some(COMPOSER),
        )
        .unwrap();

    let items = state.items();
    assert!(items[0].label.starts_with("Use this folder · "));
    assert!(matches!(
        &items[0].action,
        Some(DirectoryPickerAction::Select(_))
    ));
    assert!(items[1].label.starts_with("↑ Parent · "));
    assert_eq!(items[2].label, "› Alpha/");
    assert_eq!(items[3].label, "› zulu/");
    assert_eq!(state.dismiss(), Some(COMPOSER));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn picker_scrolls_all_children_without_paging() {
    let root = picker_fixture();
    for index in 0..10 {
        std::fs::create_dir_all(root.join(format!("folder-{index:02}"))).unwrap();
    }
    let mut state = DirectoryPickerState::default();
    state
        .open(Rect::from_xywh(40.0, 640.0, 180.0, 24.0), &root, None, None)
        .unwrap();
    let items = state.items();

    assert_eq!(items.len(), 12);
    assert!(
        items
            .iter()
            .all(|item| !item.label.contains("folders →") && !item.label.contains("← Previous"))
    );
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let picker = DirectoryPicker::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &state,
        CaretVisibility::Visible,
        DEFAULT_UI_THEME,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let metrics = picker.scroll_metrics().unwrap();
    assert!(metrics.maximum_offset().y > 0.0);
    assert!(picker.item_bounds(items.len() - 1).unwrap().is_empty());

    assert!(state.apply_scroll(ScrollCommand::ToEnd(ScrollAxis::Vertical), metrics));
    let picker = DirectoryPicker::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &state,
        CaretVisibility::Visible,
        DEFAULT_UI_THEME,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    assert!(!picker.item_bounds(items.len() - 1).unwrap().is_empty());
    let child_index = state
        .items()
        .iter()
        .position(|item| item.label == "› folder-08/")
        .unwrap();
    assert_eq!(
        state.activate(child_index).unwrap(),
        Some(DirectoryPickerActivation::BrowseChanged)
    );
    assert_eq!(
        state.open.as_ref().unwrap().directory,
        root.join("folder-08").canonicalize().unwrap()
    );
    assert_eq!(
        state.activate(0).unwrap(),
        Some(DirectoryPickerActivation::SelectDirectory(
            root.join("folder-08").canonicalize().unwrap()
        ))
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn picker_is_anchored_above_the_toolbar_and_registers_modal_menu_semantics() {
    let root = picker_fixture();
    std::fs::create_dir_all(root.join("child")).unwrap();
    let anchor = Rect::from_xywh(40.0, 640.0, 180.0, 24.0);
    let mut state = DirectoryPickerState::default();
    state.open(anchor, &root, None, None).unwrap();
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let picker = DirectoryPicker::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &state,
        CaretVisibility::Visible,
        DEFAULT_UI_THEME,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut frame = UiFrame::<InteractionFrame>::new(DEFAULT_UI_THEME.workbench_background);
    frame.draw_component(&picker);
    let scene = frame.scene();

    assert!(picker.bounds().bottom() <= anchor.origin.y);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    assert_eq!(nodes[0].role, AccessibilityRole::Menu);
    assert_eq!(nodes[1].role, AccessibilityRole::TextInput);
    assert_eq!(nodes[2].role, AccessibilityRole::MenuItem);
    assert_eq!(frame.interaction().target_at(Point::new(42.0, 642.0)), None);
    let search_target = scene
        .inspection()
        .target_at(Point::new(
            picker.bounds().origin.x + 10.0,
            picker.bounds().origin.y + 10.0,
        ))
        .expect("search box should be inspectable");
    assert_eq!(
        scene
            .inspection()
            .ancestry(search_target.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        vec![
            "Picker",
            "Dropdown",
            "ContextView",
            "Menu",
            "SearchBox",
            "InputBox",
        ]
    );
    assert_eq!(state.first_action_id(), Some(directory_item_id(0)));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn search_row_filters_child_directories_and_resets_after_browsing() {
    let root = picker_fixture();
    std::fs::create_dir_all(root.join("alpha")).unwrap();
    std::fs::create_dir_all(root.join("beta")).unwrap();
    let mut state = DirectoryPickerState::default();
    state
        .open(Rect::from_xywh(40.0, 640.0, 180.0, 24.0), &root, None, None)
        .unwrap();

    state.apply_search(TextInputCommand::Insert("bet".to_string()));

    let items = state.items();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].label, "› beta/");
    assert_eq!(
        state.activate(0).unwrap(),
        Some(DirectoryPickerActivation::BrowseChanged)
    );
    assert!(state.search_input().text().is_empty());
    assert!(
        state
            .items()
            .first()
            .is_some_and(|item| item.label.starts_with("Use this folder · "))
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn picker_offers_repository_root_and_accepts_an_explicit_path_query() {
    let repository = picker_fixture();
    let dir = repository.join("dir");
    let sibling = repository.join("sibling");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    let mut state = DirectoryPickerState::default();
    state
        .open(
            Rect::from_xywh(40.0, 640.0, 180.0, 24.0),
            &dir,
            Some(&repository),
            None,
        )
        .unwrap();

    let items = state.items();
    assert!(items[1].label.starts_with("Git repository root · "));
    assert_eq!(
        state.activate(1).unwrap(),
        Some(DirectoryPickerActivation::SelectDirectory(
            repository.canonicalize().unwrap()
        ))
    );

    state.apply_search(TextInputCommand::Insert("../sibling".to_string()));

    assert!(state.items()[0].label.starts_with("Use path · "));
    assert_eq!(
        state.activate(0).unwrap(),
        Some(DirectoryPickerActivation::SelectDirectory(
            sibling.canonicalize().unwrap()
        ))
    );
    std::fs::remove_dir_all(repository).unwrap();
}

fn picker_fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "ash-directory-picker-{}-{}",
        std::process::id(),
        NEXT_PICKER_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}
