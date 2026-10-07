use crate::ContentPart;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// How a sandboxed process terminated before its captured output was returned.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", content = "code", rename_all = "camelCase")]
pub enum ProcessExitStatus {
    Code(i32),
    Terminated,
}

/// Provider-independent process result retained across executor and Core boundaries.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExecutionOutput {
    exit_status: ProcessExitStatus,
    stdout: String,
    stderr: String,
    aggregated_output: String,
}

impl ProcessExecutionOutput {
    pub fn from_captured_streams(
        exit_status: ProcessExitStatus,
        stdout: impl Into<String>,
        stderr: impl Into<String>,
    ) -> Self {
        let stdout = stdout.into();
        let stderr = stderr.into();
        let aggregated_output = format!("{stdout}{stderr}");
        Self {
            exit_status,
            stdout,
            stderr,
            aggregated_output,
        }
    }

    /// Replaces the stream concatenation with executor-captured chronological output.
    pub fn with_aggregated_output(mut self, aggregated_output: impl Into<String>) -> Self {
        self.aggregated_output = aggregated_output.into();
        self
    }

    pub fn exit_status(&self) -> ProcessExitStatus {
        self.exit_status
    }

    pub fn stdout(&self) -> &str {
        &self.stdout
    }

    pub fn stderr(&self) -> &str {
        &self.stderr
    }

    pub fn aggregated_output(&self) -> &str {
        &self.aggregated_output
    }
}

/// Whether Core may automatically execute the same exact Tool Call after sandbox review.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolReplaySafety {
    SafeToRetry,
    MayHaveSideEffects,
}

/// Trustworthy result of an execution attempt rejected by sandbox enforcement.
///
/// Producers must not use this for an ordinary non-zero exit. Captured streams must already be
/// bounded and secret-free before this value crosses the executor boundary.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDenialOutput {
    reason: String,
    output: ProcessExecutionOutput,
    replay_safety: ToolReplaySafety,
}

impl SandboxDenialOutput {
    pub fn safe_to_retry(reason: impl Into<String>, output: ProcessExecutionOutput) -> Self {
        Self {
            reason: reason.into(),
            output,
            replay_safety: ToolReplaySafety::SafeToRetry,
        }
    }

    pub fn may_have_side_effects(
        reason: impl Into<String>,
        output: ProcessExecutionOutput,
    ) -> Self {
        Self {
            reason: reason.into(),
            output,
            replay_safety: ToolReplaySafety::MayHaveSideEffects,
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn output(&self) -> &ProcessExecutionOutput {
        &self.output
    }

    pub fn replay_safety(&self) -> ToolReplaySafety {
        self.replay_safety
    }
}

/// The terminal or uncertain result returned from a Core-managed Tool execution attempt.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", content = "detail", rename_all = "camelCase")]
pub enum ToolExecutionOutput {
    Success(String),
    Failure(String),
    SuccessContent(Vec<ContentPart>),
    FailureContent(Vec<ContentPart>),
    SandboxDenied(SandboxDenialOutput),
    OutcomeUnknown(String),
}
