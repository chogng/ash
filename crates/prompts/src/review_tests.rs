use super::review_target_prompt;
use ash_protocol::ReviewTarget;

#[test]
fn review_exit_notices_keep_completed_interrupted_and_failed_assessments_distinct() {
    for (outcome, status) in [
        (super::ReviewOutcome::Completed, "completed"),
        (super::ReviewOutcome::Interrupted, "interrupted"),
        (super::ReviewOutcome::Failed, "failed"),
    ] {
        let prompt = super::review_exit_prompt(outcome);
        prompt.freeze().validate().unwrap();
        assert!(
            prompt
                .body()
                .contains(&format!("<review_end status=\"{status}\">"))
        );
        assert_eq!(prompt.body().matches("</review_end>").count(), 1);
        assert!(!prompt.body().contains("{{"));
    }
}

#[test]
fn review_targets_render_exact_scope() {
    assert_eq!(
        review_target_prompt(&ReviewTarget::UncommittedChanges).unwrap(),
        "Review the current code changes, including staged, unstaged, and untracked files."
    );
    assert_eq!(
        review_target_prompt(&ReviewTarget::BaseBranch {
            branch: " main ".into(),
        })
        .unwrap(),
        "Review the changes against base branch `main`. Determine the merge base with HEAD, then inspect the diff from that merge base."
    );
    assert_eq!(
        review_target_prompt(&ReviewTarget::Commit {
            sha: "abc123".into(),
            title: Some("fix durability".into()),
        })
        .unwrap(),
        "Review the changes introduced by commit `abc123` (fix durability)."
    );
}

#[test]
fn empty_review_scope_is_rejected() {
    let error = review_target_prompt(&ReviewTarget::Custom {
        instructions: "  ".into(),
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "custom review instructions must not be empty"
    );
}
