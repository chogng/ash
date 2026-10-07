use ash_config::HookConfig;
use ash_config::HookEvent as ConfigHookEvent;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookRequest;
use core_api::CoreError;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::ToolExecutionOutcome;
use core_api::TurnCompletedHookRequest;
use serde::Serialize;
use std::path::Path;

const HOOK_PROTOCOL_VERSION: u8 = 1;
const HOOK_INPUT_BYTES: usize = 64 * 1024;

pub(crate) enum HookInvocation<'a> {
    BeforeTool(&'a BeforeToolHookRequest),
    AfterTool(&'a AfterToolHookRequest),
    TurnCompleted(&'a TurnCompletedHookRequest),
    Event(&'a HookEventRequest),
}

impl HookInvocation<'_> {
    pub(crate) fn session_id(&self) -> Option<&ash_protocol::SessionId> {
        match self {
            Self::BeforeTool(request) => Some(&request.session_id),
            Self::AfterTool(request) => Some(&request.session_id),
            Self::TurnCompleted(request) => Some(&request.session_id),
            Self::Event(request) => match &request.scope {
                HookEventScope::User => None,
                HookEventScope::Session { session_id }
                | HookEventScope::Turn { session_id, .. } => Some(session_id),
            },
        }
    }

    pub(crate) fn thread_id(&self) -> Option<&ash_protocol::ThreadId> {
        match self {
            Self::BeforeTool(request) => Some(&request.thread_id),
            Self::AfterTool(request) => Some(&request.thread_id),
            Self::TurnCompleted(request) => Some(&request.thread_id),
            Self::Event(request) => match &request.scope {
                HookEventScope::Turn { thread_id, .. } => Some(thread_id),
                HookEventScope::User | HookEventScope::Session { .. } => None,
            },
        }
    }

    pub(crate) fn turn_id(&self) -> Option<&ash_protocol::TurnId> {
        match self {
            Self::BeforeTool(request) => Some(&request.turn_id),
            Self::AfterTool(request) => Some(&request.turn_id),
            Self::TurnCompleted(request) => Some(&request.turn_id),
            Self::Event(request) => match &request.scope {
                HookEventScope::Turn { turn_id, .. } => Some(turn_id),
                HookEventScope::User | HookEventScope::Session { .. } => None,
            },
        }
    }

    pub(crate) fn tool_name(&self) -> Option<&str> {
        match self {
            Self::BeforeTool(request) => Some(&request.tool_name),
            Self::AfterTool(request) => Some(&request.tool_name),
            Self::TurnCompleted(_) => None,
            Self::Event(request) => request.tool_name.as_deref(),
        }
    }

    pub(crate) fn subject(&self) -> Option<&str> {
        match self {
            Self::Event(request) => request.subject.as_deref(),
            _ => None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookInput<'a> {
    protocol_version: u8,
    hook_id: &'a str,
    dir: &'a Path,
    event: HookInputEvent<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookInputEvent<'a> {
    name: ConfigHookEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<HookInputOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<&'a str>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookInputOutcome {
    Succeeded,
    Failed,
}

pub(crate) fn encode_input(
    hook: &HookConfig,
    invocation: &HookInvocation<'_>,
    dir: &Path,
) -> Result<Vec<u8>, CoreError> {
    let event = HookInputEvent {
        name: hook.event,
        session_id: match invocation {
            HookInvocation::Event(_) => invocation.session_id().map(|id| id.as_str()),
            _ => None,
        },
        thread_id: invocation.thread_id().map(|id| id.as_str()),
        turn_id: invocation.turn_id().map(|id| id.as_str()),
        tool_call_id: match invocation {
            HookInvocation::BeforeTool(request) => Some(request.tool_call_id.as_str()),
            HookInvocation::AfterTool(request) => Some(request.tool_call_id.as_str()),
            HookInvocation::TurnCompleted(_) | HookInvocation::Event(_) => None,
        },
        tool_name: invocation.tool_name(),
        outcome: match invocation {
            HookInvocation::AfterTool(request) => Some(match request.outcome {
                ToolExecutionOutcome::Succeeded => HookInputOutcome::Succeeded,
                ToolExecutionOutcome::Failed => HookInputOutcome::Failed,
            }),
            _ => None,
        },
        subject: invocation.subject(),
    };
    let bytes = serde_json::to_vec(&HookInput {
        protocol_version: HOOK_PROTOCOL_VERSION,
        hook_id: hook.id.as_str(),
        dir,
        event,
    })
    .map_err(|error| CoreError::Execution(format!("could not encode Hook input: {error}")))?;
    if bytes.len() > HOOK_INPUT_BYTES {
        return Err(CoreError::Execution(format!(
            "Hook '{}' input exceeds the {HOOK_INPUT_BYTES}-byte limit",
            hook.id
        )));
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
