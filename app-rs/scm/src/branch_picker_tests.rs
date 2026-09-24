use super::{
    GitBranchPicker, GitBranchPickerAction, GitBranchPickerActivation, GitBranchPickerState,
};
use ash_app_server_protocol::protocol::git::GitBranchDto;
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{AccessibilityRole, InteractionFrame, UiDispatch, UiFrame};
use zui::ui::{CaretVisibility, Rect, TextInputCommand, TextInputLayoutEngine};

const COMPOSER: zui::ui::ElementId = zui::ui::ElementId::scoped(91, 1);

#[test]
fn branch_picker_places_the_current_branch_first_and_marks_it() {
    let mut state = GitBranchPickerState::default();

    state.open(
        Rect::from_xywh(240.0, 640.0, 90.0, 24.0),
        branches(&["zulu", "main", "alpha"]),
        Some(COMPOSER),
    );

    let items = state.items();
    assert_eq!(items[0].label, "✓ main");
    assert_eq!(items[1].label, "alpha");
    assert_eq!(items[2].label, "zulu");
    assert!(matches!(
        items[0].action,
        Some(GitBranchPickerAction::Select(_))
    ));
    assert_eq!(state.dismiss(), Some(COMPOSER));
}

#[test]
fn branch_picker_uses_shared_picker_geometry_and_modal_semantics() {
    let anchor = Rect::from_xywh(240.0, 640.0, 90.0, 24.0);
    let mut state = GitBranchPickerState::default();
    state.open(anchor, branches(&["main", "topic"]), None);
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let menu = GitBranchPicker::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &state,
        CaretVisibility::Visible,
        DEFAULT_UI_THEME,
        &mut text_layout,
        &dispatch,
    )
    .unwrap();
    let mut frame = UiFrame::<InteractionFrame>::new(DEFAULT_UI_THEME.workbench_background);
    frame.draw_component(&menu);

    assert!(menu.bounds().bottom() <= anchor.origin.y);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    assert_eq!(nodes[0].role, AccessibilityRole::Menu);
    assert_eq!(nodes[1].role, AccessibilityRole::TextInput);
    assert_eq!(nodes[2].role, AccessibilityRole::MenuItem);
}

#[test]
fn search_row_filters_branches_and_resets_to_the_first_page() {
    let mut state = GitBranchPickerState::default();
    state.open(
        Rect::from_xywh(240.0, 640.0, 90.0, 24.0),
        branches(&["main", "feature/search", "topic"]),
        None,
    );

    state.apply_search(TextInputCommand::Insert("search".to_string()));

    assert_eq!(state.search_input().text(), "search");
    assert_eq!(state.items().len(), 1);
    assert_eq!(state.items()[0].label, "feature/search");
}

#[test]
fn branch_picker_pages_large_branch_lists_and_surfaces_switch_errors() {
    let mut branch_names = vec!["main".to_string()];
    branch_names.extend((0..12).map(|index| format!("topic-{index:02}")));
    let branch_names = branch_names.iter().map(String::as_str).collect::<Vec<_>>();
    let mut state = GitBranchPickerState::default();
    state.open(
        Rect::from_xywh(240.0, 640.0, 90.0, 24.0),
        branches(&branch_names),
        None,
    );
    let more_index = state.items().len() - 1;

    assert_eq!(
        state.activate(more_index),
        Some(GitBranchPickerActivation::PageChanged)
    );
    assert!(
        state
            .items()
            .iter()
            .any(|item| item.label == "← Previous branches")
    );
    state.set_switch_error();
    assert_eq!(
        state.items()[0].label,
        "Switch failed · working tree unchanged"
    );
    assert!(state.items()[0].action.is_none());
}

fn branches(names: &[&str]) -> Vec<GitBranchDto> {
    names
        .iter()
        .map(|name| GitBranchDto {
            name: (*name).into(),
            object_id: format!("object-{name}"),
            current: *name == "main",
            upstream: None,
        })
        .collect()
}
