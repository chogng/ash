use ash_tool_executor::ExecutionError;

pub(crate) fn hook_execution_error(error: ExecutionError) -> String {
    match error {
        ExecutionError::Network(_) => "Hook network preparation failed".into(),
        ExecutionError::ApprovalRequired => "Hook execution unexpectedly required approval".into(),
        ExecutionError::Denied => "Hook execution was denied".into(),
        ExecutionError::Spawn(_) => "Hook process could not be started".into(),
        ExecutionError::CancelledBeforeStart(reason) => {
            format!("Hook was cancelled before process start: {reason}")
        }
        ExecutionError::CancelledAfterStart(reason) => {
            format!("Hook was cancelled after process start: {reason}")
        }
        ExecutionError::TimedOut => "Hook process timed out".into(),
        ExecutionError::Sandbox(_) => "Hook sandbox preparation failed".into(),
    }
}
