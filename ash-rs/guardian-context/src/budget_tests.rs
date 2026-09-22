use super::*;
use action_policy::ReviewEvidence;

fn size(context: &ReviewContext) -> serde_json::Result<usize> {
    serde_json::to_vec(context).map(|bytes| bytes.len() + 100)
}

#[test]
fn removes_old_observations_without_changing_user_instructions() {
    let context = ReviewContext::new(
        "Keep the original files",
        [
            ReviewEvidence::new(
                ReviewEvidenceKind::UserMessage,
                ReviewEvidenceTrust::TrustedUser,
                "first",
                "Keep the original files",
            ),
            ReviewEvidence::new(
                ReviewEvidenceKind::PriorToolResult,
                ReviewEvidenceTrust::UntrustedContent,
                "old",
                "x".repeat(600),
            ),
            ReviewEvidence::new(
                ReviewEvidenceKind::AgentMessage,
                ReviewEvidenceTrust::UntrustedContent,
                "recent",
                "Plan to read",
            ),
        ],
    );
    let fitted = fit(
        &context,
        RequestBudget {
            max_bytes: 800,
            max_estimated_tokens: 300,
        },
        size,
    )
    .unwrap();
    assert_eq!(fitted.user_intent(), context.user_intent());
    assert_eq!(
        fitted
            .evidence()
            .iter()
            .map(|entry| entry.source())
            .collect::<Vec<_>>(),
        ["first", "recent"]
    );
    assert_eq!(fitted.omitted_evidence(), 1);
    assert_eq!(context.evidence().len(), 3);
}

#[test]
fn required_authorization_and_actions_are_never_shortened_to_fit() {
    for kind in [
        ReviewEvidenceKind::UserAnswer,
        ReviewEvidenceKind::Delegation,
        ReviewEvidenceKind::PreparedAction,
    ] {
        let context = ReviewContext::new(
            "intent",
            [ReviewEvidence::new(
                kind,
                ReviewEvidenceTrust::UntrustedContent,
                "source",
                "x".repeat(900),
            )],
        );
        assert!(matches!(
            fit(
                &context,
                RequestBudget {
                    max_bytes: 500,
                    max_estimated_tokens: 500
                },
                size
            ),
            Err(BudgetError::RequiredContextTooLarge { .. })
        ));
    }
}

#[test]
fn token_budget_and_json_escaping_count_the_complete_payload() {
    let context = ReviewContext::new("中文\n\"授权\"".repeat(80), []);
    assert!(matches!(
        fit(
            &context,
            RequestBudget {
                max_bytes: 10000,
                max_estimated_tokens: 100
            },
            size
        ),
        Err(BudgetError::RequiredContextTooLarge { .. })
    ));
    let bytes = size(&context).unwrap();
    assert!(
        fit(
            &context,
            RequestBudget {
                max_bytes: bytes,
                max_estimated_tokens: bytes.div_ceil(3)
            },
            size
        )
        .is_ok()
    );
    assert!(
        fit(
            &context,
            RequestBudget {
                max_bytes: bytes - 1,
                max_estimated_tokens: bytes
            },
            size
        )
        .is_err()
    );
}

#[test]
fn long_history_keeps_the_newest_observations_and_all_interleaved_instructions() {
    let mut evidence = Vec::new();
    for index in 0..50 {
        evidence.push(ReviewEvidence::new(
            ReviewEvidenceKind::PriorToolResult,
            ReviewEvidenceTrust::UntrustedContent,
            format!("tool-{index}"),
            "output".repeat(50),
        ));
        if index == 25 {
            evidence.push(ReviewEvidence::new(
                ReviewEvidenceKind::UserMessage,
                ReviewEvidenceTrust::TrustedUser,
                "user",
                "Do not delete files",
            ));
        }
    }
    let context = ReviewContext::new("Do not delete files", evidence);
    let fitted = fit(
        &context,
        RequestBudget {
            max_bytes: 1600,
            max_estimated_tokens: 1600,
        },
        size,
    )
    .unwrap();
    assert!(size(&fitted).unwrap() <= 1600);
    assert!(
        fitted
            .evidence()
            .iter()
            .any(|entry| entry.source() == "user")
    );
    assert_eq!(fitted.evidence().last().unwrap().source(), "tool-49");
    assert_eq!(fitted.omitted_evidence() + fitted.evidence().len(), 51);
    let omitted = fitted.omitted_evidence();
    let last_removed = context
        .evidence()
        .iter()
        .find(|entry| entry.source() == format!("tool-{}", omitted - 1))
        .unwrap();
    let one_more = ReviewContext::new(
        context.user_intent(),
        std::iter::once(last_removed.clone()).chain(fitted.evidence().iter().cloned()),
    )
    .with_omitted_evidence(omitted - 1);
    assert!(size(&one_more).unwrap() > 1600);
}
