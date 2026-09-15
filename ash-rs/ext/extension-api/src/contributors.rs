use crate::ExtensionError;
use crate::PromptFragment;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use ash_tools::ToolExecutor;
use std::sync::Arc;

/// Immutable user input available while a new Turn's capability activations are resolved.
pub struct SkillActivationContext<'a> {
    session_id: Option<&'a SessionId>,
    user_input: &'a [UserInput],
}

impl<'a> SkillActivationContext<'a> {
    pub fn new(user_input: &'a [UserInput]) -> Self {
        Self {
            session_id: None,
            user_input,
        }
    }

    pub fn for_session(session_id: &'a SessionId, user_input: &'a [UserInput]) -> Self {
        Self {
            session_id: Some(session_id),
            user_input,
        }
    }

    pub fn session_id(&self) -> Option<&'a SessionId> {
        self.session_id
    }

    pub fn user_input(&self) -> &'a [UserInput] {
        self.user_input
    }
}

/// Resolves Skill selections into exact durable activations before Core accepts a new Turn.
///
/// Implementations must preserve user-visible selection order, enforce their own availability and
/// compatibility policy, and return content-bound activations. They must not mutate Thread state.
pub trait SkillActivationContributor: Send + Sync {
    fn contribute(
        &self,
        input: SkillActivationContext<'_>,
    ) -> Result<Vec<FrozenSkillActivation>, ExtensionError>;
}

/// Immutable facts exposed at one model-invocation safe point.
pub struct TurnInputContext<'a> {
    session_id: Option<&'a SessionId>,
    thread_id: &'a ThreadId,
    turn_id: &'a TurnId,
    activated_skills: &'a [FrozenSkillActivation],
}

impl<'a> TurnInputContext<'a> {
    pub fn new(
        thread_id: &'a ThreadId,
        turn_id: &'a TurnId,
        activated_skills: &'a [FrozenSkillActivation],
    ) -> Self {
        Self {
            session_id: None,
            thread_id,
            turn_id,
            activated_skills,
        }
    }

    pub fn for_session(
        session_id: &'a SessionId,
        thread_id: &'a ThreadId,
        turn_id: &'a TurnId,
        activated_skills: &'a [FrozenSkillActivation],
    ) -> Self {
        Self {
            session_id: Some(session_id),
            thread_id,
            turn_id,
            activated_skills,
        }
    }

    pub fn session_id(&self) -> Option<&'a SessionId> {
        self.session_id
    }

    pub fn thread_id(&self) -> &'a ThreadId {
        self.thread_id
    }

    pub fn turn_id(&self) -> &'a TurnId {
        self.turn_id
    }

    pub fn activated_skills(&self) -> &'a [FrozenSkillActivation] {
        self.activated_skills
    }
}

/// Contributes immutable prompt fragments for one model invocation.
///
/// Implementations own domain loading and policy. Core owns precedence, budgeting, and final model
/// request assembly after validating the returned fragment metadata.
pub trait TurnInputContributor: Send + Sync {
    fn contribute(
        &self,
        input: TurnInputContext<'_>,
    ) -> Result<Vec<PromptFragment>, ExtensionError>;
}

/// Contributes authority-free, read-only model tools from a shared agent extension.
///
/// Implementations may read immutable or internally synchronized extension-owned state, including
/// source roots that the extension validated before registration. They must not use ambient
/// filesystem authority, mutate external state, start processes, access the network or credentials,
/// or append durable Thread events. The installing host validates and routes these executors through
/// its normal tool policy boundary. Extensions that need broader authority must use a
/// capability-bearing host contract instead of this one.
pub trait ReadOnlyToolContributor: Send + Sync {
    fn contribute(&self) -> Result<Vec<Arc<dyn ToolExecutor>>, ExtensionError>;
}

/// Exact authority declared by a capability-bearing extension tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtensionToolAuthority {
    /// A reviewed remote mutation with writes restricted to an extension artifact directory.
    ExternalWrite {
        service: String,
        network_scopes: Vec<String>,
        credential_reference: Option<String>,
        artifact_root: String,
    },
    /// Writes only extension-owned state through a domain API that atomically enforces user consent.
    /// This never grants filesystem, process, credential, or network authority.
    ManagedStateWrite { resource: String },
    /// Sends read-only requests to explicit network scopes without mutating the remote service.
    ExternalRead {
        service: String,
        network_scopes: Vec<String>,
        credential_reference: Option<String>,
    },
}

/// One executable extension tool paired with the authority its host policy must review.
pub struct CapabilityToolContribution {
    executor: Arc<dyn ToolExecutor>,
    authority: ExtensionToolAuthority,
}

impl CapabilityToolContribution {
    pub fn new(executor: Arc<dyn ToolExecutor>, authority: ExtensionToolAuthority) -> Self {
        Self {
            executor,
            authority,
        }
    }

    pub fn executor(&self) -> &Arc<dyn ToolExecutor> {
        &self.executor
    }

    pub fn authority(&self) -> &ExtensionToolAuthority {
        &self.authority
    }

    pub fn into_parts(self) -> (Arc<dyn ToolExecutor>, ExtensionToolAuthority) {
        (self.executor, self.authority)
    }
}

/// Contributes tools that need host-reviewed external access or consent-checked domain writes.
///
/// Implementations must declare every owned or external scope before registration. The host freezes the
/// declaration with the Tool Call, asks policy for authority, and only then invokes the executor.
/// This contract does not itself grant network or credential access.
pub trait CapabilityToolContributor: Send + Sync {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError>;
}
