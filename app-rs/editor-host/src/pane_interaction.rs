use super::FileEditorPane;
use crate::FileEditorSearchMode;
use crate::interaction::{
    FILE_EDITOR_DOCUMENT, FILE_EDITOR_FIND_INPUT, FILE_EDITOR_NOTICE, FILE_EDITOR_REPLACE_INPUT,
    FILE_EDITOR_SEARCH_BAR, FILE_EDITOR_TABS, file_editor_close_id, file_editor_fold_id,
    file_editor_tab_id,
};
use ash_ui_components::InteractionRegion;
use zui::ui::Rect;
use zui::ui::{
    AccessibilityExpansion, AccessibilityRole, AccessibilitySelection, CursorFeedback, ElementId,
    FocusBehavior, NavigationAxis, NavigationGroupId, NodeAction,
};

pub(super) fn child_interaction_regions(pane: &FileEditorPane<'_>) -> Vec<InteractionRegion> {
    let tabs = pane
        .host
        .tabs()
        .iter()
        .enumerate()
        .map(|(index, tab)| {
            InteractionRegion::new(
                "FileEditorTab",
                file_editor_tab_id(index),
                pane.tab_bounds(index),
                AccessibilityRole::RadioButton,
                tab.label(),
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(
                NavigationGroupId::new(FILE_EDITOR_TABS),
                NavigationAxis::Horizontal,
            )
            .with_selection(if pane.host.active_index() == Some(index) {
                AccessibilitySelection::Selected
            } else {
                AccessibilitySelection::Unselected
            })
            .with_children([InteractionRegion::new(
                "FileEditorTabClose",
                file_editor_close_id(index),
                pane.tab_close_bounds(index),
                AccessibilityRole::Button,
                format!("Close {}", tab.label()),
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)])
        })
        .collect::<Vec<_>>();
    let mut regions = vec![
        InteractionRegion::new(
            "FileEditorTabs",
            FILE_EDITOR_TABS,
            Rect::from_xywh(
                pane.bounds.origin.x,
                pane.bounds.origin.y,
                pane.bounds.size.width,
                super::TAB_BAR_HEIGHT,
            ),
            AccessibilityRole::RadioGroup,
            "Open files",
        )
        .with_children(tabs),
    ];
    if pane.search_mode != FileEditorSearchMode::Hidden {
        let mut children = Vec::new();
        if let Some(query) = pane.search_query.as_ref() {
            children.push(
                InteractionRegion::new(
                    "FileEditorFindInput",
                    FILE_EDITOR_FIND_INPUT,
                    query.bounds(),
                    AccessibilityRole::TextInput,
                    "Find",
                )
                .with_cursor(CursorFeedback::Text)
                .with_focus(FocusBehavior::TabStop),
            );
        }
        if let Some(replacement) = pane.search_replacement.as_ref() {
            children.push(
                InteractionRegion::new(
                    "FileEditorReplaceInput",
                    FILE_EDITOR_REPLACE_INPUT,
                    replacement.bounds(),
                    AccessibilityRole::TextInput,
                    "Replace",
                )
                .with_cursor(CursorFeedback::Text)
                .with_focus(FocusBehavior::TabStop),
            );
        }
        children.extend(pane.search_actions().into_iter().map(|action| {
            InteractionRegion::new(
                "FileEditorSearchAction",
                action.element_id(),
                pane.search_action_bounds(action),
                AccessibilityRole::Button,
                action.label(),
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
        }));
        regions.push(
            InteractionRegion::new(
                "FileEditorSearchBar",
                FILE_EDITOR_SEARCH_BAR,
                pane.search_bounds(),
                AccessibilityRole::Toolbar,
                "Find and replace",
            )
            .with_children(children),
        );
    }
    if let Some(notice) = pane.notice() {
        let navigation = NavigationGroupId::new(FILE_EDITOR_NOTICE);
        let actions = notice
            .actions
            .iter()
            .copied()
            .enumerate()
            .map(|(index, action)| {
                InteractionRegion::new(
                    "FileEditorNoticeAction",
                    action.element_id(),
                    pane.notice_action_bounds(notice.actions.len(), index),
                    AccessibilityRole::Button,
                    action.label(),
                )
                .with_cursor(CursorFeedback::Pointer)
                .with_focus(FocusBehavior::TabStop)
                .with_action(NodeAction::Activate)
                .with_navigation(navigation, NavigationAxis::Horizontal)
            })
            .collect::<Vec<_>>();
        regions.push(
            InteractionRegion::new(
                "FileEditorNotice",
                FILE_EDITOR_NOTICE,
                pane.notice_bounds(),
                AccessibilityRole::Group,
                notice.message.clone(),
            )
            .with_children(actions),
        );
    }
    let Some(tab) = pane.host.active() else {
        return regions;
    };
    let Some(editor) = pane.editor() else {
        return regions;
    };
    let folds = editor
        .fold_controls()
        .into_iter()
        .enumerate()
        .map(|(index, control)| {
            InteractionRegion::new(
                "FileEditorFoldControl",
                file_editor_fold_id(index),
                control.bounds(),
                AccessibilityRole::Button,
                format!(
                    "{} lines {} through {}",
                    match control.state() {
                        ash_editor::CodeEditorFoldState::Expanded => "Collapse",
                        ash_editor::CodeEditorFoldState::Collapsed => "Expand",
                    },
                    control.range().start_row() + 1,
                    control.range().end_row() + 1
                ),
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_expansion(match control.state() {
                ash_editor::CodeEditorFoldState::Expanded => AccessibilityExpansion::Expanded,
                ash_editor::CodeEditorFoldState::Collapsed => AccessibilityExpansion::Collapsed,
            })
        })
        .collect::<Vec<_>>();
    regions.push(
        InteractionRegion::new(
            "FileEditorDocument",
            FILE_EDITOR_DOCUMENT,
            pane.editor_bounds(),
            AccessibilityRole::TextInput,
            tab.label(),
        )
        .with_cursor(CursorFeedback::Text)
        .with_focus(FocusBehavior::TabStop)
        .with_value(tab.document().text())
        .with_children(folds),
    );
    regions
}

pub(super) fn modal_root(pane: &FileEditorPane<'_>) -> Option<ElementId> {
    pane.notice()
        .filter(|notice| notice.modal)
        .map(|_| FILE_EDITOR_NOTICE)
}
