//! Session semantics independent of the transport and Workbench. Progress is
//! driven by incoming pages and reads, so reverse host requests never hold a
//! synchronous RPC waiting for initialization or a launch response.
use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use ash_debug_client::DebugClient;
use ash_debug_client::DebugClientError;
use ash_debug_client::DebugResponse;
use serde_json::Value;
use serde_json::json;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DebugExecutionState {
    Starting,
    Running,
    Stopped,
    Terminated,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DebugInitializationPhase {
    Uninitialized,
    Initializing,
    AwaitingInitialized,
    Configuring,
    Launching,
    Active,
    Ended,
}

#[derive(Clone, Debug, Default)]
pub struct DebugExceptionFilter {
    pub filter: String,
    pub label: String,
    pub description: Option<String>,
    pub default: bool,
}

#[derive(Clone, Debug, Default)]
pub struct DebugCapabilities {
    pub supports_restart: bool,
    pub supports_terminate: bool,
    pub supports_set_variable: bool,
    pub supports_conditional_breakpoints: bool,
    pub supports_hit_conditional_breakpoints: bool,
    pub supports_log_points: bool,
    pub supports_function_breakpoints: bool,
    pub supports_data_breakpoints: bool,
    pub supports_instruction_breakpoints: bool,
    pub supports_disassemble_request: bool,
    pub supports_read_memory_request: bool,
    pub supports_write_memory_request: bool,
    pub supports_loaded_sources_request: bool,
    pub supports_exception_info_request: bool,
    pub supports_stepping_granularity: bool,
    pub supports_completions_request: bool,
    pub supports_cancel_request: bool,
    pub completion_trigger_characters: Vec<String>,
    pub exception_breakpoint_filters: Vec<DebugExceptionFilter>,
}

#[derive(Clone, Debug)]
pub struct DebugSessionSnapshot {
    pub revision: u64,
    pub execution_revision: u64,
    pub inspection_revision: u64,
    pub state: DebugExecutionState,
    pub phase: DebugInitializationPhase,
    pub reason: Option<String>,
    pub stopped_thread_id: Option<i64>,
    pub capabilities: DebugCapabilities,
}

#[derive(Clone, Copy, Debug)]
pub enum DebugLaunchRequest {
    Launch,
    Attach,
}

pub struct DebugInitialize {
    pub adapter_id: String,
    pub request: DebugLaunchRequest,
    pub arguments: serde_json::Map<String, Value>,
    pub run_in_terminal: bool,
    pub start_debugging: bool,
}

pub(super) struct Lifecycle {
    pub snapshot: DebugSessionSnapshot,
    capabilities: serde_json::Map<String, Value>,
    launch: Option<DebugInitialize>,
    initialize_request: Option<u64>,
    launch_request: Option<u64>,
    configuration_request: Option<u64>,
    exception_request: Option<(u64, u64, Vec<String>)>,
    pub exceptions: ash_debug_contract::DebugExceptionsSnapshot,
    inspections: HashMap<u64, u64>,
    initialized: bool,
    configured: bool,
    no_debug: bool,
    initialized_deadline: Option<Instant>,
    execution_requests: HashMap<u64, (String, u64)>,
    disconnect_sent: bool,
}

impl Lifecycle {
    pub fn new() -> Self {
        Self {
            snapshot: DebugSessionSnapshot {
                revision: 0,
                execution_revision: 0,
                inspection_revision: 0,
                state: DebugExecutionState::Starting,
                phase: DebugInitializationPhase::Uninitialized,
                reason: None,
                stopped_thread_id: None,
                capabilities: DebugCapabilities::default(),
            },
            capabilities: Default::default(),
            launch: None,
            initialize_request: None,
            launch_request: None,
            configuration_request: None,
            initialized: false,
            configured: false,
            no_debug: false,
            initialized_deadline: None,
            execution_requests: HashMap::new(),
            disconnect_sent: false,
            exception_request: None,
            exceptions: Default::default(),
            inspections: HashMap::new(),
        }
    }

    pub fn begin(
        &mut self,
        client: &mut DebugClient,
        options: DebugInitialize,
    ) -> Result<Value, DebugClientError> {
        if self.snapshot.phase != DebugInitializationPhase::Uninitialized || self.ended() {
            return Err(DebugClientError::InvalidMessage);
        }
        let (id, message) = client.request("initialize", Some(json!({
            "clientID":"ash", "clientName":"Ash Code", "adapterID":options.adapter_id,
            "pathFormat":"path", "linesStartAt1":true, "columnsStartAt1":true,
            "supportsVariableType":true, "supportsVariablePaging":true, "supportsMemoryReferences":true,
            "supportsProgressReporting":true,
            "supportsRunInTerminalRequest":options.run_in_terminal,
            "supportsArgsCanBeInterpretedByShell":options.run_in_terminal,
            "supportsStartDebuggingRequest":options.start_debugging
        })))?;
        self.no_debug = options.arguments.get("noDebug") == Some(&Value::Bool(true));
        self.initialize_request = Some(id);
        self.launch = Some(options);
        self.phase(DebugInitializationPhase::Initializing);
        Ok(message)
    }

    pub fn configure(
        &mut self,
        client: &mut DebugClient,
        filters: Option<Vec<String>>,
    ) -> Result<Value, DebugClientError> {
        if self.snapshot.phase != DebugInitializationPhase::Configuring {
            return Err(DebugClientError::InvalidMessage);
        }
        self.select_exceptions(filters)?;
        let message = self.send_exceptions(client)?;
        self.phase(DebugInitializationPhase::Launching);
        Ok(message)
    }

    pub fn set_exceptions(&mut self, filters: Vec<String>) -> Result<u64, DebugClientError> {
        if self.snapshot.phase != DebugInitializationPhase::Active {
            return Err(DebugClientError::InvalidMessage);
        }
        self.select_exceptions(Some(filters))?;
        Ok(self.exceptions.version)
    }

    fn select_exceptions(&mut self, filters: Option<Vec<String>>) -> Result<(), DebugClientError> {
        let supported = &self.snapshot.capabilities.exception_breakpoint_filters;
        let filters = filters.unwrap_or_else(|| {
            supported
                .iter()
                .filter(|filter| filter.default)
                .map(|filter| filter.filter.clone())
                .collect()
        });
        if filters.len() > 256
            || filters
                .iter()
                .any(|filter| filter.len() > 256 || filter.contains('\0'))
        {
            return Err(DebugClientError::InvalidMessage);
        }
        let mut selected = Vec::new();
        for filter in filters {
            let filter = filter.trim();
            if filter.is_empty() {
                continue;
            }
            if !self.no_debug && !supported.iter().any(|candidate| candidate.filter == filter) {
                return Err(DebugClientError::InvalidMessage);
            }
            if !selected.iter().any(|candidate| candidate == filter) {
                selected.push(filter.to_owned());
            }
        }
        self.exceptions.version += 1;
        self.exceptions.filters = selected;
        self.exceptions.error = None;
        Ok(())
    }

    fn send_exceptions(&mut self, client: &mut DebugClient) -> Result<Value, DebugClientError> {
        let (id, message) = client.request(
            "setExceptionBreakpoints",
            Some(json!({"filters": if self.no_debug { Vec::<String>::new() } else { self.exceptions.filters.clone() }})),
        )?;
        self.exception_request =
            Some((id, self.exceptions.version, self.exceptions.filters.clone()));
        Ok(message)
    }

    pub fn requested(&mut self, id: u64, command: &str) {
        if command == "disconnect" {
            self.disconnect_sent = true;
        }
        if matches!(
            command,
            "stackTrace"
                | "scopes"
                | "variables"
                | "setVariable"
                | "completions"
                | "readMemory"
                | "writeMemory"
                | "exceptionInfo"
        ) {
            self.inspections
                .insert(id, self.snapshot.inspection_revision);
        }
        if matches!(
            command,
            "continue" | "next" | "stepIn" | "stepOut" | "restart" | "disconnect" | "terminate"
        ) {
            self.execution_requests
                .insert(id, (command.to_owned(), self.snapshot.execution_revision));
        }
    }

    /// DAP `terminated` ends debugging, but the client must still release the
    /// adapter with `disconnect`. A multiplexing adapter can await this child
    /// acknowledgement before answering its parent's disconnect request.
    pub fn disconnect_after_termination(
        &mut self,
        client: &mut DebugClient,
    ) -> Result<Option<Value>, DebugClientError> {
        if self.disconnect_sent {
            return Ok(None);
        }
        let mut arguments = json!({"restart": false});
        if self.snapshot.capabilities.supports_terminate {
            // Termination can also mean detaching from a borrowed runtime.
            arguments["terminateDebuggee"] = json!(false);
        }
        let (id, message) = client.request("disconnect", Some(arguments))?;
        self.requested(id, "disconnect");
        Ok(Some(message))
    }

    pub fn response(&mut self, id: u64, response: DebugResponse) -> DebugResponse {
        if matches!(response, DebugResponse::Pending) {
            return response;
        }
        self.execution_requests.remove(&id);
        if self
            .inspections
            .remove(&id)
            .is_some_and(|revision| revision != self.snapshot.inspection_revision)
        {
            return DebugResponse::Failed(
                "Debug inspection was invalidated by execution".to_owned(),
            );
        }
        response
    }

    pub fn allows(&self, command: &str, arguments: &Option<Value>) -> bool {
        if self.ended() {
            return false;
        }
        if matches!(
            command,
            "setExceptionBreakpoints"
                | "setBreakpoints"
                | "setFunctionBreakpoints"
                | "setDataBreakpoints"
                | "setInstructionBreakpoints"
        ) {
            return false;
        }
        if self.snapshot.phase == DebugInitializationPhase::Uninitialized {
            return true;
        }
        let capabilities = &self.snapshot.capabilities;
        match command {
            "initialize" | "launch" | "attach" | "configurationDone" => false,
            "restart" => capabilities.supports_restart,
            "setVariable" => {
                capabilities.supports_set_variable
                    && self.snapshot.state == DebugExecutionState::Stopped
            }
            "disassemble" => capabilities.supports_disassemble_request,
            "loadedSources" => capabilities.supports_loaded_sources_request,
            "exceptionInfo" => {
                capabilities.supports_exception_info_request
                    && self.snapshot.state == DebugExecutionState::Stopped
                    && arguments
                        .as_ref()
                        .and_then(|args| args.get("threadId"))
                        .and_then(Value::as_i64)
                        .is_some()
            }
            "readMemory" | "writeMemory" => {
                let Some(args) = arguments.as_ref() else {
                    return false;
                };
                let reference = args.get("memoryReference").and_then(Value::as_str);
                let location = reference.is_some_and(|value| {
                    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
                }) && args
                    .get("offset")
                    .is_none_or(|value| value.as_i64().is_some());
                location
                    && self.snapshot.state == DebugExecutionState::Stopped
                    && if command == "readMemory" {
                        capabilities.supports_read_memory_request
                            && args
                                .get("count")
                                .and_then(Value::as_u64)
                                .is_some_and(|value| (1..=4096).contains(&value))
                    } else {
                        capabilities.supports_write_memory_request
                            && args
                                .get("data")
                                .and_then(Value::as_str)
                                .is_some_and(valid_memory_data)
                    }
            }
            "completions" => capabilities.supports_completions_request,
            "cancel" => capabilities.supports_cancel_request,
            "dataBreakpointInfo" => capabilities.supports_data_breakpoints,
            "next" | "stepIn" | "stepOut" => {
                arguments
                    .as_ref()
                    .is_none_or(|value| value.get("granularity").is_none())
                    || capabilities.supports_stepping_granularity
            }
            _ => true,
        }
    }

    pub fn accept(&mut self, message: &Value) -> Result<(), DebugClientError> {
        if self.ended() {
            return Ok(());
        }
        if message["type"] == "response" {
            if let Some((command, revision)) = message["request_seq"]
                .as_u64()
                .and_then(|id| self.execution_requests.remove(&id))
            {
                if message["success"] == true {
                    if matches!(command.as_str(), "disconnect" | "terminate") {
                        self.end(None);
                    }
                    // A stopped/continued event after the request wins over its
                    // delayed response. Never undo a newly reached breakpoint.
                    else if revision == self.snapshot.execution_revision {
                        self.execution(DebugExecutionState::Running, None, None);
                    }
                }
            }
            return Ok(());
        }
        if message["type"] != "event" {
            return Ok(());
        }
        let body = &message["body"];
        match message["event"].as_str() {
            Some("initialized") => {
                self.initialized = true;
            }
            Some("stopped") => self.execution(
                DebugExecutionState::Stopped,
                Some(body["reason"].as_str().unwrap_or("paused").to_owned()),
                body["threadId"]
                    .as_i64()
                    .filter(|id| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(id)),
            ),
            Some("invalidated") => {
                self.snapshot.inspection_revision += 1;
                self.snapshot.revision += 1;
            }
            Some("continued") => self.execution(DebugExecutionState::Running, None, None),
            Some("terminated") => self.end(None),
            Some("capabilities") => self.merge_capabilities(&body["capabilities"])?,
            _ => {}
        }
        Ok(())
    }

    /// Consume internal completions without requiring a view to observe them.
    /// Messages returned here must be sent by the owning manager under its lock.
    pub fn progress(&mut self, client: &mut DebugClient) -> Result<Vec<Value>, DebugClientError> {
        if self.ended() {
            return Ok(Vec::new());
        }
        let mut outgoing = Vec::new();
        if let Some(id) = self.initialize_request {
            if let Some(response) = self.completed(client, id)? {
                self.initialize_request = None;
                self.merge_capabilities(&response["body"])?;
                let launch = self.launch.take().ok_or(DebugClientError::InvalidMessage)?;
                let command = match launch.request {
                    DebugLaunchRequest::Launch => "launch",
                    DebugLaunchRequest::Attach => "attach",
                };
                let (id, message) =
                    client.request(command, Some(Value::Object(launch.arguments)))?;
                self.launch_request = Some(id);
                self.initialized_deadline = Some(Instant::now() + Duration::from_secs(15));
                self.phase(DebugInitializationPhase::AwaitingInitialized);
                outgoing.push(message);
            }
        }
        if let Some(id) = self.launch_request {
            if self.completed(client, id)?.is_some() {
                self.launch_request = None;
            }
        }
        if self.ended() {
            return Ok(outgoing);
        }
        if self.snapshot.phase == DebugInitializationPhase::AwaitingInitialized {
            if self.initialized {
                self.initialized_deadline = None;
                self.phase(DebugInitializationPhase::Configuring);
            } else if self
                .initialized_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                self.fail("Debug Adapter did not emit the initialized event");
            }
        }
        if let Some((id, version, _)) = self.exception_request.as_ref() {
            let (id, version) = (*id, *version);
            // A live rejection belongs to this edit, not to the session lifecycle.
            let response = client.response(id)?;
            if !matches!(response, DebugResponse::Pending) {
                let (_, _, filters) = self
                    .exception_request
                    .take()
                    .ok_or(DebugClientError::InvalidMessage)?;
                match response {
                    DebugResponse::Complete(value)
                        if value.get("success") == Some(&Value::Bool(true)) =>
                    {
                        self.exceptions.applied_version = version;
                        self.exceptions.applied_filters = filters;
                        if version == self.exceptions.version {
                            self.exceptions.error = None;
                        }
                    }
                    DebugResponse::Complete(value) if version == self.exceptions.version => {
                        self.exceptions.error = Some(
                            value
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Debug Adapter rejected exception filters")
                                .to_owned(),
                        )
                    }
                    DebugResponse::Failed(message) if version == self.exceptions.version => {
                        self.exceptions.error = Some(message)
                    }
                    DebugResponse::Complete(_) | DebugResponse::Failed(_) => {}
                    DebugResponse::Pending => unreachable!(),
                }
                if !self.configured && self.configuration_request.is_none() {
                    if let Some(error) = self.exceptions.error.clone() {
                        self.fail(&error);
                        return Ok(outgoing);
                    }
                    if self.capabilities.get("supportsConfigurationDoneRequest")
                        == Some(&Value::Bool(true))
                    {
                        let (id, message) = client.request("configurationDone", None)?;
                        self.configuration_request = Some(id);
                        outgoing.push(message);
                    } else {
                        self.configured = true;
                    }
                }
            }
        }
        if self.snapshot.phase == DebugInitializationPhase::Active
            && self.exception_request.is_none()
            && self.exceptions.applied_version < self.exceptions.version
            && self.exceptions.error.is_none()
        {
            outgoing.push(self.send_exceptions(client)?);
        }
        if let Some(id) = self.configuration_request {
            if self.completed(client, id)?.is_some() {
                self.configuration_request = None;
                self.configured = true;
            }
        }
        if !self.ended() && self.configured && self.launch_request.is_none() {
            self.phase(DebugInitializationPhase::Active);
            if self.snapshot.state == DebugExecutionState::Starting {
                self.execution(DebugExecutionState::Running, None, None);
            }
        }
        Ok(outgoing)
    }

    fn completed(
        &mut self,
        client: &mut DebugClient,
        id: u64,
    ) -> Result<Option<Value>, DebugClientError> {
        match client.response(id)? {
            DebugResponse::Pending => Ok(None),
            DebugResponse::Failed(message) => {
                self.fail(&message);
                Ok(None)
            }
            DebugResponse::Complete(response) => {
                if response["success"] == true {
                    Ok(Some(response))
                } else {
                    self.fail(
                        response["message"]
                            .as_str()
                            .unwrap_or("Debug Adapter initialization request failed"),
                    );
                    Ok(None)
                }
            }
        }
    }

    fn merge_capabilities(&mut self, value: &Value) -> Result<(), DebugClientError> {
        if let Some(values) = value.as_object() {
            // Retain only negotiated fields used by this domain; a stream of
            // vendor capability keys must not grow the session without bound.
            for key in [
                "supportsConfigurationDoneRequest",
                "supportsRestartRequest",
                "supportsTerminateRequest",
                "supportTerminateDebuggee",
                "supportsSetVariable",
                "supportsConditionalBreakpoints",
                "supportsHitConditionalBreakpoints",
                "supportsLogPoints",
                "supportsFunctionBreakpoints",
                "supportsDataBreakpoints",
                "supportsInstructionBreakpoints",
                "supportsDisassembleRequest",
                "supportsReadMemoryRequest",
                "supportsWriteMemoryRequest",
                "supportsLoadedSourcesRequest",
                "supportsExceptionInfoRequest",
                "supportsSteppingGranularity",
                "supportsCompletionsRequest",
                "supportsCancelRequest",
                "completionTriggerCharacters",
                "exceptionBreakpointFilters",
            ] {
                if let Some(value) = values.get(key) {
                    let value = if key == "completionTriggerCharacters" {
                        match value {
                            Value::Null => json!([]),
                            Value::Array(characters) if characters.len() <= 32 => {
                                let mut normalized = Vec::new();
                                for character in characters {
                                    let character = character
                                        .as_str()
                                        .filter(|text| {
                                            !text.is_empty()
                                                && text.len() <= 16
                                                && !text.contains('\0')
                                        })
                                        .ok_or(DebugClientError::InvalidMessage)?;
                                    if !normalized
                                        .iter()
                                        .any(|existing: &String| existing == character)
                                    {
                                        normalized.push(character.to_owned());
                                    }
                                }
                                json!(normalized)
                            }
                            _ => return Err(DebugClientError::InvalidMessage),
                        }
                    } else if key == "exceptionBreakpointFilters" {
                        if value.to_string().len() > 64 * 1024 {
                            return Err(DebugClientError::InvalidMessage);
                        }
                        value.clone()
                    } else {
                        Value::Bool(value == &Value::Bool(true))
                    };
                    self.capabilities.insert(key.to_owned(), value);
                }
            }
        }
        let flag = |key| self.capabilities.get(key) == Some(&Value::Bool(true));
        let filters = match self.capabilities.get("exceptionBreakpointFilters") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(filters)) => filters
                .iter()
                .map(|filter| {
                    Ok(DebugExceptionFilter {
                        filter: filter["filter"]
                            .as_str()
                            .ok_or(DebugClientError::InvalidMessage)?
                            .to_owned(),
                        label: filter["label"]
                            .as_str()
                            .ok_or(DebugClientError::InvalidMessage)?
                            .to_owned(),
                        default: filter["default"] == true,
                        description: filter["description"].as_str().map(str::to_owned),
                    })
                })
                .collect::<Result<Vec<_>, DebugClientError>>()?,
            Some(_) => return Err(DebugClientError::InvalidMessage),
        };
        let selected: Vec<_> = self
            .exceptions
            .filters
            .iter()
            .filter(|id| self.no_debug || filters.iter().any(|candidate| &candidate.filter == *id))
            .cloned()
            .collect();
        if selected != self.exceptions.filters {
            self.exceptions.filters = selected;
            self.exceptions.version += 1;
            self.exceptions.error = None;
        }
        self.snapshot.capabilities = DebugCapabilities {
            supports_restart: flag("supportsRestartRequest"),
            supports_terminate: flag("supportsTerminateRequest")
                || flag("supportTerminateDebuggee"),
            supports_set_variable: flag("supportsSetVariable"),
            supports_conditional_breakpoints: flag("supportsConditionalBreakpoints"),
            supports_hit_conditional_breakpoints: flag("supportsHitConditionalBreakpoints"),
            supports_log_points: flag("supportsLogPoints"),
            supports_function_breakpoints: flag("supportsFunctionBreakpoints"),
            supports_data_breakpoints: flag("supportsDataBreakpoints"),
            supports_instruction_breakpoints: flag("supportsInstructionBreakpoints"),
            supports_disassemble_request: flag("supportsDisassembleRequest"),
            supports_read_memory_request: flag("supportsReadMemoryRequest"),
            supports_write_memory_request: flag("supportsWriteMemoryRequest"),
            supports_loaded_sources_request: flag("supportsLoadedSourcesRequest"),
            supports_exception_info_request: flag("supportsExceptionInfoRequest"),
            supports_stepping_granularity: flag("supportsSteppingGranularity"),
            supports_completions_request: flag("supportsCompletionsRequest"),
            supports_cancel_request: flag("supportsCancelRequest"),
            completion_trigger_characters: self
                .capabilities
                .get("completionTriggerCharacters")
                .and_then(Value::as_array)
                .map(|characters| {
                    characters
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_else(|| vec![".".to_owned()]),
            exception_breakpoint_filters: filters,
        };
        self.snapshot.revision += 1;
        Ok(())
    }

    fn phase(&mut self, phase: DebugInitializationPhase) {
        if self.snapshot.phase != phase {
            self.snapshot.phase = phase;
            self.snapshot.revision += 1;
        }
    }
    fn execution(
        &mut self,
        state: DebugExecutionState,
        reason: Option<String>,
        thread: Option<i64>,
    ) {
        self.snapshot.inspection_revision += 1;
        self.snapshot.state = state;
        self.snapshot.reason = reason;
        self.snapshot.stopped_thread_id = thread;
        self.snapshot.execution_revision += 1;
        self.snapshot.revision += 1;
    }
    pub fn inspection_epoch(&self) -> u64 {
        self.snapshot.inspection_revision
    }

    pub fn ended(&self) -> bool {
        matches!(
            self.snapshot.state,
            DebugExecutionState::Terminated | DebugExecutionState::Error
        )
    }
    pub fn end(&mut self, reason: Option<String>) {
        if !self.ended() {
            self.execution(DebugExecutionState::Terminated, reason, None);
            self.phase(DebugInitializationPhase::Ended);
        }
    }
    pub fn fail(&mut self, reason: &str) {
        if !self.ended() {
            self.execution(DebugExecutionState::Error, Some(reason.to_owned()), None);
            self.phase(DebugInitializationPhase::Ended);
        }
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;

// DAP writes use standard padded base64; validate the actual decoded byte budget
// before a caller can dispatch arbitrary JSON to an adapter.
fn valid_memory_data(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 5464 || !bytes.len().is_multiple_of(4) {
        return false;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2
        && bytes[..bytes.len() - padding]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        && (1..=4096).contains(&(bytes.len() / 4 * 3 - padding))
}
