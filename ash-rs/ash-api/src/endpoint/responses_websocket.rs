use super::responses;
use crate::ApiEndpoint;
use crate::ApiError;
use crate::ApiStreamSink;
use crate::ModelRequest;
use crate::ModelResponse;
use crate::ResponsesEventDecoder;
use crate::WebSocketSessionConfig;
use crate::websocket::JsonSocket;
use ash_async_utils::CancellationToken;
use ash_client::ResolvedApiTarget;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketRequest;
use serde_json::Value;
use serde_json::json;

/// One caller-owned sequential Responses connection. Never share it between execution branches.
/// A failed, cancelled, or abandoned invocation retires its socket; callers explicitly reconnect.
pub struct ResponsesWebSocketSession {
    socket: Option<JsonSocket>,
    endpoint: ApiEndpoint,
    model: String,
    cache_key: Option<String>,
    baseline: Option<Baseline>,
    turn_state: Option<String>,
    stats: ResponsesConnectionStats,
}
/// Transport observations for this connection; these are not billing or durable history.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ResponsesConnectionStats {
    pub requests_sent: u64,
    pub incremental_requests: u64,
    pub input_items_sent: u64,
}
struct Baseline {
    properties: Value,
    input: Vec<Value>,
    response_id: String,
    prepared: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum Generation {
    Prepare,
    Generate,
}
struct Exchange {
    prepared: ResponsesWarmup,
    response: Option<ModelResponse>,
}
/// Server evidence for an explicit warmup. It is not a generated assistant message.
#[derive(Clone, Debug)]
pub struct ResponsesWarmup {
    pub response_id: String,
    pub usage: Option<crate::ModelUsage>,
}
struct DiscardEvents;
impl ApiStreamSink for DiscardEvents {
    fn emit(&mut self, _: crate::ModelStreamEvent) -> Result<(), ApiError> {
        Ok(())
    }
}

impl ResponsesWebSocketSession {
    pub async fn connect(
        connector: &WebSocketConnector,
        target: &ResolvedApiTarget,
        endpoint: ApiEndpoint,
        model: &str,
        cache_key: Option<String>,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<Self, ApiError> {
        if !matches!(
            endpoint,
            ApiEndpoint::OpenAiResponses | ApiEndpoint::ChatGptResponses
        ) || model.trim().is_empty()
        {
            return Err(ApiError::InvalidRequest(
                "endpoint does not support Responses WebSocket".into(),
            ));
        }
        let mut request = ModelRequest::text("handshake");
        request.prompt_cache_key = cache_key.clone();
        let mut headers = endpoint.headers(target, &request)?;
        if endpoint == ApiEndpoint::ChatGptResponses {
            crate::headers::insert(
                &mut headers,
                "OpenAI-Beta",
                "responses_websockets=2026-02-06",
            )?;
        }
        let url = crate::websocket::url(&target.base_url, responses::path())?;
        let wire = WebSocketRequest::new(url.as_str(), headers)
            .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
        let (socket, handshake) =
            JsonSocket::connect(connector, wire, limits, cancellation).await?;
        let turn_state = handshake
            .headers()
            .iter()
            .find(|header| header.name().eq_ignore_ascii_case("x-codex-turn-state"))
            .map(|header| header.value().to_owned());
        Ok(Self {
            socket: Some(socket),
            endpoint,
            model: model.into(),
            cache_key,
            baseline: None,
            turn_state,
            stats: ResponsesConnectionStats::default(),
        })
    }

    pub fn stats(&self) -> ResponsesConnectionStats {
        self.stats
    }
    pub fn is_open(&self) -> bool {
        self.socket.is_some()
    }
    pub fn abort(&mut self) {
        self.socket = None;
        self.baseline = None;
        self.turn_state = None;
    }

    pub async fn close(&mut self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        self.baseline = None;
        self.turn_state = None;
        if let Some(socket) = self.socket.take() {
            socket.shutdown(cancellation).await?;
        }
        Ok(())
    }

    /// Accepts the complete canonical request. Sends a delta only after exact prior-prefix matching.
    pub async fn invoke(
        &mut self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ApiStreamSink,
    ) -> Result<ModelResponse, ApiError> {
        Ok(self
            .exchange(request, Generation::Generate, cancellation, sink)
            .await?
            .response
            .expect("generated exchange contains a response"))
    }

    pub async fn warm_up(
        &mut self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ResponsesWarmup, ApiError> {
        Ok(self
            .exchange(
                request,
                Generation::Prepare,
                cancellation,
                &mut DiscardEvents,
            )
            .await?
            .prepared)
    }

    async fn exchange(
        &mut self,
        request: &ModelRequest,
        generation: Generation,
        cancellation: &CancellationToken,
        sink: &mut dyn ApiStreamSink,
    ) -> Result<Exchange, ApiError> {
        if generation == Generation::Prepare {
            crate::endpoint::validate_options(&self.model, request)?;
        } else {
            crate::endpoint::validate_request(&self.model, request)?;
        }
        if request.prompt_cache_key != self.cache_key {
            return Err(ApiError::InvalidRequest(
                "a Responses connection cannot change its cache scope".into(),
            ));
        }
        cancellation
            .check()
            .map_err(|_| crate::websocket::cancelled())?;
        let mut body = responses::build_request(self.endpoint, &self.model, request)?;
        body.as_object_mut().unwrap().remove("stream");
        let input = body
            .as_object_mut()
            .unwrap()
            .remove("input")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        let properties = body.clone();
        let mut delta = input.clone();
        if let Some(previous) = &self.baseline {
            if previous.properties == properties
                && input.starts_with(&previous.input)
                && (input.len() > previous.input.len() || previous.prepared)
            {
                body["previous_response_id"] = json!(previous.response_id);
                delta = input[previous.input.len()..].to_vec();
            }
        }
        body["type"] = json!("response.create");
        if generation == Generation::Prepare {
            body["generate"] = json!(false);
        }
        body["input"] = json!(delta);
        if self.endpoint == ApiEndpoint::ChatGptResponses
            && let Some(state) = &self.turn_state
        {
            body["client_metadata"] = json!({"x-codex-turn-state":state});
        }
        // Taking ownership makes dropping this future close the in-flight connection.
        let mut socket = self.socket.take().ok_or_else(|| {
            ApiError::Transport("Responses connection is closed; reconnect explicitly".into())
        })?;
        self.baseline = None;
        let incremental = body.get("previous_response_id").is_some();
        let sent_items = body["input"].as_array().unwrap().len() as u64;
        socket.send(body, cancellation).await?;
        self.stats.requests_sent += 1;
        self.stats.incremental_requests += u64::from(incremental);
        self.stats.input_items_sent += sent_items;
        let mut events = ResponsesEventDecoder::new();
        let mut response_id: Option<String> = None;
        for _ in 0..100_000 {
            let event = socket.receive(cancellation).await?;
            if event.get("stream_id").is_some_and(|id| !id.is_null()) {
                return Err(ApiError::InvalidResponse(
                    "multiplexed events are not supported by a sequential Responses session".into(),
                ));
            }
            let id = event
                .get("response_id")
                .and_then(Value::as_str)
                .or_else(|| event.pointer("/response/id").and_then(Value::as_str));
            if let Some(id) = id {
                if response_id
                    .as_deref()
                    .is_some_and(|expected| expected != id)
                {
                    return Err(ApiError::InvalidResponse(
                        "Responses event belongs to another response".into(),
                    ));
                }
                response_id = Some(id.into());
            }
            for event in events.decode_json(&event)? {
                sink.emit(event)?;
            }
            if events.is_terminal() {
                let response = events.finish_response()?;
                let result = if generation == Generation::Generate {
                    Some(responses::parse_response(response.clone())?)
                } else {
                    None
                };
                let id = response
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        ApiError::InvalidResponse("WebSocket response has no ID".into())
                    })?;
                let prepared = ResponsesWarmup {
                    response_id: id.into(),
                    usage: responses::parse_usage(response.get("usage")),
                };
                let mut expected = input;
                for item in response["output"].as_array().unwrap() {
                    // Server-owned reasoning is retained by the response chain, never rebuilt
                    // from summaries. Rollback or changed request properties starts a full request.
                    if item["type"] == "reasoning" {
                        continue;
                    }
                    // Only losslessly comparable public items can become an incremental baseline.
                    let Some(item) = comparable_output(item) else {
                        self.socket = Some(socket);
                        return Ok(Exchange {
                            prepared,
                            response: result,
                        });
                    };
                    expected.push(item);
                }
                self.baseline = Some(Baseline {
                    properties,
                    input: expected,
                    response_id: id.into(),
                    prepared: generation == Generation::Prepare,
                });
                self.socket = Some(socket);
                return Ok(Exchange {
                    prepared,
                    response: result,
                });
            }
        }
        Err(ApiError::InvalidResponse(
            "Responses event limit exceeded".into(),
        ))
    }
}

fn comparable_output(item: &Value) -> Option<Value> {
    match item["type"].as_str()? {
        "message" if item["role"] == "assistant" => {
            let content = item["content"]
                .as_array()?
                .iter()
                .map(|part| {
                    if part["type"] == "output_text" {
                        Some(json!({"type":"output_text","text":part["text"].as_str()?}))
                    } else {
                        None
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            Some(json!({"role":"assistant","content":content}))
        }
        "function_call" => Some(
            json!({"type":"function_call","call_id":item["call_id"].as_str()?,"name":item["name"].as_str()?,"arguments":item["arguments"].as_str()?}),
        ),
        _ => None,
    }
}
