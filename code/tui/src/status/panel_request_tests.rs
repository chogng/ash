//! Status panel request tests.

use super::remaining_context_window;
use crate::status::RemainingContextWindow;
use ash_protocol::ApprovalMode;
use ash_protocol::ModelContextUsage;
use ash_protocol::ModelContextUsageSource;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_protocol::ToolMode;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;

#[test]
fn remaining_context_uses_only_the_latest_matching_turn_window() {
    let selected_model = model("gpt-ash");
    let mut thread = thread(selected_model.clone());

    assert_eq!(
        remaining_context_window(Some(90_000), Some(&selected_model), &thread),
        RemainingContextWindow::Exact {
            remaining_tokens: 65_000,
            available_tokens: 90_000,
        }
    );

    thread.turns[0].context_usage = Some(ModelContextUsage {
        used_tokens: 30_000,
        source: ModelContextUsageSource::Estimated,
    });
    assert_eq!(
        remaining_context_window(Some(90_000), Some(&selected_model), &thread),
        RemainingContextWindow::Estimated {
            remaining_tokens: 60_000,
            available_tokens: 90_000,
        }
    );

    thread.turns[0].model = Some(model("another-model"));
    assert_eq!(
        remaining_context_window(Some(90_000), Some(&selected_model), &thread),
        RemainingContextWindow::Unknown
    );
}

fn model(name: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new(name).unwrap(),
    )
}

fn thread(model: ModelRef) -> Thread {
    Thread {
        advisor: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("session-1").unwrap(),
        thread_id: ThreadId::new("thread-1").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "test".into(),
        status: ThreadStatus::Active,
        sequence: 4,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: vec![Turn {
            advisor: None,
            turn_id: TurnId::new("turn-1").unwrap(),
            status: TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: Some(model),
            tool_profile: None,
            tool_mode: ToolMode::Direct,
            approval_mode: ApprovalMode::AskPermissions,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: Some(ModelContextUsage {
                used_tokens: 25_000,
                source: ModelContextUsageSource::ProviderReported,
            }),
            items: Vec::new(),
            plan: None,
            pending_interaction: None,
            error: None,
        }],
    }
}
