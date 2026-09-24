use std::time::Duration;
use std::time::Instant;

use ash_editor::CodeEditorCommand;
use ash_editor::CodeEditorSelectionMode;
use ash_input_classifier::InputConversation;
use ash_input_classifier::InputHistoryEntry;
use zui::ui::TextInputCompositionCursor;
use zui::ui::TextInputCompositionEvent;

use super::ChatInput;
use super::ComposerClassificationTask;
use super::ComposerClassificationUpdate;
use super::ComposerRoute;
use super::ComposerSubmission;

fn take_task(input: &mut ChatInput) -> ComposerClassificationTask {
    input
        .take_classification_task(Instant::now() + Duration::from_secs(1))
        .unwrap()
}

#[test]
fn typing_coalesces_inference_and_navigation_keeps_the_same_deadline() {
    let mut input = ChatInput::default();
    input.set_text("git status 是做什么的");
    let deadline = input.classification_deadline().unwrap();
    assert!(
        input
            .take_classification_task(deadline - Duration::from_nanos(1))
            .is_none()
    );
    input.apply(CodeEditorCommand::MoveLeft(CodeEditorSelectionMode::Move));
    assert_eq!(input.classification_deadline(), Some(deadline));
    input.set_text("git status 是做什么的？");
    assert!(input.classification_deadline().unwrap() >= deadline);
    let task = take_task(&mut input);
    assert!(
        input
            .take_classification_task(Instant::now() + Duration::from_secs(1))
            .is_none()
    );
    assert_eq!(
        input.finish_classification(task.run()),
        ComposerClassificationUpdate::Updated
    );
    assert!(
        matches!(input.submission(), Some(ComposerSubmission::AgentMessage(text)) if text.ends_with('？'))
    );
}

#[test]
fn an_old_model_result_cannot_replace_a_new_deterministic_shell_route() {
    let mut input = ChatInput::default();
    input.set_text("git status 是做什么的");
    let old = take_task(&mut input);
    input.set_text("git status");
    assert_eq!(input.route(), ComposerRoute::Shell);
    assert_eq!(
        input.finish_classification(old.run()),
        ComposerClassificationUpdate::Stale
    );
    assert_eq!(input.route(), ComposerRoute::Shell);
}

#[test]
fn history_recall_cancels_inference_and_restoring_an_unresolved_draft_reclassifies() {
    let mut input = ChatInput::default();
    input.set_text("echo previous");
    input.clear_after_submit();
    input.set_text("git status");
    input.set_text("git status 是做什么的");
    assert!(input.request_submission().is_none());
    let old = take_task(&mut input);
    input.apply(CodeEditorCommand::MoveUp(CodeEditorSelectionMode::Move));
    assert_eq!(input.input().text(), "echo previous");
    assert_eq!(input.route(), ComposerRoute::Shell);
    assert_eq!(
        input.finish_classification(old.run()),
        ComposerClassificationUpdate::Stale
    );
    input.cancel_history();
    assert_eq!(input.input().text(), "git status 是做什么的");
    assert!(input.submission().is_none());
    let restored = take_task(&mut input);
    assert_eq!(
        input.finish_classification(restored.run()),
        ComposerClassificationUpdate::Updated
    );
    assert_eq!(input.route(), ComposerRoute::Agent);
}

#[test]
fn enter_waits_for_the_current_input_and_skips_the_debounce() {
    let mut input = ChatInput::default();
    input.set_text("git status");
    input.set_text("git status 是做什么的");
    assert!(input.submission().is_none());
    assert!(input.request_submission().is_none());
    let task = input.take_classification_task(Instant::now()).unwrap();
    assert_eq!(
        input.finish_classification(task.run()),
        ComposerClassificationUpdate::Submit
    );
    assert!(matches!(
        input.request_submission(),
        Some(ComposerSubmission::AgentMessage(_))
    ));
}

#[test]
fn editing_or_escape_cancels_a_waiting_submission() {
    for escape in [false, true] {
        let mut input = ChatInput::default();
        input.set_text("git status 是做什么的");
        assert!(input.request_submission().is_none());
        let task = take_task(&mut input);
        if escape {
            input.cancel_composition();
            assert_eq!(
                input.finish_classification(task.run()),
                ComposerClassificationUpdate::Updated
            );
        } else {
            input.set_text("git status 是做什么的？");
            assert_eq!(
                input.finish_classification(task.run()),
                ComposerClassificationUpdate::Stale
            );
            let latest = take_task(&mut input);
            assert_eq!(
                input.finish_classification(latest.run()),
                ComposerClassificationUpdate::Updated
            );
        }
    }
}

#[test]
fn ime_preedit_does_not_restart_inference_or_allow_submission() {
    let mut input = ChatInput::default();
    input.set_text("git status 是做什么的");
    let deadline = input.classification_deadline();
    input.apply_composition(TextInputCompositionEvent::Preedit {
        text: "呢".to_owned(),
        cursor: TextInputCompositionCursor::Visible(0..3),
    });
    assert_eq!(input.classification_deadline(), deadline);
    assert!(input.request_submission().is_none());
    let task = take_task(&mut input);
    assert_eq!(
        input.finish_classification(task.run()),
        ComposerClassificationUpdate::Updated
    );
    assert!(input.submission().is_none());
}

#[test]
fn changed_history_or_directory_invalidates_captured_model_results() {
    let mut input = ChatInput::default();
    input.set_text("git status 是做什么的");
    let old = take_task(&mut input);
    input.refresh_dir_catalog();
    assert_eq!(
        input.finish_classification(old.run()),
        ComposerClassificationUpdate::Stale
    );
    let old = take_task(&mut input);
    input.replace_classification_history([InputHistoryEntry::shell("git status 是做什么的")]);
    assert_eq!(
        input.finish_classification(old.run()),
        ComposerClassificationUpdate::Stale
    );
    assert_eq!(input.route(), ComposerRoute::Shell);
}

#[test]
fn unchanged_session_updates_preserve_pending_inference_and_submission() {
    let mut input = ChatInput::default();
    input.replace_classification_history([InputHistoryEntry::agent("earlier request")]);
    input.set_text("git status 是做什么的");
    input.request_submission();
    let task = take_task(&mut input);
    input.replace_classification_history([InputHistoryEntry::agent("earlier request")]);
    input.synchronize_conversation(InputConversation::Standalone);
    input.mark_agent_response_started();
    assert_eq!(
        input.finish_classification(task.run()),
        ComposerClassificationUpdate::Submit
    );
}

#[test]
fn results_cannot_cross_panes_or_survive_clearing_the_input() {
    let mut first = ChatInput::default();
    first.set_text("git status 是做什么的");
    let task = take_task(&mut first);
    let mut second = ChatInput::default();
    second.set_text("git status 是做什么的");
    assert_eq!(
        second.finish_classification(task.run()),
        ComposerClassificationUpdate::Stale
    );
    let task = take_task(&mut second);
    second.clear_after_submit();
    assert_eq!(
        second.finish_classification(task.run()),
        ComposerClassificationUpdate::Stale
    );
    assert_eq!(second.route(), ComposerRoute::Agent);
}
