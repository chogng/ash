use ash_config::HookConfig;
use ash_config::HookEvent as ConfigHookEvent;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookRequest;
use core_api::CoreError;
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
}

impl HookInvocation<'_> {
    pub(crate) fn session_id(&self) -> &ash_protocol::SessionId {
        match self {
            Self::BeforeTool(request) => &request.session_id,
            Self::AfterTool(request) => &request.session_id,
            Self::TurnCompleted(request) => &request.session_id,
        }
    }

    pub(crate) fn thread_id(&self) -> &ash_protocol::ThreadId {
        match self {
            Self::BeforeTool(request) => &request.thread_id,
            Self::AfterTool(request) => &request.thread_id,
            Self::TurnCompleted(request) => &request.thread_id,
        }
    }

    pub(crate) fn turn_id(&self) -> &ash_protocol::TurnId {
        match self {
            Self::BeforeTool(request) => &request.turn_id,
            Self::AfterTool(request) => &request.turn_id,
            Self::TurnCompleted(request) => &request.turn_id,
        }
    }

    pub(crate) fn config_event(&self) -> ConfigHookEvent {
        match self {
            Self::BeforeTool(_) => ConfigHookEvent::BeforeTool,
            Self::AfterTool(_) => ConfigHookEvent::AfterTool,
            Self::TurnCompleted(_) => ConfigHookEvent::TurnCompleted,
        }
    }

    pub(crate) fn tool_name(&self) -> Option<&str> {
        match self {
            Self::BeforeTool(request) => Some(&request.tool_name),
            Self::AfterTool(request) => Some(&request.tool_name),
            Self::TurnCompleted(_) => None,
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
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "name"
)]
enum HookInputEvent<'a> {
    BeforeTool {
        thread_id: &'a str,
        turn_id: &'a str,
        tool_call_id: &'a str,
        tool_name: &'a str,
    },
    AfterTool {
        thread_id: &'a str,
        turn_id: &'a str,
        tool_call_id: &'a str,
        tool_name: &'a str,
        outcome: HookInputOutcome,
    },
    TurnCompleted {
        thread_id: &'a str,
        turn_id: &'a str,
    },
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
    let event = match invocation {
        HookInvocation::BeforeTool(request) => HookInputEvent::BeforeTool {
            thread_id: request.thread_id.as_str(),
            turn_id: request.turn_id.as_str(),
            tool_call_id: request.tool_call_id.as_str(),
            tool_name: &request.tool_name,
        },
        HookInvocation::AfterTool(request) => HookInputEvent::AfterTool {
            thread_id: request.thread_id.as_str(),
            turn_id: request.turn_id.as_str(),
            tool_call_id: request.tool_call_id.as_str(),
            tool_name: &request.tool_name,
            outcome: match request.outcome {
                ToolExecutionOutcome::Succeeded => HookInputOutcome::Succeeded,
                ToolExecutionOutcome::Failed => HookInputOutcome::Failed,
            },
        },
        HookInvocation::TurnCompleted(request) => HookInputEvent::TurnCompleted {
            thread_id: request.thread_id.as_str(),
            turn_id: request.turn_id.as_str(),
        },
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
