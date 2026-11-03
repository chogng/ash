use ash_tool_executor::CommandOutput;
use core_api::CoreError;
use serde::Deserialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HookDecision {
    Continue,
    Deny { reason: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "decision", deny_unknown_fields)]
enum HookOutput {
    Continue,
    Deny { reason: String },
}

pub(crate) fn parse_output(
    hook_id: &str,
    output: CommandOutput,
) -> Result<HookDecision, CoreError> {
    if output.exit_code != Some(0) {
        return Err(CoreError::Execution(format!(
            "Hook '{hook_id}' exited unsuccessfully"
        )));
    }
    if output.stdout_truncated || output.stderr_truncated {
        return Err(CoreError::Execution(format!(
            "Hook '{hook_id}' exceeded the output limit"
        )));
    }
    let stdout = output.stdout.trim();
    if stdout.is_empty() {
        return Ok(HookDecision::Continue);
    }
    let parsed = serde_json::from_str::<HookOutput>(stdout).map_err(|error| {
        CoreError::Execution(format!(
            "Hook '{hook_id}' returned invalid JSON output: {error}"
        ))
    })?;
    match parsed {
        HookOutput::Continue => Ok(HookDecision::Continue),
        HookOutput::Deny { reason } if !reason.trim().is_empty() => {
            Ok(HookDecision::Deny { reason })
        }
        HookOutput::Deny { .. } => Err(CoreError::Execution(format!(
            "Hook '{hook_id}' returned an empty denial reason"
        ))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeOutput {
    hook_specific_output: Option<ClaudePreToolUseOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudePreToolUseOutput {
    hook_event_name: ClaudeEvent,
    permission_decision: ClaudePermission,
    permission_decision_reason: Option<String>,
}

#[derive(Deserialize)]
enum ClaudeEvent {
    PreToolUse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ClaudePermission {
    Allow,
    Deny,
}

/// Claude decisions can veto a Tool but cannot supply Ash execution authority.
pub(crate) fn parse_claude_pre_tool_use(
    hook_id: &str,
    output: CommandOutput,
) -> Result<HookDecision, CoreError> {
    if output.stdout_truncated || output.stderr_truncated {
        return Err(CoreError::Execution(format!(
            "Hook '{hook_id}' exceeded the output limit"
        )));
    }
    let deny = |reason: &str| HookDecision::Deny {
        reason: if reason.trim().is_empty() {
            format!("Hook '{hook_id}' blocked this Tool")
        } else {
            reason.trim().to_owned()
        },
    };
    match output.exit_code {
        Some(2) => return Ok(deny(&output.stderr)),
        Some(0) => {}
        _ => {
            return Err(CoreError::Execution(format!(
                "Hook '{hook_id}' exited unsuccessfully"
            )));
        }
    }
    let stdout = output.stdout.trim();
    if stdout.is_empty() {
        return Ok(HookDecision::Continue);
    }
    let parsed: ClaudeOutput = serde_json::from_str(stdout).map_err(|_| {
        CoreError::Execution(format!(
            "Hook '{hook_id}' returned unsupported Claude PreToolUse output"
        ))
    })?;
    match parsed.hook_specific_output {
        Some(ClaudePreToolUseOutput {
            hook_event_name: ClaudeEvent::PreToolUse,
            permission_decision: ClaudePermission::Deny,
            permission_decision_reason,
        }) => Ok(deny(
            permission_decision_reason.as_deref().unwrap_or_default(),
        )),
        _ => Ok(HookDecision::Continue),
    }
}

#[cfg(test)]
#[path = "outcome_tests.rs"]
mod tests;
