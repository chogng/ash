use super::executor::TurnExecutor;
use crate::CoreError;
use crate::HarnessContextRequest;
use crate::HarnessContextScope;
use crate::ModelSelection;
use crate::context::CONTEXT_ESTIMATOR_REVISION;
use crate::context::ContextInput;
use crate::context::ContextPlanner;
use crate::context::ResolvedContextBudget;
use crate::context::calibrated_budget;
use ash_protocol::ModelContextAllocation;
use ash_protocol::ModelContextInspection;
use core_api::ContextInspection;
use core_api::ContextInspectionRequest;
use core_api::ContextInspectionScope;

impl TurnExecutor {
    /// Reads the same host context, tool catalog and extension contributions used by execution.
    /// It performs no model I/O, evidence retrieval, compaction or durable mutation.
    pub(crate) fn inspect_context(
        &self,
        request: ContextInspectionRequest<'_>,
    ) -> Result<ContextInspection, CoreError> {
        let snapshot = match request.scope {
            ContextInspectionScope::Environment => None,
            ContextInspectionScope::Thread(thread_id) => Some(self.threads.read_thread(thread_id)?),
        };
        let latest = snapshot.as_ref().and_then(|snapshot| snapshot.turns.last());
        let context_policy = match (snapshot.as_ref(), latest) {
            (Some(snapshot), Some(turn)) => snapshot.context_policy(&turn.turn_id),
            _ => request.context_policy,
        };
        let read_paths = match (snapshot.as_ref(), latest) {
            (Some(snapshot), Some(turn)) => {
                crate::services::read_paths_for_turn(snapshot, &turn.turn_id)
            }
            _ => Vec::new(),
        };
        let harness_scope = match (snapshot.as_ref(), latest) {
            (Some(snapshot), Some(turn)) => HarnessContextScope::Turn {
                session_id: &snapshot.session_id,
                thread_id: &snapshot.thread_id,
                turn_id: &turn.turn_id,
            },
            (Some(snapshot), None) => HarnessContextScope::Thread {
                session_id: &snapshot.session_id,
                thread_id: &snapshot.thread_id,
            },
            (None, None) => HarnessContextScope::Environment,
            (None, Some(_)) => unreachable!("a Turn belongs to its snapshot"),
        };
        let harness = self.harness_context.snapshot(&HarnessContextRequest {
            scope: harness_scope,
            read_paths: &read_paths,
        })?;
        let activated_skills = latest
            .map(|turn| turn.activated_skills.as_slice())
            .unwrap_or_default();
        let extension_context = match (snapshot.as_ref(), latest) {
            (Some(snapshot), Some(turn)) => ash_extension_api::TurnInputContext::for_session(
                &snapshot.session_id,
                &snapshot.thread_id,
                &turn.turn_id,
                activated_skills,
            ),
            (Some(snapshot), None) => ash_extension_api::TurnInputContext::for_thread(
                &snapshot.session_id,
                &snapshot.thread_id,
                activated_skills,
            ),
            (None, None) => ash_extension_api::TurnInputContext::for_environment(),
            (None, Some(_)) => unreachable!("a Turn belongs to its snapshot"),
        };
        let mut additional = harness.instructions().context_fragments();
        if let Some(snapshot) = &snapshot {
            additional.extend(crate::multi_agent::agent_context_fragments(snapshot));
        }
        additional.extend(
            self.extensions
                .contribute_turn_input(extension_context)
                .map_err(|error| CoreError::Context(error.to_string()))?
                .into_iter()
                .map(crate::context::InstructionFragment::try_from)
                .collect::<Result<Vec<_>, _>>()?,
        );
        let instructions = crate::context::turn_instruction_fragments(
            &request.instructions,
            request.approval_mode,
            latest.map(|turn| turn.mode).unwrap_or_default(),
            if snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.parent_thread_id.is_some())
            {
                crate::context::AgentInstructionRole::Subagent
            } else {
                crate::context::AgentInstructionRole::Root
            },
            additional,
        );
        let activated = match (snapshot.as_ref(), latest) {
            (Some(snapshot), Some(turn)) => super::executor::activated_tool_names(
                self.tools.as_ref(),
                &snapshot.items,
                &turn.turn_id,
            )?,
            _ => Default::default(),
        };
        let catalog = self.context_tool_catalog(
            &activated,
            latest,
            request.tool_mode,
            Some(&request.instructions),
        )?;
        let tools = catalog.definitions().to_vec();
        let tools = match &snapshot {
            Some(snapshot) => {
                crate::multi_agent::scope_agent_tools(snapshot, request.tool_mode, tools)
            }
            None => tools,
        };
        let selection = request
            .model
            .as_ref()
            .map_or(ModelSelection::ConfiguredDefault, ModelSelection::Session);
        let configured = match request.model {
            Some(_) => self.model_source.context_budget(selection)?,
            None => crate::ContextBudget::ProviderManaged,
        };
        let calibration = snapshot.as_ref().and_then(|snapshot| {
            request
                .model
                .as_ref()
                .and_then(|model| snapshot.context_calibration(model, CONTEXT_ESTIMATOR_REVISION))
        });
        let budget = calibrated_budget(configured, calibration)
            .map_err(|error| CoreError::Context(error.to_string()))?;
        let budget = match context_policy {
            ash_protocol::ContextCompactionPolicy::Handoff { buffer_tokens, .. } => {
                budget.with_input_buffer(crate::ContextTokenCount::new(buffer_tokens))
            }
            ash_protocol::ContextCompactionPolicy::Summary { .. } => budget,
        };
        let mut environment = harness
            .environment()
            .map(|environment| environment.render())
            .unwrap_or_default();
        if let Some(time) = self.threads.sample_time_context()? {
            if !environment.is_empty() {
                environment.push('\n');
            }
            environment.push_str(
                &ash_agent_environment::TimeSnapshot::new(time)
                    .map_err(|error| CoreError::Context(error.to_string()))?
                    .render(),
            );
        }
        let history = match (snapshot.as_ref(), latest) {
            (Some(snapshot), Some(turn)) => Some(
                ContextInput::new(
                    snapshot,
                    turn.turn_id.clone(),
                    instructions.clone(),
                    tools.clone(),
                    budget,
                )
                .with_policy(context_policy.clone())
                .with_rendered_environment(&environment)
                .with_time_references(&snapshot.user_time_contexts)?,
            ),
            _ => None,
        };
        let categories = ContextPlanner::inspect_categories(
            history
                .as_ref()
                .map_or(instructions.as_slice(), ContextInput::instructions),
            &tools,
            &environment,
            history.as_ref(),
        );
        let original_limits = configured
            .resolve()
            .map_err(|error| CoreError::Context(error.to_string()))?;
        let allocation = match (
            original_limits,
            budget
                .resolve()
                .map_err(|error| CoreError::Context(error.to_string()))?,
        ) {
            (ResolvedContextBudget::ProviderManaged, ResolvedContextBudget::ProviderManaged) => {
                None
            }
            (
                ResolvedContextBudget::CoreManaged(original),
                ResolvedContextBudget::CoreManaged(limits),
            ) => {
                let context_window = u64::from(original.context_window().get());
                let auto_compact_buffer =
                    u64::from(limits.hard_maximum_input().get() - limits.maximum_input().get());
                Some(ModelContextAllocation {
                    context_window,
                    auto_compact_window: context_window - auto_compact_buffer,
                    auto_compact_at: u64::from(limits.maximum_input().get()),
                    auto_compact_buffer,
                    reserved_output: u64::from(limits.reserved_output().get()),
                    // Calibration reduces admissible input, never the model's advertised capacity.
                    safety_margin: u64::from(limits.safety_margin().get())
                        + u64::from(
                            original.context_window().get() - limits.context_window().get(),
                        ),
                })
            }
            (ResolvedContextBudget::ProviderManaged, ResolvedContextBudget::CoreManaged(_))
            | (ResolvedContextBudget::CoreManaged(_), ResolvedContextBudget::ProviderManaged) => {
                unreachable!("calibration preserves budget ownership")
            }
        };
        let context = ModelContextInspection {
            compaction_policy: context_policy,
            model: request.model.clone(),
            estimated_tokens: categories.iter().map(|category| category.tokens).sum(),
            estimator_revision: CONTEXT_ESTIMATOR_REVISION.into(),
            categories,
            allocation,
            latest_request: latest
                .filter(|turn| turn.model == request.model)
                .and_then(|turn| turn.context_usage.clone()),
        };
        Ok(ContextInspection {
            context,
            tool_definitions: tools,
        })
    }
}
