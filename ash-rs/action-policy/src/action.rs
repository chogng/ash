use crate::ReviewContext;
use ash_execpolicy::ExecPolicyCommand;
use ash_execpolicy::ExecPolicyNetworkTarget;
use ash_sandboxing::SandboxPolicy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    FileRead,
    FileWrite,
    ProcessSpawn,
    Network,
    CredentialUse,
    ExternalMutation,
    SystemConfiguration,
    UserInterface,
}

impl CapabilityKind {
    pub(crate) fn execpolicy_name(&self) -> &'static str {
        match self {
            Self::FileRead => "file_read",
            Self::FileWrite => "file_write",
            Self::ProcessSpawn => "process_spawn",
            Self::Network => "network",
            Self::CredentialUse => "credential_use",
            Self::ExternalMutation => "external_mutation",
            Self::SystemConfiguration => "system_configuration",
            Self::UserInterface => "user_interface",
        }
    }
}

/// One scoped authority needed by a resolved action.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Capability {
    kind: CapabilityKind,
    scope: String,
}

impl Capability {
    pub fn new(kind: CapabilityKind, scope: impl Into<String>) -> Self {
        Self {
            kind,
            scope: scope.into(),
        }
    }

    pub fn kind(&self) -> &CapabilityKind {
        &self.kind
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }
}

/// Canonically ordered capabilities used for exact grant and recommendation comparisons.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CapabilitySet(BTreeSet<Capability>);

