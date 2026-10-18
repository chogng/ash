//! Serial DAP replacement and binding ownership. Client edit versions fence
//! reordered RPCs; intent equality fences delayed adapter replies and events.
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;

use ash_debug_client::DebugClient;
use ash_debug_client::DebugClientError;
use ash_debug_client::DebugResponse;
use ash_debug_contract::DebugBreakpointBinding;
use ash_debug_contract::DebugBreakpointIntent;
use ash_debug_contract::DebugBreakpointLocation;
use ash_debug_contract::DebugBreakpointUnsupported;
use ash_debug_contract::DebugBreakpointsSnapshot;
use ash_debug_contract::DebugSourceAddress;
use serde_json::Value;
use serde_json::json;

use crate::DebugCapabilities;

const MAX_POINTS: usize = 512;
const MAX_INTENT_BYTES: usize = 1024 * 1024;

struct Replacement {
    command: &'static str,
    source: Option<DebugSourceAddress>,
    points: Vec<DebugBreakpointIntent>,
}

struct Pending {
    id: u64,
    version: u64,
    replacement: Replacement,
}

pub(super) struct Breakpoints {
    snapshot: DebugBreakpointsSnapshot,
    pending: Option<Pending>,
    plan: VecDeque<Replacement>,
    sources: BTreeMap<String, DebugSourceAddress>,
    dirty: bool,
    next_adapter_point: u64,
}

impl Breakpoints {
    pub fn new() -> Self {
        Self {
            snapshot: DebugBreakpointsSnapshot {
                revision: 0,
                version: 0,
                applied_version: 0,
                bindings: Vec::new(),
                error: None,
            },
            pending: None,
            plan: VecDeque::new(),
            sources: BTreeMap::new(),
            dirty: false,
            next_adapter_point: 0,
        }
    }

    pub fn replace(
        &mut self,
        version: u64,
        intents: Vec<DebugBreakpointIntent>,
    ) -> Result<(), DebugClientError> {
        validate(&intents)?;
        if version == 0 || version > 9_007_199_254_740_991 {
            return Err(DebugClientError::InvalidMessage);
        }
        // RPC workers may acquire a session in a different order from edits.
        // A newer desired version is never replaced by a late older call.
        if version < self.snapshot.version {
            return Ok(());
        }
        if version == self.snapshot.version {
            return if self
                .snapshot
                .bindings
                .iter()
                .filter(|point| !point.removed)
                .map(|point| &point.intent)
                .eq(intents.iter())
            {
                Ok(())
            } else {
                Err(DebugClientError::InvalidMessage)
            };
        }
        let old: HashMap<_, _> = std::mem::take(&mut self.snapshot.bindings)
            .into_iter()
            .map(|point| (point.intent.id.clone(), point))
            .collect();
        self.snapshot.bindings = intents
            .into_iter()
            .map(|intent| {
                old.get(&intent.id)
                    .filter(|old| old.intent == intent && !old.removed)
                    .cloned()
                    .map(|mut point| {
                        point.created = false;
                        point
                    })
                    .unwrap_or(DebugBreakpointBinding {
                        intent,
                        verified: false,
                        applicable: true,
                        pending: true,
                        removed: false,
                        created: false,
                        unsupported: None,
                        message: None,
                        protocol: None,
                    })
            })
            .collect();
        self.snapshot.version = version;
        self.snapshot.error = None;
        self.snapshot.revision += 1;
        self.plan.clear();
        self.dirty = true;
        Ok(())
    }

    pub fn snapshot(&self) -> DebugBreakpointsSnapshot {
        self.snapshot.clone()
    }
    pub fn revision(&self) -> u64 {
        self.snapshot.revision
    }

