use ash_editor::CodeEditorCommand;
use zui::ui::Color;
use zui::ui::InteractionFrame;
use zui::ui::Rect;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use super::ChangesActivation;
use super::ChangesToolbar;
use super::ChangesToolbarAction;
use super::ChangesToolbarState;
use super::PRIMARY_MAIN;
use super::PRIMARY_MORE;
use super::PullRequestMode;
use super::scope_item_id;
use crate::CHANGES_TOOLBAR;
use crate::COMMIT_MESSAGE_EDITOR;
use crate::TEST_SCM_PANE_STYLE;

#[test]
fn primary_branch_direct_action_uses_the_automatic_turn_commit() {
    let mut state = ChangesToolbarState::default();
    state.set_branch(Some("main"));

    assert_eq!(
        state.activate(Some(ChangesToolbarAction::PrimaryMain)),
        ChangesActivation::GenerateAndCommit
    );
    state.activate(Some(ChangesToolbarAction::PrimaryMore));
    assert_eq!(
        state.activate(Some(ChangesToolbarAction::PrimaryMenu(0))),
        ChangesActivation::Focus(COMMIT_MESSAGE_EDITOR)
    );
}

#[test]
fn topic_branch_actions_select_the_requested_pull_request_policy() {
    let mut state = ChangesToolbarState::default();
    state.set_branch(Some("feature/toolbar"));

    assert_eq!(
        state.activate(Some(ChangesToolbarAction::PrimaryMain)),
        ChangesActivation::CreatePullRequest(PullRequestMode::Default)
    );
    assert_eq!(
        state.activate(Some(ChangesToolbarAction::PrimaryMenu(1))),
        ChangesActivation::CreatePullRequest(PullRequestMode::AutoSquash)
    );
}

#[test]
fn commit_composer_returns_the_message_include_choice_and_push_choice() {
    let mut state = ChangesToolbarState::default();
    state.apply_commit_message(CodeEditorCommand::Insert(
        "feat: add changes toolbar".into(),
    ));
    state.activate(Some(ChangesToolbarAction::ToggleIncludeUnstaged));

    assert_eq!(
        state.activate(Some(ChangesToolbarAction::SubmitCommitAndPush)),
        ChangesActivation::Commit {
            message: "feat: add changes toolbar".into(),
            include_unstaged: true,
            push: true,
        }
    );
}

#[test]
fn toolbar_and_open_menu_are_in_the_component_interaction_tree() {
    let mut state = ChangesToolbarState::default();
    state.set_branch(Some("main"));
    state.activate(Some(ChangesToolbarAction::ScopeMore));
    let dispatch = UiDispatch::default();
    let toolbar = ChangesToolbar::new(
        Rect::from_xywh(0.0, 0.0, 760.0, 40.0),
        Rect::from_xywh(0.0, 0.0, 760.0, 500.0),
        &state,
        TEST_SCM_PANE_STYLE,
        zui::ui::ElementId::scoped(1, 1),
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&toolbar);

    let labels = frame
        .interaction()
        .accessibility_nodes(&dispatch)
        .into_iter()
        .map(|node| (node.id, node.label))
        .collect::<Vec<_>>();
    assert!(labels.iter().any(|(id, _)| *id == CHANGES_TOOLBAR));
    assert!(labels.iter().any(|(id, _)| *id == PRIMARY_MAIN));
    assert!(labels.iter().any(|(id, _)| *id == PRIMARY_MORE));
    assert!(labels.iter().any(|(id, _)| *id == scope_item_id(0)));
    assert!(labels.iter().any(|(_, label)| label == "Current turn"));
}

#[test]
fn split_copies_the_commit_draft_without_sharing_edits_or_the_open_menu() {
    let first_identity = crate::ScmPaneIdentity::new(1);
    let second_identity = crate::ScmPaneIdentity::new(2);
    let mut first = ChangesToolbarState::new(first_identity);
    first.set_branch(Some("main"));
    first.apply_commit_message(CodeEditorCommand::Insert("initial draft".into()));
    assert_eq!(
        first.activate(Some(ChangesToolbarAction::PrimaryMenu(0))),
        ChangesActivation::Focus(first_identity.element(COMMIT_MESSAGE_EDITOR))
    );
    let mut second = first.duplicate(second_identity);
    assert!(second.open.is_none());
    second.apply_commit_message(CodeEditorCommand::SelectAll);
    assert_eq!(second.selected_commit_message(), Some("initial draft"));
    second.apply_commit_message(CodeEditorCommand::Insert("second draft".into()));
    assert_eq!(
        second.activate(Some(ChangesToolbarAction::SubmitCommit)),
        ChangesActivation::Commit {
            message: "second draft".into(),
            include_unstaged: false,
            push: false
        }
    );
    assert_eq!(
        first.activate(Some(ChangesToolbarAction::SubmitCommit)),
        ChangesActivation::Commit {
            message: "initial draft".into(),
            include_unstaged: false,
            push: false
        }
    );
    assert_eq!(
        first_identity.local(second_identity.element(PRIMARY_MAIN)),
        None
    );
}
