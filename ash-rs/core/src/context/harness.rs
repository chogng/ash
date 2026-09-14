use super::HarnessInstructions;
use crate::CoreError;
use ash_agent_environment::AgentEnvironmentSnapshot;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::path::PathBuf;
use std::sync::Arc;

/// Immutable host context captured for one model invocation.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HarnessContext {
    time_context: Option<ash_protocol::TimeContext>,
    instructions: HarnessInstructions,
    environment: Option<AgentEnvironmentSnapshot>,
}

impl HarnessContext {
    /// Starts a host-context snapshot with immutable instruction facts.
    pub fn new(instructions: HarnessInstructions) -> Self {
        Self {
            time_context: None,
            instructions,
            environment: None,
        }
    }

    /// Adds the environment facts visible to this model invocation.
    pub fn with_environment(mut self, environment: AgentEnvironmentSnapshot) -> Self {
        self.environment = Some(environment);
        self
    }

    /// Freezes the exact time snapshot for this request, independent of connection facts.
    pub fn with_time_context(mut self, context: Option<ash_protocol::TimeContext>) -> Self {
        self.time_context = context;
        self
    }

    pub fn time_context(&self) -> Option<&ash_protocol::TimeContext> {
        self.time_context.as_ref()
    }

    /// Returns the immutable system, user, and directory instructions.
    pub fn instructions(&self) -> &HarnessInstructions {
        &self.instructions
    }

    /// Returns the environment snapshot when the embedding host supplies one.
    pub fn environment(&self) -> Option<&AgentEnvironmentSnapshot> {
        self.environment.as_ref()
    }
}

/// Stable identities available when the host captures one harness-context snapshot.
pub struct HarnessContextRequest<'a> {
    /// Session whose runtime environment is being frozen.
    pub session_id: &'a SessionId,
    /// Thread about to invoke the model.
    pub thread_id: &'a ThreadId,
    /// Turn about to invoke the model.
    pub turn_id: &'a TurnId,
    /// Files confirmed by successful reads in this Turn's durable transcript.
    pub read_paths: &'a [PathBuf],
}

/// Supplies one immutable host-context snapshot at each model-invocation boundary.
///
/// Implementations collect host-owned instructions and environment facts. The returned value must
/// remain stable while Core plans and assembles that invocation.
pub trait HarnessContextProvider: Send + Sync {
    /// Validates host-owned context prerequisites before an unstarted tool call is reviewed.
    /// A rejection is returned to the model without executing the call.
    fn validate_tool_context(
        &self,
        _request: &HarnessContextRequest<'_>,
        _call: &ash_protocol::ToolCall,
    ) -> Result<(), CoreError> {
        Ok(())
    }

    fn snapshot(
        &self,
        request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError>;
}
