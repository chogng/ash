use crate::ActionReviewRequest;
use crate::UnsandboxedGrant;

/// User-authorized exact actions that may run without platform sandbox enforcement.
///
/// Entries remain bound to an action digest, complete capability set, and policy revision.
/// Adding a tool name or command prefix is intentionally insufficient to authorize execution.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct UserAllowlist {
    grants: Vec<UnsandboxedGrant>,
}

impl UserAllowlist {
    pub fn new(grants: impl IntoIterator<Item = UnsandboxedGrant>) -> Self {
        Self {
            grants: grants.into_iter().collect(),
        }
    }

    pub fn extend(&mut self, grants: impl IntoIterator<Item = UnsandboxedGrant>) {
        self.grants.extend(grants);
    }

    pub(crate) fn matching_grant(
        &self,
        request: &ActionReviewRequest,
    ) -> Option<&UnsandboxedGrant> {
        self.grants.iter().find(|grant| {
            grant.matches(
                request.action().digest(),
                request.action().required_capabilities(),
                request.action_policy_revision(),
            )
        })
    }
}
