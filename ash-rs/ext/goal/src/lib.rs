//! Goal tools, prompt contribution, and durable continuation admission.
mod prompt;
mod runtime;
mod tool;
pub use tool::CREATE_GOAL_TOOL_NAME;
pub use tool::GET_GOAL_TOOL_NAME;
pub use tool::GoalToolService;
pub use tool::UPDATE_GOAL_TOOL_NAME;

use extension_api::ExtensionError;
use extension_api::PromptFragment;
use extension_api::PromptFragmentLayer;
use extension_api::PromptFragmentRetention;
use extension_api::PromptFragmentSource;
use extension_api::TurnInputContext;
use extension_api::TurnInputContributor;
use std::sync::Arc;

/// Installs Goal behavior without transferring Thread persistence or execution ownership.
pub fn install(
    builder: &mut extension_api::ExtensionRegistryBuilder,
    threads: &Arc<ash_core::ThreadController>,
) {
    let extension = Arc::new(runtime::GoalExtension::new(threads));
    builder
        .continuation_contributor("goal", extension.clone())
        .turn_input_contributor("goal", extension);
}

impl TurnInputContributor for runtime::GoalExtension {
    fn contribute(
        &self,
        input: TurnInputContext<'_>,
    ) -> Result<Vec<PromptFragment>, ExtensionError> {
        let threads = self
            .threads()
            .map_err(|error| ExtensionError::new(error.to_string()))?;
        let snapshot = threads
            .read_thread(input.thread_id())
            .map_err(|error| ExtensionError::new(error.to_string()))?;
        if input.session_id() != Some(&snapshot.session_id) {
            return Err(ExtensionError::new("Goal Session does not own this Thread"));
        }
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == input.turn_id())
            .ok_or_else(|| ExtensionError::new("Goal Turn is missing"))?;
        let Some(goal) = snapshot.goal.as_ref().filter(|goal| {
            goal.status.is_active()
                && turn.kind != protocol::TurnKind::Review
                && !matches!(
                    turn.mode,
                    protocol::CollaborationMode::Plan | protocol::CollaborationMode::Ask
                )
        }) else {
            return Ok(Vec::new());
        };
        let prompt =
            prompt::render_goal_instructions(&goal.objective, goal.token_budget, goal.tokens_used)
                .map_err(|error| ExtensionError::new(error.to_string()))?;
        Ok(vec![PromptFragment::new(
            PromptFragmentSource::new(
                prompt.source().owner(),
                prompt.source().id(),
                prompt.source().revision(),
            ),
            PromptFragmentLayer::Product,
            PromptFragmentRetention::Required,
            prompt.body(),
        )])
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
