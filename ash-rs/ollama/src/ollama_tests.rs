use crate::OllamaClient;
use crate::OllamaError;
use crate::PullEvent;
use crate::PullProgressSink;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use semver::Version;
use std::sync::Arc;
use std::sync::Mutex;

struct FakeClient {
    requests: Mutex<Vec<ClientRequest>>,
}

impl Default for FakeClient {
    fn default() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for FakeClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        let body = match request.url() {
            "http://localhost:11434/api/version" => br#"{"version":"0.32.3"}"#.to_vec(),
            "http://localhost:11434/api/tags" => br#"{
                "models": [{
                    "name": "qwen3:8b",
                    "modified_at": "2026-09-03T00:00:00Z",
                    "size": 512,
                    "digest": "sha256:test",
                    "details": {
                        "format": "gguf",
                        "family": "qwen3",
                        "families": ["qwen3"],
                        "parameter_size": "8B",
                        "quantization_level": "Q4_K_M"
                    }
                }]
            }"#
            .to_vec(),
            "http://localhost:11434/api/show" => {
                br#"{"capabilities":["completion","tools"]}"#.to_vec()
            }
            endpoint => panic!("unexpected endpoint: {endpoint}"),
        };
        Ok(ClientResponse::new(200, Vec::new(), body))
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        sink.emit(
            br#"{"status":"pulling layers","digest":"sha256:a","total":100,"completed":25}"#,
        )?;
        sink.emit(b"\n")?;
        sink.emit(br#"{"status":"success"}"#)?;
        sink.emit(b"\n")?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct StreamingClient(Vec<u8>);

impl OperationClient for StreamingClient {
    fn execute(&self, _request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("streaming test must use execute_streaming")
    }

    fn execute_streaming(
        &self,
        _request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        sink.emit(&self.0)?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

#[derive(Default)]
struct Events(Vec<PullEvent>);

impl PullProgressSink for Events {
    fn emit(&mut self, event: PullEvent) -> Result<(), OllamaError> {
        self.0.push(event);
        Ok(())
    }
}

#[test]
fn status_uses_explicit_ollama_endpoints_and_preserves_model_metadata() {
    let transport = Arc::new(FakeClient::default());
    let client = OllamaClient::from_openai_compatible_base_url(
        "http://localhost:11434/v1",
        transport.clone(),
    )
    .unwrap();

    let status = client.status(&CancellationSource::new().token()).unwrap();

    assert_eq!(status.version, Version::new(0, 32, 3));
    assert_eq!(status.models.len(), 1);
    assert_eq!(status.models[0].name, "qwen3:8b");
    assert_eq!(
        status.models[0].details.as_ref().unwrap().family.as_deref(),
        Some("qwen3")
    );
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].url(), "http://localhost:11434/api/version");
    assert_eq!(requests[1].url(), "http://localhost:11434/api/tags");
}

#[test]
fn custom_base_keeps_its_explicit_path_prefix() {
    let client = OllamaClient::from_openai_compatible_base_url(
        "https://models.example.test/ollama/v1/",
        Arc::new(FakeClient::default()),
    )
    .unwrap();

    assert_eq!(client.host_root(), "https://models.example.test/ollama");
}

#[test]
fn show_model_reads_declared_capabilities() {
    let transport = Arc::new(FakeClient::default());
    let client = OllamaClient::from_openai_compatible_base_url(
        "http://localhost:11434/v1",
        transport.clone(),
    )
    .unwrap();

    let model = client
        .show_model("qwen3:8b", &CancellationSource::new().token())
        .unwrap();

    assert_eq!(model.supports("completion"), Some(true));
    assert_eq!(model.supports("tools"), Some(true));
    let request = transport.requests.lock().unwrap()[0].clone();
    assert_eq!(request.url(), "http://localhost:11434/api/show");
    assert_eq!(request.body(), br#"{"model":"qwen3:8b"}"#);
}

#[test]
fn endpoint_rejects_non_v1_paths_instead_of_guessing() {
    let result = OllamaClient::from_openai_compatible_base_url(
        "http://localhost:11434/custom",
        Arc::new(FakeClient::default()),
    );

    assert!(matches!(result, Err(OllamaError::InvalidEndpoint(_))));
}

#[test]
fn pull_decodes_split_ndjson_progress_and_requires_success() {
    let transport = Arc::new(FakeClient::default());
    let client = OllamaClient::from_openai_compatible_base_url(
        "http://localhost:11434/v1",
        transport.clone(),
    )
    .unwrap();
    let mut events = Events::default();

    client
        .pull_model("qwen3:8b", &CancellationSource::new().token(), &mut events)
        .unwrap();

    assert_eq!(
        events.0,
        vec![
            PullEvent::Status("pulling layers".into()),
            PullEvent::Progress {
                digest: "sha256:a".into(),
                completed: Some(25),
                total: Some(100),
            },
            PullEvent::Status("success".into()),
            PullEvent::Completed,
        ]
    );
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].url(), "http://localhost:11434/api/pull");
    assert_eq!(requests[0].retry_policy(), ash_client::RetryPolicy::never());
}

#[test]
fn pull_rejects_an_oversized_complete_progress_line() {
    let oversized = format!(
        "{{\"status\":\"{}\"}}\n",
        "x".repeat(super::client::MAX_PROGRESS_LINE_BYTES)
    );
    let operation = Arc::new(StreamingClient(oversized.into_bytes()));
    let client =
        OllamaClient::from_openai_compatible_base_url("http://localhost:11434/v1", operation)
            .unwrap();
    let cancellation = CancellationSource::new();
    let mut progress = Events::default();

    let error = client
        .pull_model("qwen3:8b", &cancellation.token(), &mut progress)
        .unwrap_err();

    assert_eq!(
        error,
        OllamaError::InvalidResponse("download progress line exceeded the supported size".into())
    );
}
