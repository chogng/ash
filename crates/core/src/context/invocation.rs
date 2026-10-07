use super::CompactionPlan;
use super::ContextPlan;
use crate::ModelSelection;
use ash_protocol::ModelRef;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;

/// Turn-owned model selection frozen for one invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FrozenModelSelection {
    ConfiguredDefault,
    Selected(ModelRef),
}

impl FrozenModelSelection {
    pub(crate) fn as_service_selection(&self) -> ModelSelection<'_> {
        match self {
            Self::ConfiguredDefault => ModelSelection::ConfiguredDefault,
            Self::Selected(model) => ModelSelection::Session(model),
        }
    }
}

/// Complete immutable Core snapshot consumed by one provider invocation.
#[derive(Clone, Debug)]
pub(crate) struct ModelInvocationSnapshot {
    session_id: SessionId,
    thread_id: ThreadId,
    turn_id: TurnId,
    model: FrozenModelSelection,
    context: ContextPlan,
}

#[derive(Clone, Debug)]
pub(crate) enum ModelInvocationPreparation {
    Ready(ModelInvocationSnapshot),
    NeedsCompaction {
        model: FrozenModelSelection,
        plan: CompactionPlan,
    },
}

#[derive(Clone, Debug)]
pub(crate) enum ContextOverflowRecoveryPreparation {
    AlreadyAttempted,
    Unavailable,
    NeedsCompaction {
        model: FrozenModelSelection,
        plan: CompactionPlan,
    },
}

#[derive(Clone, Debug)]
pub(crate) enum ManualContextCompactionPreparation {
    Complete,
    NeedsCompaction {
        model: FrozenModelSelection,
        retention_prompt: Option<String>,
        plan: CompactionPlan,
    },
}

impl ModelInvocationSnapshot {
    pub(crate) fn new(
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        model: FrozenModelSelection,
        context: ContextPlan,
    ) -> Self {
        Self {
            session_id,
            thread_id,
            turn_id,
            model,
            context,
        }
    }

    pub(crate) fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub(crate) fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }

    pub(crate) fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }

    pub(crate) fn model(&self) -> &FrozenModelSelection {
        &self.model
    }

    pub(crate) fn context(&self) -> &ContextPlan {
        &self.context
    }
}
