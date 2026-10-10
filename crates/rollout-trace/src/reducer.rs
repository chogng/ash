use crate::DiagnosticEventKind;
use crate::DiagnosticTrace;
use crate::PayloadRef;
use crate::PayloadStatus;
use crate::RolloutTrace;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadItem;
use ash_protocol::ToolActivity;
use ash_protocol::ToolCallCaller;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Rebuildable navigation objects; business state remains in the original event streams.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceNodeKind {
    Thread,
    ToolCall,
    CodeCell,
    TerminalOperation,
    RuntimeCall,
    ToolResult,
    AgentMessage,
    ModelAttempt,
    ModelInvocation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceEdgeKind {
    ChildThread,
    Owns,
    Executes,
    NestedTool,
    Result,
    DeliversMessage,
    Delegates,
    RequestsTool,
    Invokes,
    AccountsFor,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceNode {
    pub id: String,
    pub kind: TraceNodeKind,
    pub label: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub event_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEdge {
    pub from: String,
    pub to: String,
    pub kind: TraceEdgeKind,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceGraph {
    pub nodes: BTreeMap<String, TraceNode>,
    pub edges: Vec<TraceEdge>,
    /// Missing evidence is reported instead of being filled from current runtime state.
    pub warnings: Vec<String>,
}

/// Reduces verified durable identities and diagnostic response evidence into causal links.
/// Runtime tool results are never promoted to model-visible request content.
pub fn reduce_trace(
    trace: &RolloutTrace,
    diagnostics: &DiagnosticTrace,
    mut read_payload: impl FnMut(&PayloadRef) -> Result<Value, String>,
) -> TraceGraph {
    let mut graph = TraceGraph::default();
    let mut messages = BTreeMap::<String, (Option<String>, Option<String>)>::new();
    let mut invocations = BTreeMap::new();
    for thread in &trace.threads {
        let owner = format!("thread:{}", thread.thread_id);
        node(
            &mut graph,
            &owner,
            TraceNodeKind::Thread,
            thread.thread_id.as_str(),
            thread.thread_id.as_str(),
            None,
            None,
        );
        for record in &thread.events {
            let event_key = format!("{}:{}", thread.thread_id, record.sequence);
            if let ThreadEvent::ModelInvocationRecorded {
                turn_id,
                record: invocation,
                ..
            } = &record.event
            {
                let id = format!(
                    "invocation:{}:{}:{}",
                    thread.thread_id, turn_id, invocation.invocation_id
                );
                node(
                    &mut graph,
                    &id,
                    TraceNodeKind::ModelInvocation,
                    invocation.invocation_id.as_str(),
                    thread.thread_id.as_str(),
                    Some(turn_id.as_str()),
                    Some(&event_key),
                );
                edge(&mut graph, &owner, &id, TraceEdgeKind::Owns);
                let key = (
                    thread.thread_id.to_string(),
                    turn_id.to_string(),
                    invocation.invocation_id.to_string(),
                );
                match invocations.entry(key) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(Some((id, record.sequence)));
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        entry.insert(None);
                        graph.warnings.push(format!(
                            "duplicate model invocation identity: {}",
                            invocation.invocation_id
                        ));
                    }
                }
            }
            if let ThreadEvent::ThreadCreated { title, origin, .. } = &record.event {
                graph.nodes.get_mut(&owner).unwrap().label = title.clone();
                graph.nodes.get_mut(&owner).unwrap().event_key = Some(event_key.clone());
                let origin = serde_json::to_value(origin).unwrap_or(Value::Null);
                if let Some(parent) = origin.get("parentThreadId").and_then(Value::as_str) {
                    let parent_id = format!("thread:{parent}");
                    node(
                        &mut graph,
                        &parent_id,
                        TraceNodeKind::Thread,
                        parent,
                        parent,
                        None,
                        None,
                    );
                    edge(&mut graph, &parent_id, &owner, TraceEdgeKind::ChildThread);
                }
            }
            if let ThreadEvent::ItemCompleted { turn_id, item, .. } = &record.event {
                if let ThreadItem::ToolCall {
                    tool_call_id,
                    name,
                    binding,
                    ..
                } = item
                {
                    let call = call_key(
                        thread.thread_id.as_str(),
                        turn_id.as_str(),
                        tool_call_id.as_str(),
                    );
                    node(
                        &mut graph,
                        &call,
                        TraceNodeKind::ToolCall,
                        name.as_str(),
                        thread.thread_id.as_str(),
                        Some(turn_id.as_str()),
                        Some(&event_key),
                    );
                    edge(&mut graph, &owner, &call, TraceEdgeKind::Owns);
                    if let Some(binding) = binding {
                        if let ToolCallCaller::CodeMode {
                            parent_tool_call_id,
                            cell_id,
                            runtime_call_id,
                        } = &binding.caller
                        {
                            let parent = call_key(
                                thread.thread_id.as_str(),
                                turn_id.as_str(),
                                parent_tool_call_id.as_str(),
                            );
                            let cell = format!("cell:{}:{}:{cell_id}", thread.thread_id, turn_id);
                            let parent_event = graph
                                .nodes
                                .get(&parent)
                                .and_then(|node| node.event_key.clone());
                            node(
                                &mut graph,
                                &cell,
                                TraceNodeKind::CodeCell,
                                cell_id,
                                thread.thread_id.as_str(),
                                Some(turn_id.as_str()),
                                parent_event.as_deref(),
                            );
                            edge(&mut graph, &parent, &cell, TraceEdgeKind::Executes);
                            edge(&mut graph, &cell, &call, TraceEdgeKind::NestedTool);
                            let runtime = format!(
                                "runtime-call:{}:{}:{cell_id}:{runtime_call_id}",
                                thread.thread_id, turn_id
                            );
                            node(
                                &mut graph,
                                &runtime,
                                TraceNodeKind::RuntimeCall,
                                runtime_call_id,
                                thread.thread_id.as_str(),
                                Some(turn_id.as_str()),
                                Some(&event_key),
                            );
                            edge(&mut graph, &cell, &runtime, TraceEdgeKind::Invokes);
                            edge(&mut graph, &runtime, &call, TraceEdgeKind::Invokes);
                        }
                        if let Some(ToolActivity::Command {
                            program, arguments, ..
                        }) = &binding.activity
                        {
                            let operation = format!("terminal-operation:{call}");
                            let label = format!("{} {}", program, arguments.join(" "));
                            node(
                                &mut graph,
                                &operation,
                                TraceNodeKind::TerminalOperation,
                                &label,
                                thread.thread_id.as_str(),
                                Some(turn_id.as_str()),
                                Some(&event_key),
                            );
                            edge(&mut graph, &call, &operation, TraceEdgeKind::Executes);
                        }
                    }
                }
                if let ThreadItem::ToolResult {
                    tool_call_id,
                    is_error,
                    ..
                } = item
                {
                    let call = call_key(
                        thread.thread_id.as_str(),
                        turn_id.as_str(),
                        tool_call_id.as_str(),
                    );
                    let result = format!("result:{call}");
                    node(
                        &mut graph,
                        &result,
                        TraceNodeKind::ToolResult,
                        if *is_error { "failed" } else { "completed" },
                        thread.thread_id.as_str(),
                        Some(turn_id.as_str()),
                        Some(&event_key),
                    );
                    edge(&mut graph, &call, &result, TraceEdgeKind::Result);
                }
            }
            if let ThreadEvent::AgentMessageSent { message, .. } = &record.event {
                let id = format!("message-sent:{}", message.message_id);
                node(
                    &mut graph,
                    &id,
                    TraceNodeKind::AgentMessage,
                    message.message_id.as_str(),
                    thread.thread_id.as_str(),
                    None,
                    Some(&event_key),
                );
                messages
                    .entry(message.message_id.to_string())
                    .or_default()
                    .0 = Some(id);
            }
            if let ThreadEvent::AgentMessageReceived { message, .. } = &record.event {
                let id = format!("message-received:{}", message.message_id);
                node(
                    &mut graph,
                    &id,
                    TraceNodeKind::AgentMessage,
                    message.message_id.as_str(),
                    thread.thread_id.as_str(),
                    None,
                    Some(&event_key),
                );
                messages
                    .entry(message.message_id.to_string())
                    .or_default()
                    .1 = Some(id);
            }
            if let ThreadEvent::DelegationStarted {
                child_thread_id, ..
            } = &record.event
            {
                edge(
                    &mut graph,
                    &owner,
                    &format!("thread:{child_thread_id}"),
                    TraceEdgeKind::Delegates,
                );
            }
        }
    }
    for (_, (sender, receiver)) in messages {
        if let (Some(sender), Some(receiver)) = (sender, receiver) {
            edge(
                &mut graph,
                &sender,
                &receiver,
                TraceEdgeKind::DeliversMessage,
            );
        }
    }
    for record in &diagnostics.events {
        let id = format!(
            "attempt:{}:{}:{}",
            record.thread_id,
            record.turn_id.as_ref().map_or("", |turn| turn.as_str()),
            record.event.attempt_id()
        );
        let event_key = format!("diagnostic:{}", record.sequence);
        if let DiagnosticEventKind::ModelAttemptStarted { model, .. } = &record.event {
            let label = model.as_ref().map_or_else(
                || "configured model".into(),
                |model| format!("{}/{}", model.provider, model.model),
            );
            node(
                &mut graph,
                &id,
                TraceNodeKind::ModelAttempt,
                &label,
                record.thread_id.as_str(),
                record.turn_id.as_ref().map(|id| id.as_str()),
                Some(&event_key),
            );
            edge(
                &mut graph,
                &format!("thread:{}", record.thread_id),
                &id,
                TraceEdgeKind::Owns,
            );
        }
        if let DiagnosticEventKind::ModelAttemptCompleted {
            response_payload, ..
        } = &record.event
        {
            let Some(turn_id) = &record.turn_id else {
                continue;
            };
            if response_payload.status != PayloadStatus::Saved {
                graph.warnings.push(format!(
                    "response evidence omitted: {}",
                    response_payload.payload_id
                ));
                continue;
            }
            match read_payload(response_payload) {
                Ok(response) => {
                    for item in response
                        .get("output")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if item.get("type").and_then(Value::as_str) != Some("toolCall") {
                            continue;
                        }
                        if let Some(call_id) = item
                            .get("value")
                            .and_then(|call| call.get("id"))
                            .and_then(Value::as_str)
                        {
                            let target =
                                call_key(record.thread_id.as_str(), turn_id.as_str(), call_id);
                            if graph.nodes.contains_key(&target) {
                                edge(&mut graph, &id, &target, TraceEdgeKind::RequestsTool);
                            }
                        }
                    }
                }
                Err(error) => graph.warnings.push(error),
            }
        }
        if let DiagnosticEventKind::ModelAttemptAccounted {
            invocation_id,
            source_thread_sequence,
            ..
        } = &record.event
        {
            let key = (
                record.thread_id.to_string(),
                record
                    .turn_id
                    .as_ref()
                    .map_or_else(String::new, ToString::to_string),
                invocation_id.to_string(),
            );
            match invocations.get(&key) {
                Some(Some((target, sequence))) if sequence == source_thread_sequence => {
                    edge(&mut graph, &id, target, TraceEdgeKind::AccountsFor)
                }
                _ => graph.warnings.push(format!(
                    "missing committed model invocation: {}:{}:{} at {}",
                    record.thread_id, key.1, invocation_id, source_thread_sequence
                )),
            }
        }
    }
    // A partial capture may reference a call not present in retained history. Preserve that
    // absence as a warning; never invent an executable object or silently attach another call.
    graph.edges.retain(|edge| {
        let present = graph.nodes.contains_key(&edge.from) && graph.nodes.contains_key(&edge.to);
        if !present {
            graph.warnings.push(format!(
                "missing graph endpoint: {} -> {}",
                edge.from, edge.to
            ));
        }
        present
    });
    graph
}

fn call_key(thread: &str, turn: &str, call: &str) -> String {
    format!("tool:{thread}:{turn}:{call}")
}
fn node(
    graph: &mut TraceGraph,
    id: &str,
    kind: TraceNodeKind,
    label: &str,
    thread: &str,
    turn: Option<&str>,
    event: Option<&str>,
) {
    graph.nodes.entry(id.into()).or_insert_with(|| TraceNode {
        id: id.into(),
        kind,
        label: label.into(),
        thread_id: thread.into(),
        turn_id: turn.map(str::to_owned),
        event_key: event.map(str::to_owned),
    });
}
fn edge(graph: &mut TraceGraph, from: &str, to: &str, kind: TraceEdgeKind) {
    let edge = TraceEdge {
        from: from.into(),
        to: to.into(),
        kind,
    };
    if !graph.edges.contains(&edge) {
        graph.edges.push(edge);
    }
}