    pub fn progress(
        &mut self,
        client: &mut DebugClient,
        capabilities: &DebugCapabilities,
        session_id: &str,
        adapter_type: &str,
        no_debug: bool,
        ready: bool,
    ) -> Result<Vec<Value>, DebugClientError> {
        let changed = self.dirty || self.pending.is_some();
        if let Some(pending) = self.pending.take() {
            match client.response(pending.id)? {
                DebugResponse::Pending => {
                    self.pending = Some(pending);
                    return Ok(Vec::new());
                }
                DebugResponse::Complete(response) if response["success"] == true => {
                    {
                        let values = response["body"]["breakpoints"].as_array();
                        for (index, requested) in pending.replacement.points.iter().enumerate() {
                            if let Some(current) = self
                                .snapshot
                                .bindings
                                .iter_mut()
                                .find(|point| !point.removed && point.intent == *requested)
                            {
                                let protocol = values
                                    .and_then(|values| values.get(index))
                                    .filter(|value| value.is_object())
                                    .cloned();
                                current.verified = protocol
                                    .as_ref()
                                    .is_some_and(|value| value["verified"] == true);
                                current.message = protocol
                                    .as_ref()
                                    .and_then(|value| value["message"].as_str().map(str::to_owned));
                                current.protocol = protocol;
                                current.pending = false;
                            }
                        }
                    }
                    if pending.replacement.points.is_empty() {
                        if let Some(source) = &pending.replacement.source {
                            self.sources.remove(&source_key(source));
                        }
                    }
                    self.snapshot.revision += 1;
                }
                response => {
                    if pending.version == self.snapshot.version {
                        self.snapshot.error = Some(match response {
                            DebugResponse::Complete(value) => value["message"]
                                .as_str()
                                .unwrap_or("Debug Adapter rejected breakpoint replacement")
                                .to_owned(),
                            DebugResponse::Failed(message) => message,
                            DebugResponse::Pending => unreachable!(),
                        });
                        self.snapshot.applied_version = pending.version;
                        self.snapshot.revision += 1;
                        self.plan.clear();
                        self.dirty = false;
                        return Ok(Vec::new());
                    }
                }
            }
        }
        if !ready {
            return Ok(Vec::new());
        }
        if self.dirty {
            self.plan.clear();
            let mut groups: BTreeMap<String, (DebugSourceAddress, Vec<DebugBreakpointIntent>)> =
                BTreeMap::new();
            let mut families: BTreeMap<&str, Vec<DebugBreakpointIntent>> = BTreeMap::new();
            for point in &mut self.snapshot.bindings {
                if point.removed {
                    continue;
                }
                let applies = match &point.intent.location {
                    DebugBreakpointLocation::Source { .. }
                    | DebugBreakpointLocation::Function { .. } => true,
                    DebugBreakpointLocation::Data {
                        can_persist,
                        adapter_type: target,
                        session_id: origin,
                        ..
                    } => {
                        if *can_persist {
                            target == adapter_type
                        } else {
                            origin.as_deref() == Some(session_id)
                        }
                    }
                    DebugBreakpointLocation::Instruction {
                        session_id: origin, ..
                    } => origin == session_id,
                };
                point.applicable = applies && !no_debug;
                if !point.intent.enabled || no_debug || !applies {
                    point.pending = false;
                    point.protocol = None;
                    point.verified = false;
                    point.unsupported = None;
                    point.message = None;
                    continue;
                }
                if let DebugBreakpointLocation::Source { source, .. } = &point.intent.location {
                    groups
                        .entry(source_key(source))
                        .or_insert_with(|| (source.clone(), Vec::new()));
                }
                point.unsupported = unsupported(&point.intent, capabilities);
                if point.unsupported.is_some() {
                    point.pending = false;
                    point.protocol = None;
                    point.verified = false;
                    point.message = None;
                    continue;
                }
                point.pending = true;
                match &point.intent.location {
                    DebugBreakpointLocation::Source { source, .. } => groups
                        .get_mut(&source_key(source))
                        .unwrap()
                        .1
                        .push(point.intent.clone()),
                    DebugBreakpointLocation::Function { .. } => families
                        .entry("setFunctionBreakpoints")
                        .or_default()
                        .push(point.intent.clone()),
                    DebugBreakpointLocation::Data { .. } => families
                        .entry("setDataBreakpoints")
                        .or_default()
                        .push(point.intent.clone()),
                    DebugBreakpointLocation::Instruction { .. } => families
                        .entry("setInstructionBreakpoints")
                        .or_default()
                        .push(point.intent.clone()),
                }
            }
            for (key, source) in &self.sources {
                groups
                    .entry(key.clone())
                    .or_insert_with(|| (source.clone(), Vec::new()));
            }
            self.plan
                .extend(groups.into_values().map(|(source, points)| Replacement {
                    command: "setBreakpoints",
                    source: Some(source),
                    points,
                }));
            for (command, supported) in [
                (
                    "setFunctionBreakpoints",
                    capabilities.supports_function_breakpoints,
                ),
                ("setDataBreakpoints", capabilities.supports_data_breakpoints),
                (
                    "setInstructionBreakpoints",
                    capabilities.supports_instruction_breakpoints,
                ),
            ] {
                if supported && !no_debug {
                    self.plan.push_back(Replacement {
                        command,
                        source: None,
                        points: families.remove(command).unwrap_or_default(),
                    });
                }
            }
            self.dirty = false;
            self.snapshot.revision += 1;
        }
        if changed
            && serde_json::to_vec(&self.snapshot)
                .map_or(true, |bytes| bytes.len() > 2 * MAX_INTENT_BYTES)
        {
            return Err(DebugClientError::Capacity);
        }
        if let Some(replacement) = self.plan.pop_front() {
            let mut arguments =
                json!({"breakpoints":replacement.points.iter().map(arguments).collect::<Vec<_>>()});
            if let Some(source) = &replacement.source {
                arguments["source"] =
                    serde_json::to_value(source).map_err(|_| DebugClientError::InvalidMessage)?;
                if !replacement.points.is_empty() {
                    self.sources.insert(source_key(source), source.clone());
                }
            }
            let (id, message) = client.request(replacement.command, Some(arguments))?;
            self.pending = Some(Pending {
                id,
                version: self.snapshot.version,
                replacement,
            });
            return Ok(vec![message]);
        }
        if self.snapshot.applied_version != self.snapshot.version {
            self.snapshot.applied_version = self.snapshot.version;
            self.snapshot.revision += 1;
        }
        Ok(Vec::new())
    }

