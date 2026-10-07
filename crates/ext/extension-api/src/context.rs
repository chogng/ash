use crate::ExtensionError;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use async_utils::CancellationToken;

/// One bounded, revision-bound piece of untrusted evidence supplied to model context.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextEvidence {
    pub source: String,
    pub reference: String,
    pub revision: String,
    pub body: String,
}

/// Stable identities and user query for one optional context-source lookup.
pub struct ContextSourceRequest<'a> {
    pub session_id: &'a SessionId,
    pub thread_id: &'a ThreadId,
    pub turn_id: &'a TurnId,
    pub query: &'a str,
}

/// Supplies bounded, ephemeral evidence at the first model invocation of a Turn.
///
/// Implementations own domain reads and consent checks. The host supplies trusted task identities;
/// Core owns budgeting and places evidence in untrusted user context, never instructions or history.
/// Each preparation attempt recollects evidence so revocation and deletion remain visible.
pub trait ContextContributor: Send + Sync {
    fn collect(
        &self,
        request: &ContextSourceRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ContextEvidence>, ExtensionError>;
}
