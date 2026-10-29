//! Bounded, epoch-fenced inspection jobs. A job owns its DAP dependency chain;
//! Workbench supplies selection and paints results rather than sequencing IO.
use std::collections::HashMap;
use std::collections::VecDeque;
use std::time::Duration;
use std::time::Instant;

use ash_debug_client::DebugClient;
use ash_debug_client::DebugClientError;
use ash_debug_client::DebugResponse;
use ash_debug_contract::DebugInspection;
use ash_debug_contract::DebugInspectionResult;
use ash_debug_contract::DebugInspectionValue;
use ash_debug_contract::DebugScopeVariables;
use ash_debug_contract::DebugWatchValue;
use serde_json::Value;
use serde_json::json;

const MAX_JOBS: usize = 16;
const MAX_ITEMS: usize = 128;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;

enum Step {
    Done,
    Threads {
        preferred: Option<i64>,
    },
    Stack {
        threads: Vec<Value>,
        thread_id: i64,
    },
    Scopes,
    ScopeVariables {
        scopes: Vec<DebugScopeVariables>,
        index: usize,
    },
    Variables,
    Watch {
        expressions: Vec<String>,
        frame_id: Option<i64>,
        values: Vec<DebugWatchValue>,
    },
}

struct Job {
    epoch: u64,
    deadline: Instant,
    step: Step,
    request: Option<u64>,
    result: DebugInspectionResult,
}

pub(super) struct Inspections {
    next_id: u64,
    jobs: HashMap<u64, Job>,
    retired: VecDeque<u64>,
}

impl Inspections {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            jobs: HashMap::new(),
            retired: VecDeque::new(),
        }
    }

    pub fn start(
        &mut self,
        client: &mut DebugClient,
        epoch: u64,
        query: DebugInspection,
    ) -> Result<(u64, Value), DebugClientError> {
        if self.jobs.len() >= MAX_JOBS
            || self.jobs.values().map(retained_bytes).sum::<usize>()
                + serde_json::to_vec(&query)
                    .map_err(|_| DebugClientError::InvalidMessage)?
                    .len()
                > MAX_RESULT_BYTES
        {
            return Err(DebugClientError::Capacity);
        }
        let valid_id =
            |value: i64| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value);
        let (step, command, arguments) = match query {
            DebugInspection::Stack { thread_id } => {
                if thread_id.is_some_and(|id| !valid_id(id)) {
                    return Err(DebugClientError::InvalidMessage);
                }
                (
                    Step::Threads {
                        preferred: thread_id,
                    },
                    "threads",
                    None,
                )
            }
            DebugInspection::Frame { frame_id } => {
                if !valid_id(frame_id) {
                    return Err(DebugClientError::InvalidMessage);
                }
                (Step::Scopes, "scopes", Some(json!({"frameId":frame_id})))
            }
            DebugInspection::Variables {
                variables_reference,
            } => {
                if variables_reference > 9_007_199_254_740_991 {
                    return Err(DebugClientError::InvalidMessage);
                }
                (
                    Step::Variables,
                    "variables",
                    Some(json!({"variablesReference":variables_reference})),
                )
            }
            DebugInspection::Watch {
                expressions,
                frame_id,
            } => {
                if expressions.is_empty()
                    || expressions.len() > MAX_ITEMS
                    || frame_id.is_some_and(|id| !valid_id(id))
                    || expressions.iter().any(|expression| {
                        expression.trim().is_empty()
                            || expression.len() > 32768
                            || expression.contains('\0')
                    })
                    || expressions.iter().map(String::len).sum::<usize>() > MAX_RESULT_BYTES
                {
                    return Err(DebugClientError::InvalidMessage);
                }
                let arguments = watch_arguments(&expressions[0], frame_id);
                (
                    Step::Watch {
                        expressions,
                        frame_id,
                        values: Vec::new(),
                    },
                    "evaluate",
                    Some(arguments),
                )
            }
        };
        let (request, message) = client.request(command, arguments)?;
        let id = self.next_id;
        self.next_id += 1;
        self.jobs.insert(
            id,
            Job {
                epoch,
                deadline: Instant::now() + Duration::from_secs(30),
                step,
                request: Some(request),
                result: DebugInspectionResult::Pending,
            },
        );
        Ok((id, message))
    }

    pub fn read(&mut self, id: u64, epoch: u64) -> Result<DebugInspectionResult, DebugClientError> {
        let job = self
            .jobs
            .get_mut(&id)
            .ok_or(DebugClientError::UnknownRequest)?;
        if job.epoch != epoch {
            job.result = DebugInspectionResult::Invalidated;
            job.step = Step::Done;
        }
        if matches!(job.result, DebugInspectionResult::Pending) {
            return Ok(DebugInspectionResult::Pending);
        }
        let job = self.jobs.remove(&id).unwrap();
        if let Some(request) = job.request {
            self.retired.push_back(request);
        }
        Ok(job.result)
    }

    pub fn progress(
        &mut self,
        client: &mut DebugClient,
        epoch: u64,
    ) -> Result<Vec<Value>, DebugClientError> {
        let mut outgoing = Vec::new();
        let mut retired = VecDeque::new();
        for id in self.retired.drain(..) {
            if matches!(client.response(id)?, DebugResponse::Pending) {
                retired.push_back(id);
            }
        }
        self.retired = retired;
        for job in self.jobs.values_mut() {
            if job.epoch != epoch {
                job.result = DebugInspectionResult::Invalidated;
            }
            if Instant::now() >= job.deadline
                && matches!(job.result, DebugInspectionResult::Pending)
            {
                job.result = DebugInspectionResult::Failed {
                    message: "Debug inspection timed out".into(),
                };
            }
            if !matches!(job.result, DebugInspectionResult::Pending) {
                job.step = Step::Done;
            }
            let Some(request) = job.request else {
                continue;
            };
            let response = client.response(request)?;
            if matches!(response, DebugResponse::Pending) {
                continue;
            }
            job.request = None;
            if !matches!(job.result, DebugInspectionResult::Pending) {
                continue;
            }
            let body = match response {
                DebugResponse::Complete(response) if response["success"] == true => {
                    Ok(response.get("body").cloned().unwrap_or(Value::Null))
                }
                DebugResponse::Complete(response) => Err(response["message"]
                    .as_str()
                    .unwrap_or("Debug Adapter inspection request failed")
                    .to_owned()),
                DebugResponse::Failed(message) => Err(message),
                DebugResponse::Pending => unreachable!(),
            };
            match advance(job, body, client) {
                Ok(Some(message)) => outgoing.push(message),
                Ok(None) => {}
                Err(error) => {
                    job.result = DebugInspectionResult::Failed {
                        message: error.to_string(),
                    }
                }
            }
            if serde_json::to_vec(&job.result).map_or(true, |bytes| bytes.len() > MAX_RESULT_BYTES)
            {
                job.result = DebugInspectionResult::Failed {
                    message: "Debug inspection result exceeded its limit".into(),
                };
            }
        }
        for job in self.jobs.values_mut() {
            if !matches!(job.result, DebugInspectionResult::Pending) {
                job.step = Step::Done;
            }
        }
        // Retained completions share a budget across jobs, not one budget each.
        if self.jobs.values().map(retained_bytes).sum::<usize>() > MAX_RESULT_BYTES {
            for job in self.jobs.values_mut() {
                job.step = Step::Done;
                job.result = DebugInspectionResult::Failed {
                    message: "Debug inspection result buffer exceeded its limit".into(),
                };
            }
        }
        Ok(outgoing)
    }
}

