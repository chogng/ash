use super::{CellCommand, CellEvent, RuntimeState};
use crate::globals;
use crate::value::value_to_error_text;
use ash_code_mode_protocol::{
    CellId, CodeModeLimits, CodeModeSessionId, ExecuteRequest, OutputItem, RuntimeResponse,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

struct HeapLimitState {
    exceeded: Arc<AtomicBool>,
    isolate_handle: v8::IsolateHandle,
}

unsafe extern "C" fn near_heap_limit(
    data: *mut c_void,
    current_heap_limit: usize,
    _: usize,
) -> usize {
    // SAFETY: `data` points to `heap_limit_state`, which stays alive until this isolate is dropped.
    let state = unsafe { &*(data.cast::<HeapLimitState>()) };
    state.exceeded.store(true, Ordering::Release);
    let _ = state.isolate_handle.terminate_execution();
    // Give V8 enough emergency headroom to unwind the terminated execution instead of invoking
    // its process-fatal out-of-memory path.
    current_heap_limit.saturating_add(4 * 1024 * 1024)
}

pub(super) fn validate_request(
    request: &ExecuteRequest,
    session_id: &CodeModeSessionId,
) -> Result<(), super::RuntimeError> {
    if request.session_id != *session_id {
        return Err(super::RuntimeError::InvalidRequest(
            "Execute request belongs to another Code Mode session".into(),
        ));
    }
    if request.source.trim().is_empty() {
        return Err(super::RuntimeError::InvalidRequest(
            "Code Mode source must not be empty".into(),
        ));
    }
    if request.max_output_tokens == Some(0) {
        return Err(super::RuntimeError::InvalidRequest(
            "Code Mode max_output_tokens must be greater than zero".into(),
        ));
    }
    let mut names = BTreeSet::new();
    for tool in &request.enabled_tools {
        if tool.global_name.trim().is_empty() || tool.tool_name.trim().is_empty() {
            return Err(super::RuntimeError::InvalidRequest(
                "Code Mode tool names must not be empty".into(),
            ));
        }
        if !names.insert(tool.global_name.clone()) {
            return Err(super::RuntimeError::InvalidRequest(format!(
                "duplicate Code Mode tool name: {}",
                tool.global_name
            )));
        }
        if matches!(
            tool.global_name.as_str(),
            "__proto__" | "prototype" | "constructor"
        ) {
            return Err(super::RuntimeError::InvalidRequest(
                "reserved JavaScript tool name is not allowed".into(),
            ));
        }
    }
    Ok(())
}

pub(super) fn run_cell(
    cell_id: CellId,
    request: ExecuteRequest,
    limits: CodeModeLimits,
    stored_values: BTreeMap<String, Value>,
    invoker: Arc<dyn super::ToolInvoker>,
    command_rx: Receiver<CellCommand>,
    command_tx: Sender<CellCommand>,
    timed_out: Arc<AtomicBool>,
    termination_requested: Arc<AtomicBool>,
    event_tx: Sender<CellEvent>,
    handle_tx: mpsc::SyncSender<v8::IsolateHandle>,
    done: Arc<AtomicBool>,
) {
    let params = v8::Isolate::create_params().heap_limits(0, limits.max_heap_bytes);
    let max_output_bytes = limits.max_output_bytes;
    let (tool_completion_tx, tool_completion_rx) = mpsc::channel();
    let isolate = &mut v8::Isolate::new(params);
    let isolate_handle = isolate.thread_safe_handle();
    let memory_limit_exceeded = Arc::new(AtomicBool::new(false));
    let mut heap_limit_state = HeapLimitState {
        exceeded: Arc::clone(&memory_limit_exceeded),
        isolate_handle: isolate_handle.clone(),
    };
    isolate.add_near_heap_limit_callback(
        near_heap_limit,
        (&mut heap_limit_state as *mut HeapLimitState).cast(),
    );
    if handle_tx.send(isolate_handle.clone()).is_err() {
        done.store(true, Ordering::Release);
        return;
    }
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    scope.set_slot(RuntimeState {
        invoker,
        cell_id: cell_id.clone(),
        tool_call_id: request.tool_call_id,
        enabled_tools: request.enabled_tools,
        stored_values,
        stored_value_writes: BTreeMap::new(),
        output_items: Vec::new(),
        output_bytes: 0,
        max_output_bytes,
        max_nested_calls: limits.max_nested_calls,
        next_tool_call_id: 1,
        tool_completion_tx,
        tool_completion_rx,
        pending_tool_calls: BTreeMap::new(),
        yield_requested: false,
        yield_resolver: None,
        exit_requested: false,
    });

    match next_command(&command_rx) {
        Some(CellCommand::Start) => {}
        Some(CellCommand::Terminate) => {
            send_result(
                scope,
                &event_tx,
                RuntimeResponse::Terminated {
                    cell_id,
                    content_items: Vec::new(),
                },
            );
            done.store(true, Ordering::Release);
            return;
        }
        Some(CellCommand::Resume) | None => {
            send_result(
                scope,
                &event_tx,
                RuntimeResponse::Unknown {
                    cell_id,
                    content_items: Vec::new(),
                    reason: "Code Mode cell did not receive its start command".into(),
                },
            );
            done.store(true, Ordering::Release);
            return;
        }
    }

    let watchdog_done = Arc::clone(&done);
    let watchdog_timed_out = Arc::clone(&timed_out);
    let watchdog_termination_requested = Arc::clone(&termination_requested);
    let max_execution_time_ms = limits.max_execution_time_ms;
    let timeout_tx = command_tx;
    let timeout_handle = isolate_handle.clone();
    let timeout_invoker = scope
        .get_slot::<RuntimeState>()
        .expect("runtime installed")
        .invoker
        .clone();
    let timeout_cell = cell_id.clone();
    let (_finished_tx, finished_rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        if matches!(
            finished_rx.recv_timeout(Duration::from_millis(max_execution_time_ms)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) && !watchdog_done.swap(true, Ordering::AcqRel)
        {
            watchdog_timed_out.store(true, Ordering::Release);
            watchdog_termination_requested.store(true, Ordering::Release);
            timeout_invoker.cancel_cell(&timeout_cell);
            let _ = timeout_tx.send(CellCommand::Terminate);
            let _ = timeout_handle.terminate_execution();
        }
    });

    if let Err(error) = globals::install_globals(scope) {
        send_result(
            scope,
            &event_tx,
            RuntimeResponse::Result {
                cell_id,
                content_items: Vec::new(),
                error_text: Some(error),
            },
        );
        done.store(true, Ordering::Release);
        return;
    }
    let source = format!("(async function() {{\n{}\n}})()", request.source);
    let promise = match evaluate(scope, &source) {
        Ok(promise) => promise,
        Err(error) => {
            let response = if memory_limit_exceeded.load(Ordering::Acquire) {
                RuntimeResponse::Result {
                    cell_id,
                    content_items: Vec::new(),
                    error_text: Some("Code Mode memory limit exceeded".into()),
                }
            } else if timed_out.load(Ordering::Acquire)
                || termination_requested.load(Ordering::Acquire)
                || isolate_handle.is_execution_terminating()
            {
                RuntimeResponse::Terminated {
                    cell_id,
                    content_items: Vec::new(),
                }
            } else {
                RuntimeResponse::Result {
                    cell_id,
                    content_items: Vec::new(),
                    error_text: Some(error),
                }
            };
            send_result(scope, &event_tx, response);
            done.store(true, Ordering::Release);
            return;
        }
    };

    loop {
        if let Err(error) = apply_available_tool_completions(scope) {
            let response = RuntimeResponse::Result {
                cell_id: cell_id.clone(),
                content_items: take_output_items(scope),
                error_text: Some(error),
            };
            send_result(scope, &event_tx, response);
            done.store(true, Ordering::Release);
            return;
        }
        scope.perform_microtask_checkpoint();
        if memory_limit_exceeded.load(Ordering::Acquire) {
            let response = RuntimeResponse::Result {
                cell_id,
                content_items: take_output_items(scope),
                error_text: Some("Code Mode memory limit exceeded".into()),
            };
            send_result(scope, &event_tx, response);
            done.store(true, Ordering::Release);
            return;
        }
        let promise_local = v8::Local::new(scope, &promise);
        match promise_local.state() {
            v8::PromiseState::Fulfilled => {
                let response = if timed_out.load(Ordering::Acquire)
                    || termination_requested.load(Ordering::Acquire)
                    || isolate_handle.is_execution_terminating()
                {
                    RuntimeResponse::Terminated {
                        cell_id: cell_id.clone(),
                        content_items: take_output_items(scope),
                    }
                } else {
                    result_response(scope, cell_id.clone(), None)
                };
                send_result(scope, &event_tx, response);
                done.store(true, Ordering::Release);
                return;
            }
            v8::PromiseState::Rejected => {
                let error = promise_local.result(scope);
                let exit_requested = scope
                    .get_slot::<RuntimeState>()
                    .map(|state| state.exit_requested)
                    .unwrap_or(false);
                let response = if exit_requested {
                    result_response(scope, cell_id.clone(), None)
                } else if timed_out.load(Ordering::Acquire)
                    || termination_requested.load(Ordering::Acquire)
                    || isolate_handle.is_execution_terminating()
                {
                    RuntimeResponse::Terminated {
                        cell_id: cell_id.clone(),
                        content_items: take_output_items(scope),
                    }
                } else {
                    RuntimeResponse::Result {
                        cell_id: cell_id.clone(),
                        content_items: take_output_items(scope),
                        error_text: Some(value_to_error_text(scope, error)),
                    }
                };
                send_result(scope, &event_tx, response);
                done.store(true, Ordering::Release);
                return;
            }
            v8::PromiseState::Pending => {
                if timed_out.load(Ordering::Acquire)
                    || termination_requested.load(Ordering::Acquire)
                    || isolate_handle.is_execution_terminating()
                {
                    let content_items = take_output_items(scope);
                    send_result(
                        scope,
                        &event_tx,
                        RuntimeResponse::Terminated {
                            cell_id,
                            content_items,
                        },
                    );
                    done.store(true, Ordering::Release);
                    return;
                }
                let should_yield = scope
                    .get_slot::<RuntimeState>()
                    .map(|state| state.yield_requested)
                    .unwrap_or(false);
                let has_pending_tools = scope
                    .get_slot::<RuntimeState>()
                    .map(|state| !state.pending_tool_calls.is_empty())
                    .unwrap_or(false);
                if !should_yield && has_pending_tools {
                    match wait_for_tool_completion(scope, Duration::from_millis(20)) {
                        Ok(true) | Ok(false) => continue,
                        Err(error) => {
                            let content_items = take_output_items(scope);
                            send_result(
                                scope,
                                &event_tx,
                                RuntimeResponse::Result {
                                    cell_id: cell_id.clone(),
                                    content_items,
                                    error_text: Some(error),
                                },
                            );
                            done.store(true, Ordering::Release);
                            return;
                        }
                    }
                }
                let response = if should_yield {
                    RuntimeResponse::Yielded {
                        cell_id: cell_id.clone(),
                        content_items: take_output_items(scope),
                    }
                } else {
                    RuntimeResponse::Running {
                        cell_id: cell_id.clone(),
                        content_items: take_output_items(scope),
                    }
                };
                send_result(scope, &event_tx, response);
                if let Some(command) = next_command(&command_rx) {
                    match command {
                        CellCommand::Start => {}
                        CellCommand::Resume => {
                            if should_yield {
                                if let Err(error) = resume_yield(scope) {
                                    let content_items = take_output_items(scope);
                                    send_result(
                                        scope,
                                        &event_tx,
                                        RuntimeResponse::Result {
                                            cell_id: cell_id.clone(),
                                            content_items,
                                            error_text: Some(error),
                                        },
                                    );
                                    done.store(true, Ordering::Release);
                                    return;
                                }
                            }
                        }
                        CellCommand::Terminate => {
                            let content_items = take_output_items(scope);
                            send_result(
                                scope,
                                &event_tx,
                                RuntimeResponse::Terminated {
                                    cell_id,
                                    content_items,
                                },
                            );
                            done.store(true, Ordering::Release);
                            return;
                        }
                    }
                } else {
                    let content_items = take_output_items(scope);
                    send_result(
                        scope,
                        &event_tx,
                        RuntimeResponse::Unknown {
                            cell_id,
                            content_items,
                            reason: "Code Mode owner closed while the cell was running".into(),
                        },
                    );
                    done.store(true, Ordering::Release);
                    return;
                }
            }
        }
    }
}

fn apply_available_tool_completions(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String> {
    loop {
        let completion = scope
            .get_slot_mut::<RuntimeState>()
            .and_then(|state| state.tool_completion_rx.try_recv().ok());
        let Some(completion) = completion else {
            return Ok(());
        };
        apply_tool_completion(scope, completion)?;
    }
}

fn wait_for_tool_completion(
    scope: &mut v8::PinScope<'_, '_>,
    timeout: Duration,
) -> Result<bool, String> {
    let completion = scope
        .get_slot_mut::<RuntimeState>()
        .and_then(|state| state.tool_completion_rx.recv_timeout(timeout).ok());
    let Some(completion) = completion else {
        return Ok(false);
    };
    apply_tool_completion(scope, completion)?;
    Ok(true)
}

fn apply_tool_completion(
    scope: &mut v8::PinScope<'_, '_>,
    completion: super::ToolCompletion,
) -> Result<(), String> {
    let resolver = scope
        .get_slot_mut::<RuntimeState>()
        .and_then(|state| {
            state
                .pending_tool_calls
                .remove(&completion.runtime_tool_call_id)
        })
        .ok_or_else(|| {
            format!(
                "Code Mode tool Promise is unavailable: {}",
                completion.runtime_tool_call_id
            )
        })?;
    let resolver = v8::Local::new(scope, resolver);
    match completion.result {
        Ok(value) => {
            let value = crate::value::json_to_v8(scope, &value)?;
            if resolver.resolve(scope, value) != Some(true) {
                return Err("failed to resolve Code Mode tool Promise".into());
            }
        }
        Err(error) => {
            let message = v8::String::new(scope, &error)
                .ok_or_else(|| "failed to allocate Code Mode tool error".to_string())?;
            let exception = v8::Exception::error(scope, message);
            if resolver.reject(scope, exception) != Some(true) {
                return Err("failed to reject Code Mode tool Promise".into());
            }
        }
    }
    Ok(())
}

fn next_command(command_rx: &Receiver<CellCommand>) -> Option<CellCommand> {
    command_rx.recv().ok()
}

fn evaluate<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: &str,
) -> Result<v8::Global<v8::Promise>, String> {
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let mut tc = tc.init();
    let source = v8::String::new(&tc, source)
        .ok_or_else(|| "failed to allocate Code Mode source".to_string())?;
    let script = v8::Script::compile(&tc, source, None).ok_or_else(|| {
        tc.exception()
            .map(|exception| value_to_error_text(&mut tc, exception))
            .unwrap_or_else(|| "Code Mode JavaScript compilation failed".into())
    })?;
    let result = script.run(&tc).ok_or_else(|| {
        tc.exception()
            .map(|exception| value_to_error_text(&mut tc, exception))
            .unwrap_or_else(|| "Code Mode JavaScript execution failed".into())
    })?;
    v8::Local::<v8::Promise>::try_from(result)
        .map(|promise| v8::Global::new(&tc, promise))
        .map_err(|_| "Code Mode cell did not return a promise".into())
}

fn resume_yield(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String> {
    let resolver = scope
        .get_slot_mut::<RuntimeState>()
        .and_then(RuntimeState::take_yield_resolver)
        .ok_or_else(|| "Code Mode yield resolver is missing".to_string())?;
    let resume_result = {
        let tc = std::pin::pin!(v8::TryCatch::new(scope));
        let mut tc = tc.init();
        let resolver = v8::Local::new(&tc, resolver);
        let undefined = v8::undefined(&tc);
        resolver.resolve(&tc, undefined.into());
        if tc.has_caught() {
            Err(tc
                .exception()
                .map(|exception| value_to_error_text(&mut tc, exception))
                .unwrap_or_else(|| "failed to resume Code Mode cell".into()))
        } else {
            Ok(())
        }
    };
    resume_result?;
    if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
        state.yield_requested = false;
    }
    Ok(())
}

fn take_output_items(scope: &mut v8::PinScope<'_, '_>) -> Vec<OutputItem> {
    scope
        .get_slot_mut::<RuntimeState>()
        .map(RuntimeState::take_output_items)
        .unwrap_or_default()
}

fn result_response(
    scope: &mut v8::PinScope<'_, '_>,
    cell_id: CellId,
    error_text: Option<String>,
) -> RuntimeResponse {
    RuntimeResponse::Result {
        cell_id,
        content_items: take_output_items(scope),
        error_text,
    }
}

fn send_result(
    scope: &mut v8::PinScope<'_, '_>,
    event_tx: &Sender<CellEvent>,
    response: RuntimeResponse,
) {
    if !matches!(
        response,
        RuntimeResponse::Running { .. } | RuntimeResponse::Yielded { .. }
    ) {
        if let Some(state) = scope.get_slot::<RuntimeState>() {
            state.invoker.cancel_cell(&state.cell_id);
        }
    }
    let stored_value_writes = scope
        .get_slot_mut::<RuntimeState>()
        .map(|state| std::mem::take(&mut state.stored_value_writes))
        .unwrap_or_default();
    let _ = event_tx.send(CellEvent {
        response,
        stored_value_writes,
    });
}
