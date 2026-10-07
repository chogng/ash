//! Pure, deterministic rule evaluation for actions that may cross an execution boundary.
//!
//! This crate owns rule syntax, layer composition, semantic revisions, matching, and amendments.
//! It never executes an action, calls a reviewer, or creates an execution grant. The action-policy
//! authority consumes [`ExecPolicyEvaluation`] and remains responsible for the final decision.

mod amendment;
mod policy;
mod rule;
mod subject;

pub use amendment::ExecPolicyAmendment;
pub use amendment::ExecPolicyAmendmentError;
pub use policy::ExecPolicyError;
pub use policy::ExecPolicyEvaluation;
pub use policy::ExecPolicyMatchedRule;
pub use policy::ExecPolicyRevision;
pub use policy::ExecPolicySnapshot;
pub use policy::ExecPolicySource;
pub use rule::ExecPolicyDefault;
pub use rule::ExecPolicyEffect;
pub use rule::ExecPolicyLayer;
pub use rule::ExecPolicyLayerId;
pub use rule::ExecPolicyLayerKind;
pub use rule::ExecPolicyRule;
pub use rule::ExecPolicyRuleId;
pub use rule::ExecPolicySelector;
pub use rule::ExecPolicyToken;
pub use rule::HostMatcher;
pub use rule::ScopeMatcher;
pub use subject::ExecPolicyActionKind;
pub use subject::ExecPolicyCapability;
pub use subject::ExecPolicyCommand;
pub use subject::ExecPolicyNetworkTarget;
pub use subject::ExecPolicySubject;