fn values(body: &Value, field: &str) -> Result<Vec<Value>, DebugClientError> {
    body[field]
        .as_array()
        .filter(|values| values.len() <= 10000 && values.iter().all(Value::is_object))
        .cloned()
        .ok_or(DebugClientError::InvalidMessage)
}

fn advance(
    job: &mut Job,
    body: Result<Value, String>,
    client: &mut DebugClient,
) -> Result<Option<Value>, DebugClientError> {
    let mut next: Option<(&str, Value)> = None;
    match &mut job.step {
        Step::Done => return Err(DebugClientError::InvalidMessage),
        Step::Threads { preferred } => {
            let Ok(body) = body else {
                job.result = DebugInspectionResult::Failed {
                    message: body.unwrap_err(),
                };
                return Ok(None);
            };
            let threads = values(&body, "threads")?;
            let selected = preferred
                .and_then(|id| {
                    threads
                        .iter()
                        .find(|thread| thread["id"].as_i64() == Some(id))
                })
                .or_else(|| threads.first());
            if let Some(thread_id) = selected.and_then(|thread| thread["id"].as_i64()) {
                next = Some((
                    "stackTrace",
                    json!({"threadId":thread_id,"startFrame":0,"levels":100}),
                ));
                job.step = Step::Stack { threads, thread_id };
            } else {
                job.result = DebugInspectionResult::Complete {
                    value: DebugInspectionValue::Stack {
                        threads,
                        frames: Vec::new(),
                        thread_id: None,
                    },
                };
            }
        }
        Step::Stack { threads, thread_id } => match body {
            Ok(body) => {
                job.result = DebugInspectionResult::Complete {
                    value: DebugInspectionValue::Stack {
                        threads: std::mem::take(threads),
                        frames: values(&body, "stackFrames")?,
                        thread_id: Some(*thread_id),
                    },
                }
            }
            Err(message) => job.result = DebugInspectionResult::Failed { message },
        },
        Step::Scopes => match body {
            Ok(body) => {
                let scopes = values(&body, "scopes")?
                    .into_iter()
                    .map(|scope| DebugScopeVariables {
                        scope,
                        variables: Vec::new(),
                        variables_loaded: false,
                        error: None,
                    })
                    .collect::<Vec<_>>();
                job.step = Step::ScopeVariables { scopes, index: 0 };
                return next_scope(job, client);
            }
            Err(message) => job.result = DebugInspectionResult::Failed { message },
        },
        Step::ScopeVariables { scopes, index } => {
            let scope = &mut scopes[*index];
            scope.variables_loaded = true;
            match body {
                Ok(body) => scope.variables = values(&body, "variables")?,
                Err(error) => scope.error = Some(error),
            }
            *index += 1;
            return next_scope(job, client);
        }
        Step::Variables => match body {
            Ok(body) => {
                job.result = DebugInspectionResult::Complete {
                    value: DebugInspectionValue::Variables {
                        variables: values(&body, "variables")?,
                    },
                }
            }
            Err(message) => job.result = DebugInspectionResult::Failed { message },
        },
        Step::Watch {
            expressions,
            frame_id,
            values,
        } => {
            let expression = expressions[values.len()].clone();
            values.push(match body {
                Ok(body) => DebugWatchValue {
                    expression,
                    result: Some(body),
                    error: None,
                },
                Err(error) => DebugWatchValue {
                    expression,
                    result: None,
                    error: Some(error),
                },
            });
            if values.len() == expressions.len() {
                job.result = DebugInspectionResult::Complete {
                    value: DebugInspectionValue::Watch {
                        values: std::mem::take(values),
                    },
                };
            } else {
                next = Some((
                    "evaluate",
                    watch_arguments(&expressions[values.len()], *frame_id),
                ));
            }
        }
    }
    if retained_bytes(job) > MAX_RESULT_BYTES {
        return Err(DebugClientError::Capacity);
    }
    if let Some((command, arguments)) = next {
        let (request, message) = client.request(command, Some(arguments))?;
        job.request = Some(request);
        Ok(Some(message))
    } else {
        Ok(None)
    }
}

