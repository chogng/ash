use crate::OllamaError;
use crate::OllamaModel;
use crate::OllamaModelDetails;
use crate::OllamaModelInfo;
use crate::OllamaStatus;
use crate::PullEvent;
use crate::PullProgressSink;
use ash_async_utils::CancellationToken;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use semver::Version;
use serde::Deserialize;
use std::sync::Arc;
use url::Url;

pub(crate) const MAX_PROGRESS_LINE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct OllamaClient {
    client: Arc<dyn OperationClient>,
    host_root: String,
}

impl OllamaClient {
    pub fn from_openai_compatible_base_url(
        base_url: &str,
        client: Arc<dyn OperationClient>,
    ) -> Result<Self, OllamaError> {
        let mut url = Url::parse(base_url)
            .map_err(|_| OllamaError::InvalidEndpoint("base URL is not a valid URL".into()))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(OllamaError::InvalidEndpoint(
                "base URL must be an HTTP(S) URL without credentials, query, or fragment".into(),
            ));
        }
        let mut segments = url
            .path_segments()
            .ok_or_else(|| OllamaError::InvalidEndpoint("base URL cannot be a base".into()))?
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if segments.pop() != Some("v1") {
            return Err(OllamaError::InvalidEndpoint(
                "OpenAI-compatible base URL must end with `/v1`".into(),
            ));
        }
        let root_path = if segments.is_empty() {
            "/".to_owned()
        } else {
            format!("/{}/", segments.join("/"))
        };
        url.set_path(&root_path);
        let host_root = url.as_str().trim_end_matches('/').to_owned();
        Ok(Self { client, host_root })
    }

    pub fn host_root(&self) -> &str {
        &self.host_root
    }

    pub fn list_models(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<OllamaModel>, OllamaError> {
        let response = self.get("api/tags", cancellation)?;
        let response: TagsResponse = serde_json::from_slice(response.body())
            .map_err(|_| OllamaError::InvalidResponse("model list is not valid JSON".into()))?;
        response
            .models
            .into_iter()
            .map(OllamaModel::try_from)
            .collect()
    }

    pub fn version(&self, cancellation: &CancellationToken) -> Result<Version, OllamaError> {
        let response = self.get("api/version", cancellation)?;
        let response: VersionResponse = serde_json::from_slice(response.body()).map_err(|_| {
            OllamaError::InvalidResponse("version response is not valid JSON".into())
        })?;
        Version::parse(response.version.trim_start_matches('v')).map_err(|_| {
            OllamaError::InvalidResponse(
                "version response does not contain a semantic version".into(),
            )
        })
    }

    pub fn show_model(
        &self,
        model: &str,
        cancellation: &CancellationToken,
    ) -> Result<OllamaModelInfo, OllamaError> {
        let model = validated_model_name(model)?;
        let body = serde_json::to_vec(&serde_json::json!({ "model": model }))
            .map_err(|_| OllamaError::InvalidRequest("model detail request is invalid".into()))?;
        let request = ClientRequest::post(
            self.url("api/show"),
            vec![HttpHeader::new("content-type", "application/json")],
            body,
            RetryPolicy::never(),
        )?;
        let response = self
            .client
            .execute_with_cancellation(&request, cancellation)
            .map_err(OllamaError::from)?;
        if !response.is_success() {
            return Err(OllamaError::HttpStatus(response.status()));
        }
        let response: ShowResponse = serde_json::from_slice(response.body()).map_err(|_| {
            OllamaError::InvalidResponse("model detail response is not valid JSON".into())
        })?;
        Ok(OllamaModelInfo {
            capabilities: response.capabilities,
        })
    }

    pub fn status(&self, cancellation: &CancellationToken) -> Result<OllamaStatus, OllamaError> {
        let version = self.version(cancellation)?;
        let models = self.list_models(cancellation)?;
        Ok(OllamaStatus { version, models })
    }

    pub fn pull_model(
        &self,
        model: &str,
        cancellation: &CancellationToken,
        progress: &mut dyn PullProgressSink,
    ) -> Result<(), OllamaError> {
        let model = validated_model_name(model)?;
        let body = serde_json::to_vec(&serde_json::json!({
            "model": model,
            "stream": true,
        }))
        .map_err(|_| OllamaError::InvalidRequest("model download request is invalid".into()))?;
        let request = ClientRequest::post(
            self.url("api/pull"),
            vec![HttpHeader::new("content-type", "application/json")],
            body,
            RetryPolicy::never(),
        )?;
        let mut decoder = PullDecoder::new(progress);
        let response =
            self.client
                .execute_streaming_with_cancellation(&request, cancellation, &mut decoder);
        if let Some(error) = decoder.failure.take() {
            return Err(error);
        }
        let response = response.map_err(OllamaError::from)?;
        if !response.is_success() {
            return Err(OllamaError::HttpStatus(response.status()));
        }
        decoder.finish()?;
        if !decoder.completed {
            return Err(OllamaError::InvalidResponse(
                "model download ended before Ollama reported success".into(),
            ));
        }
        Ok(())
    }

    fn get(
        &self,
        path: &str,
        cancellation: &CancellationToken,
    ) -> Result<ash_client::ClientResponse, OllamaError> {
        let request = ClientRequest::new(
            HttpMethod::Get,
            self.url(path),
            Vec::new(),
            Vec::new(),
            RetryPolicy::never(),
        )?;
        let response = self
            .client
            .execute_with_cancellation(&request, cancellation)
            .map_err(OllamaError::from)?;
        if !response.is_success() {
            return Err(OllamaError::HttpStatus(response.status()));
        }
        Ok(response)
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.host_root, path.trim_start_matches('/'))
    }
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    modified_at: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    details: Option<TagModelDetails>,
}