    pub fn accept(&mut self, message: &Value, session_id: &str) -> Result<(), DebugClientError> {
        if message["type"] != "event" || message["event"] != "breakpoint" {
            return Ok(());
        }
        let body = &message["body"];
        let reason = body["reason"].as_str().unwrap_or("");
        if !matches!(reason, "new" | "changed" | "removed") {
            return Ok(());
        }
        let protocol = &body["breakpoint"];
        if !protocol.is_object() {
            return Err(DebugClientError::InvalidMessage);
        }
        let protocol_id = protocol.get("id");
        if protocol_id.is_some_and(|id| {
            id.as_i64()
                .is_none_or(|id| !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&id))
        }) {
            return Err(DebugClientError::InvalidMessage);
        }
        let mut matched = false;
        let mut removed_sources = Vec::new();
        for point in &mut self.snapshot.bindings {
            if !point.intent.enabled
                || point.removed
                || protocol_id.is_none()
                || point.protocol.as_ref().and_then(|point| point.get("id")) != protocol_id
            {
                continue;
            }
            matched = true;
            point.pending = false;
            if reason == "removed" {
                if let DebugBreakpointLocation::Source { source, .. } = &point.intent.location {
                    removed_sources.push(source_key(source));
                }
                point.removed = true;
                point.protocol = None;
                point.verified = false;
            } else {
                point.protocol = Some(protocol.clone());
                point.verified = protocol["verified"] == true;
                point.message = protocol["message"].as_str().map(str::to_owned);
            }
        }
        for key in removed_sources {
            if !self.snapshot.bindings.iter().any(|point| !point.removed && matches!(&point.intent.location, DebugBreakpointLocation::Source { source, .. } if source_key(source) == key)) { self.sources.remove(&key); }
        }
        if !matched && reason == "new" {
            let source = &protocol["source"];
            let path = source["path"].as_str().map(str::to_owned);
            let reference = source["sourceReference"]
                .as_u64()
                .filter(|reference| *reference > 0 && *reference <= 9_007_199_254_740_991);
            let line = protocol["line"]
                .as_u64()
                .and_then(|line| u32::try_from(line).ok())
                .filter(|line| *line > 0);
            if (path.is_some() || reference.is_some()) && line.is_some() {
                if self.snapshot.bindings.len() >= MAX_POINTS {
                    return Err(DebugClientError::Capacity);
                }
                let column = protocol["column"]
                    .as_u64()
                    .and_then(|column| u32::try_from(column).ok())
                    .filter(|column| *column > 0);
                let location = DebugBreakpointLocation::Source {
                    source: DebugSourceAddress {
                        path,
                        source_reference: reference,
                    },
                    line: line.unwrap(),
                    column,
                };
                if let Some(point) = self.snapshot.bindings.iter_mut().find(|point| {
                    point.intent.location == location && point.intent.enabled && !point.removed
                }) {
                    point.pending = false;
                    point.protocol = Some(protocol.clone());
                    point.verified = protocol["verified"] == true;
                } else {
                    self.next_adapter_point += 1;
                    self.snapshot.bindings.push(DebugBreakpointBinding {
                        intent: DebugBreakpointIntent {
                            id: format!(
                                "{session_id}:adapter-breakpoint-{}",
                                self.next_adapter_point
                            ),
                            enabled: true,
                            location: location.clone(),
                            condition: None,
                            hit_condition: None,
                            log_message: None,
                        },
                        created: true,
                        removed: false,
                        verified: protocol["verified"] == true,
                        applicable: true,
                        pending: false,
                        unsupported: None,
                        message: protocol["message"].as_str().map(str::to_owned),
                        protocol: Some(protocol.clone()),
                    });
                }
                if let DebugBreakpointLocation::Source { source, .. } = location {
                    self.sources.insert(source_key(&source), source);
                }
            }
        }
        self.snapshot.revision += 1;
        if serde_json::to_vec(&self.snapshot)
            .map_or(true, |bytes| bytes.len() > 2 * MAX_INTENT_BYTES)
        {
            return Err(DebugClientError::Capacity);
        }
        Ok(())
    }
}

