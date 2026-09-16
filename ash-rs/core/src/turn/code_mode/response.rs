use super::super::super::ThreadSnapshot;
use crate::CoreError;
use crate::ToolExecutionOutput;
use ash_async_utils::CancellationToken;
use ash_code_mode::CodeModeRuntime;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::WaitOutcome;
use ash_code_mode_protocol::WaitRequest;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;
use ash_protocol::ItemId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use std::time::Duration;
use std::time::Instant;

pub(super) fn runtime_error(error: ash_code_mode::RuntimeError) -> CoreError {
    CoreError::Execution(format!("Code Mode runtime error: {error}"))
}

fn cancellation_error(
    runtime: &CodeModeRuntime,
    cell_id: &CellId,
    cancellation: &CancellationToken,
) -> Result<(), CoreError> {
    if let Err(signal) = cancellation.check() {
        let _ = runtime.terminate(cell_id);
        return Err(CoreError::Cancelled(signal.reason().to_string()));
    }
    Ok(())
}

pub(super) fn cancellation_aware_terminate_or_wait(
    runtime: &CodeModeRuntime,
    cell_id: CellId,
    _: u64,
    max_output_tokens: Option<u32>,
    cancellation: &CancellationToken,
) -> Result<WaitOutcome, CoreError> {
    cancellation_error(runtime, &cell_id, cancellation)?;
    let mut outcome = runtime
        .wait(WaitRequest {
            cell_id,
            yield_time_ms: 0,
            max_output_tokens: None,
            terminate: true,
        })
        .map_err(runtime_error)?;
    if let WaitOutcome::LiveCell { response } = &mut outcome {
        ash_code_mode::limit_output(response, Some(max_output_tokens.unwrap_or(10_000)));
    }
    Ok(outcome)
}

pub(super) fn observe_runtime(
    runtime: &CodeModeRuntime,
    cell_id: CellId,
    yield_time_ms: u64,
    max_output_tokens: Option<u32>,
    cancellation: &CancellationToken,
) -> Result<WaitOutcome, CoreError> {
    let mut outcome = observe_unbounded(runtime, cell_id, yield_time_ms, cancellation)?;
    if let WaitOutcome::LiveCell { response } = &mut outcome {
        ash_code_mode::limit_output(response, Some(max_output_tokens.unwrap_or(10_000)));
    }
    Ok(outcome)
}

fn observe_unbounded(
    runtime: &CodeModeRuntime,
    cell_id: CellId,
    yield_time_ms: u64,
    cancellation: &CancellationToken,
) -> Result<WaitOutcome, CoreError> {
    let timeout_ms = yield_time_ms
        .min(CodeModeLimits::default().max_yield_time_ms)
        .max(1);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut content_items = Vec::new();
    loop {
        cancellation_error(runtime, &cell_id, cancellation)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(WaitOutcome::LiveCell {
                response: RuntimeResponse::Running {
                    cell_id,
                    content_items,
                },
            });
        }
        let slice_ms = remaining.as_millis().min(100).max(1) as u64;
        let outcome = runtime
            .wait(WaitRequest {
                cell_id: cell_id.clone(),
                yield_time_ms: slice_ms,
                max_output_tokens: None,
                terminate: false,
            })
            .map_err(runtime_error)?;
        let WaitOutcome::LiveCell { response } = outcome else {
            return Ok(outcome);
        };
        cancellation_error(runtime, &cell_id, cancellation)?;
        match response {
            RuntimeResponse::Running {
                cell_id,
                content_items: new_items,
            } => {
                content_items.extend(new_items);
                if Instant::now() >= deadline {
                    return Ok(WaitOutcome::LiveCell {
                        response: RuntimeResponse::Running {
                            cell_id,
                            content_items,
                        },
                    });
                }
            }
            RuntimeResponse::Yielded {
                cell_id,
                content_items: new_items,
            } => {
                content_items.extend(new_items);
                return Ok(WaitOutcome::LiveCell {
                    response: RuntimeResponse::Yielded {
                        cell_id,
                        content_items,
                    },
                });
            }
            RuntimeResponse::Terminated {
                cell_id,
                content_items: new_items,
            } => {
                content_items.extend(new_items);
                return Ok(WaitOutcome::LiveCell {
                    response: RuntimeResponse::Terminated {
                        cell_id,
                        content_items,
                    },
                });
            }
            RuntimeResponse::Result {
                cell_id,
                content_items: new_items,
                error_text,
            } => {
                content_items.extend(new_items);
                return Ok(WaitOutcome::LiveCell {
                    response: RuntimeResponse::Result {
                        cell_id,
                        content_items,
                        error_text,
                    },
                });
            }
            RuntimeResponse::Unknown {
                cell_id,
                content_items: new_items,
                reason,
            } => {
                content_items.extend(new_items);
                return Ok(WaitOutcome::LiveCell {
                    response: RuntimeResponse::Unknown {
                        cell_id,
                        content_items,
                        reason,
                    },
                });
            }
        }
    }
}

pub(super) fn runtime_wait_output(outcome: WaitOutcome) -> Result<ToolExecutionOutput, CoreError> {
    match outcome {
        WaitOutcome::MissingCell { cell_id } => Ok(ToolExecutionOutput::Failure(format!(
            "Code Mode cell is unavailable: {cell_id}"
        ))),
        WaitOutcome::LiveCell { response } => response_output(response),
    }
}

