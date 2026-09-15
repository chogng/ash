use crate::CapabilityToolContribution;
use crate::CapabilityToolContributor;
use crate::ContextContributor;
use crate::ContextEvidence;
use crate::ContextSourceRequest;
use crate::IdleContributor;
use crate::ItemContributor;
use crate::LifecycleObserver;
use crate::PromptFragment;
use crate::ReadOnlyToolContributor;
use crate::SkillActivationContext;
use crate::SkillActivationContributor;
use crate::ThreadContext;
use crate::ThreadLifecycle;
use crate::TurnInputContext;
use crate::TurnInputContributor;
use ash_protocol::FrozenSkillActivation;
use ash_tools::ToolExecutor;
use async_utils::CancellationToken;
use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionError(String);

impl ExtensionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ExtensionError {}

#[derive(Default)]
pub struct ExtensionRegistryBuilder {
    reviewer: Option<Arc<dyn crate::ApprovalReviewContributor>>,
    tool_lifecycle: Vec<(&'static str, Arc<dyn crate::ToolLifecycleContributor>)>,
    mcp_lifecycle: Vec<(&'static str, Arc<dyn crate::McpLifecycleContributor>)>,
    state: Arc<crate::ExtensionState>,
    continuations: Vec<(&'static str, Arc<dyn crate::ContinuationContributor>)>,
    lifecycle: Vec<(&'static str, Arc<dyn LifecycleObserver>)>,
    idle: Vec<(&'static str, Arc<dyn IdleContributor>)>,
    items: Vec<(&'static str, Arc<dyn ItemContributor>)>,
    capability_tools: Vec<(&'static str, Arc<dyn CapabilityToolContributor>)>,
    read_only_tools: Vec<(&'static str, Arc<dyn ReadOnlyToolContributor>)>,
    context: Vec<(&'static str, Arc<dyn ContextContributor>)>,
    skill_activation: Vec<Arc<dyn SkillActivationContributor>>,
    turn_input: Vec<(&'static str, Arc<dyn TurnInputContributor>)>,
}

impl ExtensionRegistryBuilder {
    pub fn approval_reviewer(
        &mut self,
        reviewer: Arc<dyn crate::ApprovalReviewContributor>,
    ) -> &mut Self {
        self.reviewer = Some(reviewer);
        self
    }
    pub fn tool_lifecycle_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn crate::ToolLifecycleContributor>,
    ) -> &mut Self {
        register(&mut self.tool_lifecycle, name, contributor);
        self
    }
    pub fn mcp_lifecycle_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn crate::McpLifecycleContributor>,
    ) -> &mut Self {
        register(&mut self.mcp_lifecycle, name, contributor);
        self
    }

    pub fn state(&self) -> Arc<crate::ExtensionState> {
        self.state.clone()
    }

    pub fn from_registry(registry: &ExtensionRegistry) -> Self {
        Self {
            reviewer: registry.reviewer.clone(),
            tool_lifecycle: registry.tool_lifecycle.clone(),
            mcp_lifecycle: registry.mcp_lifecycle.clone(),
            state: registry.state.clone(),
            continuations: registry.continuations.clone(),
            lifecycle: registry.lifecycle.clone(),
            idle: registry.idle.clone(),
            items: registry.items.clone(),
            capability_tools: registry.capability_tools.clone(),
            read_only_tools: registry.read_only_tools.clone(),
            context: registry.context.clone(),
            skill_activation: registry.skill_activation.clone(),
            turn_input: registry.turn_input.clone(),
        }
    }
    pub fn lifecycle_observer(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn LifecycleObserver>,
    ) -> &mut Self {
        register(&mut self.lifecycle, name, contributor);
        self
    }
    pub fn idle_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn IdleContributor>,
    ) -> &mut Self {
        register(&mut self.idle, name, contributor);
        self
    }
    pub fn item_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn ItemContributor>,
    ) -> &mut Self {
        register(&mut self.items, name, contributor);
        self
    }

    pub fn continuation_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn crate::ContinuationContributor>,
    ) -> &mut Self {
        register(&mut self.continuations, name, contributor);
        self
    }

    pub fn new() -> Self {
        Self::default()
    }

    pub fn skill_activation_contributor(
        &mut self,
        contributor: Arc<dyn SkillActivationContributor>,
    ) -> &mut Self {
        self.skill_activation.push(contributor);
        self
    }

    /// Installs or replaces one extension's read-only tools in its existing registration position.
    pub fn read_only_tool_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn ReadOnlyToolContributor>,
    ) -> &mut Self {
        if let Some((_, current)) = self.read_only_tools.iter_mut().find(|(id, _)| *id == name) {
            *current = contributor;
        } else {
            self.read_only_tools.push((name, contributor));
        }
        self
    }

    /// Installs or replaces one extension's evidence source without changing registration order.
    pub fn context_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn ContextContributor>,
    ) -> &mut Self {
        if let Some((_, current)) = self.context.iter_mut().find(|(id, _)| *id == name) {
            *current = contributor;
        } else {
            self.context.push((name, contributor));
        }
        self
    }

    pub fn capability_tool_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn CapabilityToolContributor>,
    ) -> &mut Self {
        if let Some((_, current)) = self.capability_tools.iter_mut().find(|(id, _)| *id == name) {
            *current = contributor;
        } else {
            self.capability_tools.push((name, contributor));
        }
        self
    }

    /// Installs or replaces one extension's invocation instructions in registration order.
    pub fn turn_input_contributor(
        &mut self,
        name: &'static str,
        contributor: Arc<dyn TurnInputContributor>,
    ) -> &mut Self {
        if let Some((_, current)) = self.turn_input.iter_mut().find(|(id, _)| *id == name) {
            *current = contributor;
        } else {
            self.turn_input.push((name, contributor));
        }
        self
    }

    pub fn build(self) -> ExtensionRegistry {
        ExtensionRegistry {
            reviewer: self.reviewer,
            tool_lifecycle: self.tool_lifecycle,
            mcp_lifecycle: self.mcp_lifecycle,
            state: self.state,
            continuations: self.continuations,
            lifecycle: self.lifecycle,
            idle: self.idle,
            items: self.items,
            capability_tools: self.capability_tools,
            read_only_tools: self.read_only_tools,
            context: self.context,
            skill_activation: self.skill_activation,
            turn_input: self.turn_input,
        }
    }
}

#[derive(Default)]
pub struct ExtensionRegistry {
    reviewer: Option<Arc<dyn crate::ApprovalReviewContributor>>,
    tool_lifecycle: Vec<(&'static str, Arc<dyn crate::ToolLifecycleContributor>)>,
    mcp_lifecycle: Vec<(&'static str, Arc<dyn crate::McpLifecycleContributor>)>,
    state: Arc<crate::ExtensionState>,
    continuations: Vec<(&'static str, Arc<dyn crate::ContinuationContributor>)>,
    lifecycle: Vec<(&'static str, Arc<dyn LifecycleObserver>)>,
    idle: Vec<(&'static str, Arc<dyn IdleContributor>)>,
    items: Vec<(&'static str, Arc<dyn ItemContributor>)>,
    capability_tools: Vec<(&'static str, Arc<dyn CapabilityToolContributor>)>,
    read_only_tools: Vec<(&'static str, Arc<dyn ReadOnlyToolContributor>)>,
    context: Vec<(&'static str, Arc<dyn ContextContributor>)>,
    skill_activation: Vec<Arc<dyn SkillActivationContributor>>,
    turn_input: Vec<(&'static str, Arc<dyn TurnInputContributor>)>,
}

impl ExtensionRegistry {
    pub fn review(
        &self,
        request: &ash_action_policy::ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_action_policy::ClassifierAssessment, ExtensionError> {
        cancellation
            .check()
            .map_err(|error| ExtensionError::new(error.reason().to_string()))?;
        let assessment = self
            .reviewer
            .as_ref()
            .ok_or_else(|| ExtensionError::new("no approval reviewer installed"))?
            .review(request, cancellation)?;
        cancellation
            .check()
            .map_err(|error| ExtensionError::new(error.reason().to_string()))?;
        Ok(assessment)
    }
    pub fn tool_changed(
        &self,
        context: ThreadContext<'_>,
        turn: &ash_protocol::TurnId,
        event: &crate::ToolLifecycle,
    ) {
        for (_, contributor) in &self.tool_lifecycle {
            contributor.tool_changed(context, turn, event);
        }
    }
    pub fn mcp_changed(&self, event: &crate::McpLifecycle) {
        for (_, contributor) in &self.mcp_lifecycle {
            contributor.catalog_changed(event);
        }
    }

    pub fn state(&self) -> &Arc<crate::ExtensionState> {
        &self.state
    }

    pub fn next_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        completed: &ash_protocol::TurnId,
    ) -> Result<Option<crate::ExtensionTurn>, ExtensionError> {
        for (_, contributor) in &self.continuations {
            if let Some(turn) = contributor.next_turn(thread, completed)? {
                return Ok(Some(turn));
            }
        }
        Ok(None)
    }

    pub fn recover_turns(
        &self,
        sessions: &BTreeSet<ash_protocol::SessionId>,
    ) -> Result<Vec<crate::ExtensionTurn>, ExtensionError> {
        let mut turns = Vec::new();
        let mut seen = BTreeSet::new();
        for (_, contributor) in &self.continuations {
            for turn in contributor.recover(sessions)? {
                if seen.insert((turn.thread_id.clone(), turn.turn_id.clone())) {
                    turns.push(turn);
                }
            }
        }
        Ok(turns)
    }

    pub fn collect_context(
        &self,
        request: &ContextSourceRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ContextEvidence>, ExtensionError> {
        let mut evidence = Vec::new();
        for (_, contributor) in &self.context {
            cancellation
                .check()
                .map_err(|signal| ExtensionError::new(signal.reason().to_string()))?;
            evidence.extend(contributor.collect(request, cancellation)?);
        }
        cancellation
            .check()
            .map_err(|signal| ExtensionError::new(signal.reason().to_string()))?;
        Ok(evidence)
    }

    pub fn thread_changed(&self, context: ThreadContext<'_>, event: &ThreadLifecycle) {
        match event {
            ThreadLifecycle::Archived => self.state.remove(&crate::ExtensionScope::Thread(
                context.session_id.clone(),
                context.thread_id.clone(),
            )),
            ThreadLifecycle::TurnCompleted(turn)
            | ThreadLifecycle::TurnFailed(turn)
            | ThreadLifecycle::TurnInterrupted(turn) => {
                self.state.remove(&crate::ExtensionScope::Turn(
                    context.session_id.clone(),
                    context.thread_id.clone(),
                    turn.clone(),
                ))
            }
            _ => {}
        }

        for (_, observer) in &self.lifecycle {
            observer.thread_changed(context, event);
        }
        if matches!(
            event,
            ThreadLifecycle::TurnCompleted(_)
                | ThreadLifecycle::TurnFailed(_)
                | ThreadLifecycle::TurnInterrupted(_)
        ) {
            for (_, contributor) in &self.idle {
                contributor.contribute(context);
            }
        }
    }
    pub fn config_changed(&self, generation: u64) {
        for (_, observer) in &self.lifecycle {
            observer.config_changed(generation);
        }
    }
    pub fn contribute_items(
        &self,
        context: ThreadContext<'_>,
    ) -> Result<Vec<extension_items::ExtensionItem>, ExtensionError> {
        let mut items = Vec::new();
        let mut identities = BTreeSet::new();
        for (_, contributor) in &self.items {
            let contributed = contributor.contribute(context)?;
            if items.len() + contributed.len() > 128 {
                return Err(ExtensionError::new("too many extension items"));
            }
            for item in contributed {
                item.validate().map_err(ExtensionError::new)?;
                if !identities.insert((item.extension.clone(), item.id.clone())) {
                    return Err(ExtensionError::new("duplicate extension item identity"));
                }
                items.push(item);
            }
        }
        Ok(items)
    }

    pub fn contribute_capability_tools(
        &self,
    ) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        let mut tools = Vec::new();
        let mut names = BTreeSet::new();
        for (_, contributor) in &self.capability_tools {
            for contribution in contributor.contribute()? {
                let definition = contribution.executor().definition();
                if !names.insert(definition.name().clone()) {
                    return Err(ExtensionError::new(format!(
                        "multiple extensions contributed capability tool '{}'",
                        definition.name()
                    )));
                }
                tools.push(contribution);
            }
        }
        Ok(tools)
    }

    pub fn contribute_read_only_tools(&self) -> Result<Vec<Arc<dyn ToolExecutor>>, ExtensionError> {
        let mut tools = Vec::new();
        let mut names = BTreeSet::new();
        for (_, contributor) in &self.read_only_tools {
            for executor in contributor.contribute()? {
                let definition = executor.definition();
                if !names.insert(definition.name().clone()) {
                    return Err(ExtensionError::new(format!(
                        "multiple extensions contributed read-only tool '{}'",
                        definition.name()
                    )));
                }
                tools.push(executor);
            }
        }
        Ok(tools)
    }

    pub fn contribute_skill_activations(
        &self,
        input: SkillActivationContext<'_>,
    ) -> Result<Vec<FrozenSkillActivation>, ExtensionError> {
        let mut activations = Vec::new();
        let mut identities = BTreeSet::new();
        for contributor in &self.skill_activation {
            for activation in contributor.contribute(match input.session_id() {
                Some(session_id) => {
                    SkillActivationContext::for_session(session_id, input.user_input())
                }
                None => SkillActivationContext::new(input.user_input()),
            })? {
                if !identities.insert(activation.id.clone()) {
                    return Err(ExtensionError::new(format!(
                        "multiple extensions activated Skill '{}:{}'",
                        activation.id.source, activation.id.name
                    )));
                }
                activations.push(activation);
            }
        }
        Ok(activations)
    }

    pub fn contribute_turn_input(
        &self,
        input: TurnInputContext<'_>,
    ) -> Result<Vec<PromptFragment>, ExtensionError> {
        let mut fragments = Vec::new();
        for (_, contributor) in &self.turn_input {
            fragments.extend(contributor.contribute(match input.session_id() {
                Some(session_id) => TurnInputContext::for_session(
                    session_id,
                    input.thread_id(),
                    input.turn_id(),
                    input.activated_skills(),
                ),
                None => TurnInputContext::new(
                    input.thread_id(),
                    input.turn_id(),
                    input.activated_skills(),
                ),
            })?);
        }
        Ok(fragments)
    }
}

fn register<T: ?Sized>(
    entries: &mut Vec<(&'static str, Arc<T>)>,
    name: &'static str,
    contributor: Arc<T>,
) {
    if let Some((_, current)) = entries.iter_mut().find(|(id, _)| *id == name) {
        *current = contributor;
    } else {
        entries.push((name, contributor));
    }
}
