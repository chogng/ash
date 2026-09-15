use super::*;
use ash_config::HookAction;
use ash_config::HookEnablement;
use ash_config::HookEvent as ConfigHookEvent;
use ash_config::HookId;
use ash_config::HookMatcher;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookRequest;
use core_api::ToolExecutionOutcome;
use core_api::TurnCompletedHookRequest;
use std::collections::BTreeSet;

fn hook(event: ConfigHookEvent, tool_names: &[&str]) -> HookConfig {
    HookConfig {
        id: HookId::new("user:hook:matcher").expect("test Hook id"),
        event,
        matcher: HookMatcher {
            tool_names: tool_names
                .iter()
                .map(|name| (*name).into())
                .collect::<BTreeSet<_>>(),
        },
        action: HookAction::Process {
            program: "hook-program".into(),
            args: Vec::new(),
        },
        enablement: HookEnablement::Enabled,
    }
}

fn before_request(tool_name: &str) -> BeforeToolHookRequest {
    BeforeToolHookRequest {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread-test").unwrap(),
        turn_id: TurnId::new("turn-test").unwrap(),
        tool_call_id: ToolCallId::new("tool-test").unwrap(),
        tool_name: tool_name.into(),
    }
}

fn after_request(tool_name: &str, outcome: ToolExecutionOutcome) -> AfterToolHookRequest {
    AfterToolHookRequest {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread-test").unwrap(),
        turn_id: TurnId::new("turn-test").unwrap(),
        tool_call_id: ToolCallId::new("tool-test").unwrap(),
        tool_name: tool_name.into(),
        outcome,
    }
}

#[test]
fn exact_tool_matcher_applies_only_to_the_declared_tool_event() {
    let hook = hook(ConfigHookEvent::BeforeTool, &["shell-command"]);

    assert!(matches_event(
        &hook,
        &HookInvocation::BeforeTool(&before_request("shell-command"))
    ));
    assert!(!matches_event(
        &hook,
        &HookInvocation::BeforeTool(&before_request("file-system"))
    ));
    assert!(!matches_event(
        &hook,
        &HookInvocation::AfterTool(&after_request(
            "shell-command",
            ToolExecutionOutcome::Succeeded
        ))
    ));
}

#[test]
fn empty_matcher_matches_tool_events_but_not_another_event() {
    let hook = hook(ConfigHookEvent::AfterTool, &[]);

    assert!(matches_event(
        &hook,
        &HookInvocation::AfterTool(&after_request("file-system", ToolExecutionOutcome::Failed))
    ));
    let completed = TurnCompletedHookRequest {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread-test").unwrap(),
        turn_id: TurnId::new("turn-test").unwrap(),
    };
    assert!(!matches_event(
        &hook,
        &HookInvocation::TurnCompleted(&completed)
    ));
}
