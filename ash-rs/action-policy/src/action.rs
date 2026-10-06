//! Materialized actions, sandbox execution context, and policy-specific identity and rule mappings.

use ash_execpolicy::ExecPolicyCommand;
use ash_execpolicy::ExecPolicyNetworkTarget;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionReviewPhase;
use ash_protocol::ActionSource;
use ash_protocol::CapabilityKind;
use ash_protocol::CapabilitySet;
use ash_protocol::ReviewContext;
use ash_protocol::SandboxDenialEvidence;
use ash_sandboxing::SandboxPolicy;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

pub(crate) fn capability_policy_name(value: &CapabilityKind) -> &'static str {
    match value {
        CapabilityKind::FileRead => "file_read",
        CapabilityKind::FileWrite => "file_write",
        CapabilityKind::ProcessSpawn => "process_spawn",
        CapabilityKind::Network => "network",
        CapabilityKind::CredentialUse => "credential_use",
        CapabilityKind::ExternalMutation => "external_mutation",
        CapabilityKind::SystemConfiguration => "system_configuration",
        CapabilityKind::UserInterface => "user_interface",
    }
}

pub(crate) fn action_policy_kind(value: &ActionKind) -> ash_execpolicy::ExecPolicyActionKind {
    match value {
        ActionKind::LocalProcess(_) => ash_execpolicy::ExecPolicyActionKind::LocalProcess,
        ActionKind::FileSystemMutation => ash_execpolicy::ExecPolicyActionKind::FileSystemMutation,
        ActionKind::NetworkRequest => ash_execpolicy::ExecPolicyActionKind::NetworkRequest,
        ActionKind::BrowserInteraction => ash_execpolicy::ExecPolicyActionKind::BrowserInteraction,
        ActionKind::ExternalServiceMutation => {
            ash_execpolicy::ExecPolicyActionKind::ExternalServiceMutation
        }
        ActionKind::CredentialUse => ash_execpolicy::ExecPolicyActionKind::CredentialUse,
        ActionKind::SystemOperation => ash_execpolicy::ExecPolicyActionKind::SystemOperation,
    }
}

pub(crate) fn action_source_policy_name(value: &ActionSource) -> &'static str {
    match value {
        ActionSource::BuiltInTool => "built_in_tool",
        ActionSource::Plugin => "plugin",
        ActionSource::McpServer => "mcp_server",
        ActionSource::DynamicTool => "dynamic_tool",
        ActionSource::User => "user",
    }
}

/// Derives the revision of the complete policy environment at a Turn safe point.
pub fn derive_action_policy_revision(
    exec_policy_revision: &ash_execpolicy::ExecPolicyRevision,
    grant_snapshot_revision: &str,
    reviewer_policy_revision: &str,
) -> ActionPolicyRevision {
    let mut digest = Sha256::new();
    digest.update(exec_policy_revision.as_str().as_bytes());
    digest.update([0]);
    digest.update(grant_snapshot_revision.as_bytes());
    digest.update([0]);
    digest.update(reviewer_policy_revision.as_bytes());
    ActionPolicyRevision::new(format!("{:x}", digest.finalize()))
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

    /// Replaces host execution constraints without changing the canonical action or its identity.
    /// The Turn owner uses this to restrict investigation commands in analysis modes.
    pub fn with_sandbox(mut self, sandbox: SandboxCompatibility) -> Self {
        self.sandbox = sandbox;
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
