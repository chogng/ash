use crate::protocol::HookInvocation;
use ash_config::HookConfig;
use ash_config::HookEvent;
use core_api::ToolExecutionOutcome;

pub(crate) fn matches_event(hook: &HookConfig, invocation: &HookInvocation<'_>) -> bool {
    let event_matches = match (hook.event, invocation) {
        (HookEvent::PreToolUse | HookEvent::BeforeTool, HookInvocation::BeforeTool(_)) => true,
        (HookEvent::PostToolUse, HookInvocation::AfterTool(request)) => {
            request.outcome == ToolExecutionOutcome::Succeeded
        }
        (HookEvent::PostToolUseFailure, HookInvocation::AfterTool(request)) => {
            request.outcome == ToolExecutionOutcome::Failed
        }
        (HookEvent::AfterTool, HookInvocation::AfterTool(_)) => true,
        (HookEvent::Stop | HookEvent::TurnCompleted, HookInvocation::TurnCompleted(_)) => true,
        (event, HookInvocation::Event(request)) => event == request.event,
        _ => false,
    };
    if !event_matches {
        return false;
    }
    match invocation.tool_name() {
        Some(tool_name) => {
            hook.matcher.tool_names.is_empty() || hook.matcher.tool_names.contains(tool_name)
        }
        None => hook.matcher.tool_names.is_empty(),
    }
}

#[cfg(test)]
#[path = "matcher_tests.rs"]
mod tests;
