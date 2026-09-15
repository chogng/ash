use super::super::tool_scheduler::ToolScheduler;
use super::super::tool_scheduler::ToolSchedulingProgress;
use super::broker::CodeModeBrokerInner;
use super::broker::RuntimeKey;
use super::catalog::is_control_name;
use super::catalog::normalize_code_name;
use super::response::find_tool_result;
use super::response::interaction_pending_for_item;
use super::response::result_to_value;
use crate::CoreError;
use crate::HookService;
use crate::RecordToolCallRequest;
use crate::ThreadUpdateSink;
use ash_async_utils::CancellationToken;
use ash_code_mode_protocol::CodeModeToolKind;
use ash_code_mode_protocol::NestedToolCall;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

impl CodeModeBrokerInner {
    pub(super) fn invoke_nested(
        &self,
        key: &RuntimeKey,
        frozen_catalog: &crate::ModelToolCatalogSnapshot,
        tools: Arc<dyn crate::ToolService>,
        policy: Arc<dyn crate::ActionPolicyService>,
        call: NestedToolCall,
        cancellation: &CancellationToken,
        updates: Arc<dyn ThreadUpdateSink>,
        hooks: Arc<dyn HookService>,
    ) -> Result<serde_json::Value, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let thread_id = key.thread_id()?;
        let turn_id = key.turn_id()?;
        let cell_runtime = self
            .runtimes
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode runtime registry was poisoned".into()))?
            .get(key)
            .cloned()
            .ok_or_else(|| {
                CoreError::Execution("Code Mode runtime session is unavailable".into())
            })?;
        if !cell_runtime.has_cell(&call.cell_id) {
            return Err(CoreError::Execution(
                "Code Mode nested call references an unknown cell".into(),
            ));
        }
        let snapshot = self.threads.read_thread(&thread_id)?;
        let parent_tool_call_id = ToolCallId::new(call.parent_tool_call_id.clone())
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let expected_parent = self
            .cell_parents
            .lock()
            .map_err(|_| CoreError::Execution("Code Mode cell registry was poisoned".into()))?
            .get(&(key.clone(), call.cell_id.to_string()))
            .cloned()
            .ok_or_else(|| CoreError::Execution("Code Mode cell parent is unavailable".into()))?;
        if expected_parent != parent_tool_call_id {
            return Err(CoreError::Execution(
                "Code Mode nested call parent does not match the owning cell".into(),
            ));
        }
        let parent_exists = snapshot.items.iter().any(|item| {
            matches!(
                item,
                ThreadItem::ToolCall {
                    turn_id: item_turn_id,
                    tool_call_id,
                    name,
                    ..
                } if item_turn_id == &turn_id
                    && tool_call_id == &parent_tool_call_id
                    && snapshot.started_tool_calls.contains(tool_call_id)
                    && is_control_name(name)
            )
        });
        if !parent_exists {
            return Err(CoreError::Execution(
                "Code Mode nested call parent is not a durable control Tool Call".into(),
            ));
        }
        let definition = frozen_catalog
            .definitions()
            .iter()
            .find(|definition| definition.name == call.tool_name)
            .ok_or_else(|| {
                CoreError::Policy(format!(
                    "Code Mode nested tool is not part of the frozen Tool catalog: {}",
                    call.tool_name
                ))
            })?;
        let current_definition = tools
            .definitions()
            .into_iter()
            .find(|candidate| candidate.name == call.tool_name)
            .ok_or_else(|| {
                CoreError::Execution(format!(
                    "nested Tool definition is no longer available: {}",
                    call.tool_name
                ))
            })?;
        if &current_definition != definition {
            return Err(CoreError::Execution(format!(
                "nested Tool definition changed while the Code Mode session was running: {}",
                call.tool_name
            )));
        }
        let expected_global_name = normalize_code_name(call.tool_name.as_str());
        if expected_global_name != call.global_name || call.kind != CodeModeToolKind::Function {
            return Err(CoreError::Policy(
                "Code Mode nested Tool projection does not match its frozen definition".into(),
            ));
        }
        let nested_id = ToolCallId::new(format!(
            "code-{}-{}",
            parent_tool_call_id, call.runtime_tool_call_id
        ))
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let nested_call = ToolCall {
            id: nested_id.clone(),
            name: call.tool_name,
            arguments: call.input,
        };
        let caller = ToolCallCaller::CodeMode {
            parent_tool_call_id,
            cell_id: call.cell_id.to_string(),
            runtime_call_id: call.runtime_tool_call_id,
        };
        let binding = match frozen_catalog.bind_call(&nested_call, caller.clone()) {
            Some(result) => result?.ok_or_else(|| {
                CoreError::Execution("frozen nested Tool binding is unavailable".into())
            })?,
            None => tools
                .bind_call(&nested_call, caller)?
                .ok_or_else(|| CoreError::Execution("nested Tool binding is unavailable".into()))?,
        };
        let recorded = self.threads.record_tool_call(
            &thread_id,
            &turn_id,
            RecordToolCallRequest {
                tool_call_id: Some(nested_id.clone()),
                name: nested_call.name.clone(),
                arguments_json: serde_json::to_string(&nested_call.arguments)
                    .map_err(|error| CoreError::Context(error.to_string()))?,
                binding: Some(binding),
            },
        )?;
        let item_id = recorded.item.item_id().clone();
        let scheduler = ToolScheduler::new(Arc::clone(&self.threads), tools, policy)
            .with_thread_updates(updates)
            .with_hooks(hooks);

        loop {
            cancellation
                .check()
                .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
            let progress =
                scheduler.run_pending_for_call(&thread_id, &turn_id, &nested_id, cancellation)?;
            let snapshot = self.threads.read_thread(&thread_id)?;
            if let Some(result) = find_tool_result(&snapshot.items, &nested_id) {
                return result_to_value(result);
            }
            if progress == ToolSchedulingProgress::Complete {
                return Err(CoreError::Execution(format!(
                    "nested Tool Call {} completed without a Tool Result",
                    nested_id
                )));
            }
            if interaction_pending_for_item(&snapshot, &turn_id, &item_id) {
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
}
