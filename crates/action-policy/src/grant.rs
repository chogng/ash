use ash_protocol::ActionDigest;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::CapabilitySet;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GrantId(String);

impl GrantId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Explicit authority to execute one exact action without platform sandbox enforcement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnsandboxedGrant {
    id: GrantId,
    action_digest: ActionDigest,
    capabilities: CapabilitySet,
    action_policy_revision: ActionPolicyRevision,
}

impl UnsandboxedGrant {
    pub fn new(
        id: GrantId,
        action_digest: ActionDigest,
        capabilities: CapabilitySet,
        action_policy_revision: ActionPolicyRevision,
    ) -> Self {
        Self {
            id,
            action_digest,
            capabilities,
            action_policy_revision,
        }
    }

    pub fn id(&self) -> &GrantId {
        &self.id
    }

    pub fn matches(
        &self,
        action_digest: &ActionDigest,
        capabilities: &CapabilitySet,
        action_policy_revision: &ActionPolicyRevision,
    ) -> bool {
        self.action_digest == *action_digest
            && self.capabilities == *capabilities
            && self.action_policy_revision == *action_policy_revision
    }
}
