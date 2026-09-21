use crate::ContextBudget;
use crate::CoreError;
use crate::ModelSelection;
use crate::ModelService;
use crate::ThreadController;
use crate::ToolExecutionIdentity;
use crate::context::ContextAssembler;
use crate::context::ContextInput;
use crate::context::ContextPlanner;
use crate::context::ContextPreparation;
use crate::context::InstructionFragment;
use crate::context::InstructionPlacement;
use crate::context::InstructionRetention;
use crate::context::InstructionSource;
use ash_async_utils::CancellationToken;
use ash_protocol::ModelRef;
use ash_protocol::ModelResponse;
use ash_protocol::ReasoningConfig;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Executes an auxiliary model within an already-authorized durable Tool Call.
/// Core owns context, attachments and accounting; the capability owns its prompt and selection.
pub struct ToolModel {
    threads: Arc<ThreadController>,
    model: Arc<dyn ModelService>,
}

pub struct ToolModelRequest<'a> {
    pub identity: &'a ToolExecutionIdentity,
    pub call_id: &'a ToolCallId,
    pub model: &'a ModelRef,
    pub instructions: &'a str,
    pub question: &'a str,
    pub max_output_tokens: u32,
    pub reasoning: Option<ReasoningConfig>,
}

pub struct ToolModelResponse {
    pub response: ModelResponse,
    pub source_sequence: u64,
    pub checkpoint: Option<ash_protocol::ContextSourceRange>,
    pub elapsed_ms: u64,
}

impl ToolModel {
    pub fn new(threads: Arc<ThreadController>, model: Arc<dyn ModelService>) -> Self {
        Self { threads, model }
    }

    pub fn invoke(
        &self,
        request: ToolModelRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<ToolModelResponse, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let thread_id = request.identity.thread_id();
        let turn_id = request.identity.turn_id();
        let mut snapshot = self.threads.read_thread(thread_id)?;
        if &snapshot.session_id != request.identity.session_id()
            || !snapshot.started_tool_calls.contains(request.call_id)
            || !snapshot.items.iter().any(|item| matches!(item, ThreadItem::ToolCall { turn_id: owner, tool_call_id, .. } if owner == turn_id && tool_call_id == request.call_id))
        {
            return Err(CoreError::InvalidInput("auxiliary model requires the running Tool Call identity".into()));
        }
        let source_sequence = snapshot.sequence;
        // In-flight siblings and this consultation are not completed evidence. Keep both sides
        // of every completed call so the ordinary context planner retains valid tool groups.
        let completed: BTreeSet<_> = snapshot
            .items
            .iter()
            .filter_map(|item| match item {
                ThreadItem::ToolResult { tool_call_id, .. } => Some(tool_call_id.clone()),
                _ => None,
            })
            .collect();
        snapshot.items.retain(|item| match item {
            ThreadItem::ToolCall { tool_call_id, .. } => completed.contains(tool_call_id),
            _ => true,
        });
        let selection = ModelSelection::Session(request.model);
        let model = self
            .model
            .snapshot(selection)?
            .unwrap_or_else(|| Arc::clone(&self.model));
        let model = crate::attachment_model_service::AttachmentModelService::new(
            model,
            self.threads.attachments(),
        );
        let budget = match model.context_budget(selection)? {
            ContextBudget::ProviderManaged => ContextBudget::ProviderManaged,
            ContextBudget::CoreManaged {
                context_window,
                safety_margin,
                ..
            } => ContextBudget::core_managed(
                context_window,
                crate::ContextTokenCount::new(request.max_output_tokens),
                safety_margin,
                crate::ContextCompactionLimit::ContextWindow,
            ),
        };
        let constraints = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .and_then(|turn| turn.instructions.as_ref())
            .map(|instructions| {
                instructions
                    .shared()
                    .iter()
                    .map(|text| text.body.as_str())
                    .chain(std::iter::once(instructions.body()))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default();
        let instructions = vec![
            InstructionFragment::new(
                InstructionSource::new("tool-model", "task-constraints", "1"),
                InstructionPlacement::System,
                InstructionRetention::Required,
                format!(
                    "The working agent's task constraints, supplied for review:\n{constraints}"
                ),
            ),
            InstructionFragment::new(
                InstructionSource::new("tool-model", "consultation", "1"),
                InstructionPlacement::System,
                InstructionRetention::Required,
                request.instructions,
            ),
            InstructionFragment::new(
                InstructionSource::new("tool-model", "question", "1"),
                InstructionPlacement::Turn,
                InstructionRetention::Required,
                format!("Consultation question:\n{}", request.question),
            ),
        ];
        let input = ContextInput::new(&snapshot, turn_id.clone(), instructions, Vec::new(), budget);
        let plan = match ContextPlanner::prepare(&input).map_err(|error| CoreError::Context(error.to_string()))? {
            ContextPreparation::Ready(plan) => plan,
            ContextPreparation::NeedsCompaction(_) => return Err(CoreError::Context(
                "consultation exceeds the selected model's context window; compact the conversation or select a larger context model".into(),
            )),
        };
        let checkpoint = plan.checkpoint().map(|checkpoint| checkpoint.covered);
        let mut model_request = ContextAssembler::assemble(&plan)?;
        model_request.tools.clear();
        model_request.tool_choice = ash_protocol::ToolChoice::None;
        model_request.parallel_tool_calls = false;
        model_request.max_output_tokens = Some(request.max_output_tokens);
        model_request.reasoning = request.reasoning;
        let billing_scope = model.billing_scope(selection)?;
        let started = timestamp()?;
        let response = model.invoke(selection, &model_request, cancellation);
        let completed = timestamp()?;
        self.threads.record_model_invocation_for_tool(
            thread_id,
            turn_id,
            Some(request.model),
            response
                .as_ref()
                .ok()
                .and_then(|response| response.billing.as_ref()),
            billing_scope,
            response
                .as_ref()
                .ok()
                .and_then(|response| response.usage.clone()),
            None,
            None,
            started,
            completed,
            Some(request.call_id.clone()),
            match &response {
                Ok(_) => ash_protocol::ModelInvocationOutcome::Completed,
                Err(CoreError::Cancelled(_)) => ash_protocol::ModelInvocationOutcome::Cancelled,
                Err(_) => ash_protocol::ModelInvocationOutcome::Failed,
            },
        )?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(ToolModelResponse {
            response: response?,
            source_sequence,
            checkpoint,
            elapsed_ms: completed.saturating_sub(started),
        })
    }
}

fn timestamp() -> Result<u64, CoreError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| CoreError::Execution(error.to_string()))
}