fn source_key(source: &DebugSourceAddress) -> String {
    serde_json::to_string(source).expect("source serialization")
}

fn unsupported(
    point: &DebugBreakpointIntent,
    capabilities: &DebugCapabilities,
) -> Option<DebugBreakpointUnsupported> {
    if point
        .condition
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        && !capabilities.supports_conditional_breakpoints
    {
        return Some(DebugBreakpointUnsupported::Conditional);
    }
    if point
        .hit_condition
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        && !capabilities.supports_hit_conditional_breakpoints
    {
        return Some(DebugBreakpointUnsupported::HitConditional);
    }
    if point
        .log_message
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        && !capabilities.supports_log_points
    {
        return Some(DebugBreakpointUnsupported::LogPoint);
    }
    match point.location {
        DebugBreakpointLocation::Source { .. } => None,
        DebugBreakpointLocation::Function { .. } => (!capabilities.supports_function_breakpoints)
            .then_some(DebugBreakpointUnsupported::Function),
        DebugBreakpointLocation::Data { .. } => {
            (!capabilities.supports_data_breakpoints).then_some(DebugBreakpointUnsupported::Data)
        }
        DebugBreakpointLocation::Instruction { .. } => (!capabilities
            .supports_instruction_breakpoints)
            .then_some(DebugBreakpointUnsupported::Instruction),
    }
}

fn arguments(point: &DebugBreakpointIntent) -> Value {
    let mut value = match &point.location {
        DebugBreakpointLocation::Source { line, column, .. } => {
            let mut value = json!({"line":line});
            if let Some(column) = column {
                value["column"] = json!(column);
            }
            value
        }
        DebugBreakpointLocation::Function { name } => json!({"name":name}),
        DebugBreakpointLocation::Data {
            data_id,
            access_type,
            ..
        } => json!({"dataId":data_id,"accessType":access_type}),
        DebugBreakpointLocation::Instruction {
            instruction_reference,
            offset,
            ..
        } => {
            let mut value = json!({"instructionReference":instruction_reference});
            if let Some(offset) = offset {
                value["offset"] = json!(offset);
            }
            value
        }
    };
    for (name, field) in [
        ("condition", &point.condition),
        ("hitCondition", &point.hit_condition),
        ("logMessage", &point.log_message),
    ] {
        if let Some(field) = field {
            value[name] = json!(field);
        }
    }
    value
}

fn validate(points: &[DebugBreakpointIntent]) -> Result<(), DebugClientError> {
    if points.len() > MAX_POINTS
        || serde_json::to_vec(points)
            .map_err(|_| DebugClientError::InvalidMessage)?
            .len()
            > MAX_INTENT_BYTES
    {
        return Err(DebugClientError::Capacity);
    }
    let mut ids = HashSet::new();
    let text = |value: &str| !value.is_empty() && value.len() <= 32768 && !value.contains('\0');
    for point in points {
        if !text(&point.id)
            || !ids.insert(&point.id)
            || [&point.condition, &point.hit_condition, &point.log_message]
                .into_iter()
                .flatten()
                .any(|field| field.len() > 32768 || field.contains('\0'))
        {
            return Err(DebugClientError::InvalidMessage);
        }
        let valid = match &point.location {
            DebugBreakpointLocation::Source {
                source,
                line,
                column,
            } => {
                *line > 0
                    && column.is_none_or(|column| column > 0)
                    && (source.path.as_deref().is_some_and(text)
                        || source.source_reference.is_some_and(|reference| {
                            reference > 0 && reference <= 9_007_199_254_740_991
                        }))
            }
            DebugBreakpointLocation::Function { name } => text(name),
            DebugBreakpointLocation::Data {
                data_id,
                adapter_type,
                can_persist,
                session_id,
                ..
            } => {
                text(data_id)
                    && text(adapter_type)
                    && (*can_persist || session_id.as_deref().is_some_and(text))
            }
            DebugBreakpointLocation::Instruction {
                instruction_reference,
                session_id,
                offset,
            } => {
                text(instruction_reference)
                    && text(session_id)
                    && offset.is_none_or(|offset| {
                        (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&offset)
                    })
            }
        };
        if !valid {
            return Err(DebugClientError::InvalidMessage);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "breakpoints_tests.rs"]
mod tests;
