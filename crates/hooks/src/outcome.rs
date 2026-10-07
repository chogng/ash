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

#[cfg(test)]
#[path = "outcome_tests.rs"]
mod tests;