impl TryFrom<TagModel> for OllamaModel {
    type Error = OllamaError;

    fn try_from(model: TagModel) -> Result<Self, Self::Error> {
        let name = model
            .name
            .filter(|name| !name.trim().is_empty())
            .or_else(|| model.model.filter(|name| !name.trim().is_empty()))
            .ok_or_else(|| {
                OllamaError::InvalidResponse("model list contains an entry without a name".into())
            })?;
        Ok(Self {
            name,
            size: model.size,
            digest: model.digest,
            modified_at: model.modified_at,
            details: model.details.map(Into::into),
        })
    }
}

#[derive(Deserialize)]
struct TagModelDetails {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    family: Option<String>,
    #[serde(default)]
    families: Vec<String>,
    #[serde(default)]
    parameter_size: Option<String>,
    #[serde(default)]
    quantization_level: Option<String>,
}

impl From<TagModelDetails> for OllamaModelDetails {
    fn from(details: TagModelDetails) -> Self {
        Self {
            format: details.format,
            family: details.family,
            families: details.families,
            parameter_size: details.parameter_size,
            quantization_level: details.quantization_level,
        }
    }
}

#[derive(Deserialize)]
struct VersionResponse {
    version: String,
}

#[derive(Deserialize)]
struct ShowResponse {
    #[serde(default)]
    capabilities: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct PullWireEvent {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

struct PullDecoder<'a> {
    progress: &'a mut dyn PullProgressSink,
    buffer: Vec<u8>,
    completed: bool,
    failure: Option<OllamaError>,
}

impl<'a> PullDecoder<'a> {
    fn new(progress: &'a mut dyn PullProgressSink) -> Self {
        Self {
            progress,
            buffer: Vec::new(),
            completed: false,
            failure: None,
        }
    }

    fn finish(&mut self) -> Result<(), OllamaError> {
        if !self.buffer.is_empty() {
            if self.buffer.len() > MAX_PROGRESS_LINE_BYTES {
                return Err(progress_line_too_large());
            }
            let line = std::mem::take(&mut self.buffer);
            self.decode_line(&line)?;
        }
        Ok(())
    }

    fn decode_available_lines(&mut self) -> Result<(), OllamaError> {
        while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            if index > MAX_PROGRESS_LINE_BYTES {
                return Err(progress_line_too_large());
            }
            let mut line = self.buffer.drain(..=index).collect::<Vec<_>>();
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if !line.is_empty() {
                self.decode_line(&line)?;
            }
        }
        Ok(())
    }

    fn decode_line(&mut self, line: &[u8]) -> Result<(), OllamaError> {
        let event: PullWireEvent = serde_json::from_slice(line).map_err(|_| {
            OllamaError::InvalidResponse("download progress is not valid NDJSON".into())
        })?;
        if let Some(error) = event.error.filter(|message| !message.is_empty()) {
            self.progress.emit(PullEvent::Failed(error.clone()))?;
            return Err(OllamaError::PullFailed(error));
        }
        if let Some(status) = event.status.as_ref().filter(|status| !status.is_empty()) {
            self.progress.emit(PullEvent::Status(status.clone()))?;
        }
        if event.digest.is_some() || event.total.is_some() || event.completed.is_some() {
            self.progress.emit(PullEvent::Progress {
                digest: event.digest.unwrap_or_default(),
                completed: event.completed,
                total: event.total,
            })?;
        }
        if event.status.as_deref() == Some("success") {
            self.progress.emit(PullEvent::Completed)?;
            self.completed = true;
        }
        Ok(())
    }
}

impl OperationStreamSink for PullDecoder<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ash_client::ClientError> {
        if self.failure.is_some() {
            return Err(ash_client::ClientError::Framing(
                "Ollama progress decoding already failed".into(),
            ));
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > MAX_PROGRESS_LINE_BYTES
            && !self.buffer.iter().any(|byte| *byte == b'\n')
        {
            let error = progress_line_too_large();
            self.failure = Some(error);
            return Err(ash_client::ClientError::Framing(
                "Ollama progress line is too large".into(),
            ));
        }
        if let Err(error) = self.decode_available_lines() {
            self.failure = Some(error);
            return Err(ash_client::ClientError::Framing(
                "Ollama progress decoding failed".into(),
            ));
        }
        Ok(())
    }
}

fn progress_line_too_large() -> OllamaError {
    OllamaError::InvalidResponse("download progress line exceeded the supported size".into())
}

fn validated_model_name(model: &str) -> Result<&str, OllamaError> {
    let model = model.trim();
    if model.is_empty() || model.chars().any(char::is_whitespace) {
        return Err(OllamaError::InvalidRequest(
            "model name must be non-empty and contain no whitespace".into(),
        ));
    }
    Ok(model)
}