impl CapabilitySet {
    pub fn new(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        Self(capabilities.into_iter().collect())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn is_subset(&self, other: &Self) -> bool {
        self.0.is_subset(&other.0)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Capability> {
        self.0.iter()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessInvocationKind {
    Direct,
    Shell,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ActionKind {
    LocalProcess(ProcessInvocationKind),
    FileSystemMutation,
    NetworkRequest,
    BrowserInteraction,
    ExternalServiceMutation,
    CredentialUse,
    SystemOperation,
}

impl ActionKind {
    pub(crate) fn execpolicy_kind(&self) -> ash_execpolicy::ExecPolicyActionKind {
        match self {
            Self::LocalProcess(_) => ash_execpolicy::ExecPolicyActionKind::LocalProcess,
            Self::FileSystemMutation => ash_execpolicy::ExecPolicyActionKind::FileSystemMutation,
            Self::NetworkRequest => ash_execpolicy::ExecPolicyActionKind::NetworkRequest,
            Self::BrowserInteraction => ash_execpolicy::ExecPolicyActionKind::BrowserInteraction,
            Self::ExternalServiceMutation => {
                ash_execpolicy::ExecPolicyActionKind::ExternalServiceMutation
            }
            Self::CredentialUse => ash_execpolicy::ExecPolicyActionKind::CredentialUse,
            Self::SystemOperation => ash_execpolicy::ExecPolicyActionKind::SystemOperation,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSource {
    BuiltInTool,
    Plugin,
    McpServer,
    DynamicTool,
    User,
}

impl ActionSource {
    pub(crate) fn execpolicy_name(&self) -> &'static str {
        match self {
            Self::BuiltInTool => "built_in_tool",
            Self::Plugin => "plugin",
            Self::McpServer => "mcp_server",
            Self::DynamicTool => "dynamic_tool",
            Self::User => "user",
        }
    }
}

/// Trusted provenance assigned by the host after resolving the exact tool binding.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ActionProvenance {
    source: ActionSource,
    source_id: String,
}

impl ActionProvenance {
    pub fn new(source: ActionSource, source_id: impl Into<String>) -> Self {
        Self {
            source,
            source_id: source_id.into(),
        }
    }

    pub fn source(&self) -> &ActionSource {
        &self.source
    }

    pub fn source_id(&self) -> &str {
        &self.source_id
    }
}

/// SHA-256 identity of the host-canonical action, including all security-relevant fields.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ActionDigest(String);

impl ActionDigest {
    pub fn from_canonical_bytes(bytes: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(bytes.as_ref());
        Self(format!("{digest:x}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ActionDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Revision of the complete action-policy environment used for one review.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ActionPolicyRevision(String);

impl ActionPolicyRevision {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Derives a stable aggregate revision from all immutable policy inputs at a Turn safe point.
    pub fn from_components(
        exec_policy_revision: &ash_execpolicy::ExecPolicyRevision,
        grant_snapshot_revision: &str,
        reviewer_policy_revision: &str,
    ) -> Self {
        let mut digest = Sha256::new();
        digest.update(exec_policy_revision.as_str().as_bytes());
        digest.update([0]);
        digest.update(grant_snapshot_revision.as_bytes());
        digest.update([0]);
        digest.update(reviewer_policy_revision.as_bytes());
        Self(format!("{:x}", digest.finalize()))
    }
}

/// A fully materialized action safe to summarize for review.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ResolvedAction {
    digest: ActionDigest,
    kind: ActionKind,
    summary: String,
    required_capabilities: CapabilitySet,
    command: Option<ExecPolicyCommand>,
    network_target: Option<ExecPolicyNetworkTarget>,
}

impl ResolvedAction {
    pub fn new(
        digest: ActionDigest,
        kind: ActionKind,
        summary: impl Into<String>,
        required_capabilities: CapabilitySet,
    ) -> Self {
        Self {
            digest,
            kind,
            summary: summary.into(),
            required_capabilities,
            command: None,
            network_target: None,
        }
    }

    /// Attaches the exact tokenized process invocation used by command-prefix policy selectors.
    pub fn with_command(
        mut self,
        program: impl Into<String>,
        arguments: impl IntoIterator<Item = String>,
    ) -> Self {
        self.command = Some(ExecPolicyCommand::new(program, arguments));
        self
    }

    /// Attaches the normalized destination used by network policy selectors.
    pub fn with_network_target(
        mut self,
        protocol: impl Into<String>,
        host: impl Into<String>,
        port: Option<u16>,
    ) -> Self {
        self.network_target = Some(ExecPolicyNetworkTarget::new(protocol, host, port));
        self
    }

    pub fn digest(&self) -> &ActionDigest {
        &self.digest
    }

    pub fn kind(&self) -> &ActionKind {
        &self.kind
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn required_capabilities(&self) -> &CapabilitySet {
        &self.required_capabilities
    }

    pub(crate) fn command(&self) -> Option<&ExecPolicyCommand> {
        self.command.as_ref()
    }

    pub(crate) fn network_target(&self) -> Option<&ExecPolicyNetworkTarget> {
        self.network_target.as_ref()
    }
}

/// Whether the platform sandbox can enforce the action's requested authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxCompatibility {
    Supported(SandboxPolicy),
    Unsupported { reason: String },
    NotApplicable { reason: String },
}

/// Bounded evidence from a completed sandbox attempt that was denied by enforcement.
///
/// The host is expected to retain only the output needed for review, remove secrets, and create
/// this value only after distinguishing sandbox enforcement from an ordinary command failure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SandboxDenialEvidence {
    reason: String,
    output: String,
}

impl SandboxDenialEvidence {
    pub fn new(reason: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            output: output.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn output(&self) -> &str {
        &self.output
    }
}

/// Identifies whether review happens before execution or after a confirmed sandbox denial.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ActionReviewPhase {
    Initial,
    SandboxDenial(SandboxDenialEvidence),
}

/// Complete, immutable input to deterministic policy and optional classifier review.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionReviewRequest {
    action: ResolvedAction,
    provenance: ActionProvenance,
    sandbox: SandboxCompatibility,
    action_policy_revision: ActionPolicyRevision,
    context: ReviewContext,
    phase: ActionReviewPhase,
}

impl ActionReviewRequest {
    pub fn new(
        action: ResolvedAction,
        provenance: ActionProvenance,
        sandbox: SandboxCompatibility,
        action_policy_revision: ActionPolicyRevision,
    ) -> Self {
        Self {
            action,
            provenance,
            sandbox,
            action_policy_revision,
            context: ReviewContext::default(),
            phase: ActionReviewPhase::Initial,
        }
    }

    /// Attaches a compact, secret-free context snapshot for the advisory reviewer.
    pub fn with_context(mut self, context: ReviewContext) -> Self {
        self.context = context;
        self
    }

    /// Converts an initial request into a second review of the same exact action.
    ///
    /// Callers must invoke this only after a trustworthy sandbox denial result. The action,
    /// provenance, sandbox policy, context, and policy revision remain unchanged.
    pub fn after_sandbox_denial(mut self, denial: SandboxDenialEvidence) -> Self {
        self.phase = ActionReviewPhase::SandboxDenial(denial);
        self
    }

    pub fn action(&self) -> &ResolvedAction {
        &self.action
    }

    pub fn provenance(&self) -> &ActionProvenance {
        &self.provenance
    }

    pub fn sandbox(&self) -> &SandboxCompatibility {
        &self.sandbox
    }

    pub fn action_policy_revision(&self) -> &ActionPolicyRevision {
        &self.action_policy_revision
    }

    pub fn context(&self) -> &ReviewContext {
        &self.context
    }

    pub fn phase(&self) -> &ActionReviewPhase {
        &self.phase
    }
}
