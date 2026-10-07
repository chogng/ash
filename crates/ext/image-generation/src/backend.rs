use async_utils::CancellationToken;
use client::ClientRequest;
use client::OperationClient;
use client::RetryPolicy;
use http_client::HttpHeader;
use serde::Deserialize;
use serde::Serialize;
use std::sync::Arc;
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageGenerationRequest {
    pub prompt: String,
    pub reference_images: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedImage {
    pub mime_type: String,
    pub base64: String,
    pub revised_prompt: String,
}

/// Generates or edits one image using only the supplied prompt and resolved image data.
/// Backends must observe cancellation, bound responses and never retry billable generation implicitly.
pub trait ImageGenerationBackend: Send + Sync {
    fn service_name(&self) -> &str;
    fn network_scopes(&self) -> Vec<String>;
    fn credential_reference(&self) -> Option<String>;
    fn generate(
        &self,
        request: &ImageGenerationRequest,
        cancellation: &CancellationToken,
    ) -> Result<GeneratedImage, String>;
}

/// JSON HTTP adapter for a host-configured image service.
/// The service accepts ImageGenerationRequest and returns GeneratedImage.
pub struct JsonImageGenerationBackend {
    service: String,
    endpoint: String,
    scope: String,
    credential: Option<String>,
    headers: Vec<HttpHeader>,
    client: Arc<dyn OperationClient>,
}
impl JsonImageGenerationBackend {
    pub fn new(
        service: String,
        endpoint: String,
        credential: Option<String>,
        headers: Vec<HttpHeader>,
        client: Arc<dyn OperationClient>,
    ) -> Result<Self, String> {
        let url = Url::parse(&endpoint).map_err(|e| e.to_string())?;
        if service.trim().is_empty()
            || service.len() > 256
            || !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("image service endpoint is invalid".into());
        }
        let scope = url.host_str().ok_or("image service has no host")?.into();
        Ok(Self {
            service,
            endpoint,
            scope,
            credential,
            headers,
            client,
        })
    }
}
impl ImageGenerationBackend for JsonImageGenerationBackend {
    fn service_name(&self) -> &str {
        &self.service
    }
    fn network_scopes(&self) -> Vec<String> {
        vec![self.scope.clone()]
    }
    fn credential_reference(&self) -> Option<String> {
        self.credential.clone()
    }
    fn generate(
        &self,
        request: &ImageGenerationRequest,
        cancellation: &CancellationToken,
    ) -> Result<GeneratedImage, String> {
        let mut headers = self.headers.clone();
        if !headers
            .iter()
            .any(|h| h.name().eq_ignore_ascii_case("content-type"))
        {
            headers.push(HttpHeader::new("content-type", "application/json"));
        }
        let request = ClientRequest::post(
            &self.endpoint,
            headers,
            serde_json::to_vec(request).map_err(|e| e.to_string())?,
            RetryPolicy::never(),
        )
        .map_err(|e| e.to_string())?;
        let response = self
            .client
            .execute_with_cancellation(&request, cancellation)
            .map_err(|e| e.to_string())?;
        if !response.is_success() {
            return Err(format!("image service returned HTTP {}", response.status()));
        }
        if response.body().len() > 8_000_000 {
            return Err("image response exceeds 8 MB".into());
        }
        serde_json::from_slice(response.body()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;