fn next_scope(job: &mut Job, client: &mut DebugClient) -> Result<Option<Value>, DebugClientError> {
    if retained_bytes(job) > MAX_RESULT_BYTES {
        return Err(DebugClientError::Capacity);
    }
    let Step::ScopeVariables { scopes, index } = &mut job.step else {
        return Err(DebugClientError::InvalidMessage);
    };
    while *index < scopes.len() {
        // CodeLLDB reports even process-wide globals as inexpensive. Eagerly
        // reading every scope blocks locals and execution controls in large apps.
        if scopes.iter().any(|scope| scope.variables_loaded) {
            break;
        }
        let reference = scopes[*index].scope["variablesReference"]
            .as_u64()
            .ok_or(DebugClientError::InvalidMessage)?;
        if reference > 0 && scopes[*index].scope["expensive"] != true {
            let (request, message) =
                client.request("variables", Some(json!({"variablesReference":reference})))?;
            job.request = Some(request);
            return Ok(Some(message));
        }
        *index += 1;
    }
    job.result = DebugInspectionResult::Complete {
        value: DebugInspectionValue::Frame {
            scopes: std::mem::take(scopes),
        },
    };
    Ok(None)
}

fn watch_arguments(expression: &str, frame_id: Option<i64>) -> Value {
    let mut arguments = json!({"expression":expression,"context":"watch"});
    if let Some(frame_id) = frame_id {
        arguments["frameId"] = json!(frame_id);
    }
    arguments
}

fn retained_bytes(job: &Job) -> usize {
    let array_bytes = |values: &[Value]| {
        values
            .iter()
            .map(|value| value.to_string().len())
            .sum::<usize>()
    };
    let pending = match &job.step {
        Step::Done | Step::Threads { .. } | Step::Scopes | Step::Variables => 0,
        Step::Stack { threads, .. } => array_bytes(threads),
        Step::ScopeVariables { scopes, .. } => {
            serde_json::to_vec(scopes).map_or(MAX_RESULT_BYTES, |value| value.len())
        }
        Step::Watch {
            expressions,
            values,
            ..
        } => {
            expressions.iter().map(String::len).sum::<usize>()
                + serde_json::to_vec(values).map_or(MAX_RESULT_BYTES, |value| value.len())
        }
    };
    pending + serde_json::to_vec(&job.result).map_or(MAX_RESULT_BYTES, |value| value.len())
}

#[cfg(test)]
#[path = "inspection_tests.rs"]
mod tests;
