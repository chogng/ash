//! Latest-request context measurement tests.

use super::Usage as ContextUsage;
use super::context_usage;
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
fn context_usage_keeps_the_measurement_source_and_pending_state() {
    let selected_model = model("gpt-ash");
    let mut thread = thread(selected_model.clone());

    assert_eq!(
        context_usage(&thread),
        ContextUsage::Measured {
            used_tokens: 25_000,
            source: ash_protocol::ModelContextUsageSource::ProviderReported
        }
    );

    thread.turns[0].context_usage = Some(ModelContextUsage {
        used_tokens: 30_000,
        source: ModelContextUsageSource::Estimated,
    });
    assert_eq!(
        context_usage(&thread),
        ContextUsage::Measured {
            used_tokens: 30_000,
            source: ash_protocol::ModelContextUsageSource::Estimated
        }
    );

    thread.turns[0].context_usage = None;
    assert_eq!(context_usage(&thread), ContextUsage::Pending);
}

#[test]
fn context_usage_waits_for_the_latest_turn_and_preserves_the_reported_total() {
    let selected = model("gpt-ash");
    let mut thread = thread(selected.clone());
    let mut latest = thread.turns[0].clone();
    latest.context_usage = None;
    thread.turns.push(latest);
    assert_eq!(context_usage(&thread), ContextUsage::Pending);
    thread.turns[1].context_usage = Some(ModelContextUsage {
        used_tokens: 1_200_000,
        source: ModelContextUsageSource::ProviderReported,
    });
    assert_eq!(
        context_usage(&thread),
        ContextUsage::Measured {
            used_tokens: 1_200_000,
            source: ModelContextUsageSource::ProviderReported,
        }
    );
    thread.turns.clear();
    assert_eq!(context_usage(&thread), ContextUsage::NotStarted);
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
            mode: Default::default(),
            advisor: None,
            turn_id: TurnId::new("turn-1").unwrap(),
            status: TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: Some(model),
            reasoning_effort: None,
            tool_profile: None,
            tool_mode: ToolMode::Direct,
            approval_mode: ApprovalMode::Manual,
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