fn response_output(response: RuntimeResponse) -> Result<ToolExecutionOutput, CoreError> {
    match response {
        RuntimeResponse::Running {
            cell_id,
            content_items,
        } => live_response_output("running", cell_id, content_items),
        RuntimeResponse::Yielded {
            cell_id,
            content_items,
        } => live_response_output("yielded", cell_id, content_items),
        RuntimeResponse::Terminated {
            cell_id,
            content_items,
        } => terminal_response_output("terminated", cell_id, content_items, true),
        RuntimeResponse::Result {
            cell_id,
            content_items,
            error_text,
        } => {
            let content = output_items_to_content(content_items)?;
            match error_text {
                Some(error) if content.is_empty() => Ok(ToolExecutionOutput::Failure(format!(
                    "Code Mode cell {cell_id} failed: {error}"
                ))),
                Some(error) => {
                    let mut content = content;
                    content.insert(
                        0,
                        ContentPart::Text(format!("Code Mode cell failed: {error}")),
                    );
                    Ok(ToolExecutionOutput::FailureContent(content))
                }
                None if content.is_empty() => Ok(ToolExecutionOutput::Success(format!(
                    "Code Mode cell {cell_id} completed"
                ))),
                None => Ok(ToolExecutionOutput::SuccessContent(content)),
            }
        }
        RuntimeResponse::Unknown {
            cell_id,
            reason,
            content_items: _,
        } => Ok(ToolExecutionOutput::OutcomeUnknown(format!(
            "Code Mode cell {cell_id} has unknown outcome: {reason}"
        ))),
    }
}

fn live_response_output(
    state: &str,
    cell_id: CellId,
    content_items: Vec<OutputItem>,
) -> Result<ToolExecutionOutput, CoreError> {
    let mut content = output_items_to_content(content_items)?;
    content.insert(
        0,
        ContentPart::Text(format!(
            "Code Mode cell {cell_id} is {state}; call wait with cellId `{cell_id}` to continue"
        )),
    );
    Ok(ToolExecutionOutput::SuccessContent(content))
}

fn terminal_response_output(
    state: &str,
    cell_id: CellId,
    content_items: Vec<OutputItem>,
    failed: bool,
) -> Result<ToolExecutionOutput, CoreError> {
    let mut content = output_items_to_content(content_items)?;
    content.insert(
        0,
        ContentPart::Text(format!("Code Mode cell {cell_id} was {state}")),
    );
    if failed {
        Ok(ToolExecutionOutput::FailureContent(content))
    } else {
        Ok(ToolExecutionOutput::SuccessContent(content))
    }
}

fn output_items_to_content(items: Vec<OutputItem>) -> Result<Vec<ContentPart>, CoreError> {
    items
        .into_iter()
        .map(|item| match item {
            OutputItem::Text { text } => Ok(ContentPart::Text(text)),
            OutputItem::Image { image_url, detail } => Ok(ContentPart::ImageUrl {
                url: image_url,
                detail: parse_image_detail(detail.as_deref())?,
            }),
        })
        .collect()
}

fn parse_image_detail(detail: Option<&str>) -> Result<ImageDetail, CoreError> {
    match detail.unwrap_or("auto") {
        "auto" => Ok(ImageDetail::Auto),
        "low" => Ok(ImageDetail::Low),
        "high" => Ok(ImageDetail::High),
        "original" => Ok(ImageDetail::Original),
        value => Err(CoreError::InvalidInput(format!(
            "unsupported Code Mode image detail: {value}"
        ))),
    }
}

pub(super) struct ToolResultRef<'a> {
    text: &'a str,
    content: Option<&'a [ContentPart]>,
    is_error: bool,
}

pub(super) fn find_tool_result<'a>(
    items: &'a [ThreadItem],
    tool_call_id: &ToolCallId,
) -> Option<ToolResultRef<'a>> {
    items.iter().rev().find_map(|item| match item {
        ThreadItem::ToolResult {
            tool_call_id: result_id,
            text,
            content,
            is_error,
            ..
        } if result_id == tool_call_id => Some(ToolResultRef {
            text,
            content: content.as_deref(),
            is_error: *is_error,
        }),
        _ => None,
    })
}

pub(super) fn result_to_value(result: ToolResultRef<'_>) -> Result<serde_json::Value, CoreError> {
    if let Some(content) = result.content {
        return Ok(serde_json::json!({
            "text": result.text,
            "content": content,
            "isError": result.is_error,
        }));
    }
    if result.is_error {
        return Err(CoreError::Execution(result.text.to_owned()));
    }
    Ok(serde_json::Value::String(result.text.to_owned()))
}

pub(super) fn interaction_pending_for_item(
    snapshot: &ThreadSnapshot,
    turn_id: &TurnId,
    item_id: &ItemId,
) -> bool {
    snapshot
        .turns
        .iter()
        .find(|turn| &turn.turn_id == turn_id)
        .and_then(|turn| turn.pending_interaction.as_ref())
        .is_some_and(|interaction| interaction.item_id.as_ref() == Some(item_id))
}
