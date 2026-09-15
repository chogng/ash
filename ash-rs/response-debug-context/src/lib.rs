//! Bounded response evidence, independent of transports, authentication and product storage.

use base64::Engine;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Selected upstream correlation and authentication facts. Never contains a response body.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDebugContext {
    pub request_id: Option<String>,
    pub cf_ray: Option<String>,
    pub auth_error: Option<String>,
    pub auth_error_code: Option<String>,
}

impl ResponseDebugContext {
    /// Accepts HTTP or WebSocket response headers without depending on either transport.
    /// Ambiguous duplicate headers, oversized values and non-token text are discarded.
    pub fn from_headers<'a>(headers: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut selected = [None; 5];
        let mut seen = [false; 5];
        for (name, value) in headers {
            let index = [
                "x-request-id",
                "x-oai-request-id",
                "cf-ray",
                "x-openai-authorization-error",
                "x-error-json",
            ]
            .iter()
            .position(|candidate| name.eq_ignore_ascii_case(candidate));
            if let Some(index) = index {
                selected[index] = if seen[index] { None } else { Some(value) };
                seen[index] = true;
            }
        }
        Self {
            request_id: selected[0]
                .and_then(token)
                .or_else(|| selected[1].and_then(token)),
            cf_ray: selected[2].and_then(token),
            auth_error: selected[3].and_then(token),
            auth_error_code: selected[4]
                .filter(|value| value.len() <= 4096)
                .and_then(|value| {
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(value)
                        .ok()?;
                    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
                    value
                        .pointer("/error/code")
                        .and_then(serde_json::Value::as_str)
                        .and_then(token)
                }),
        }
    }
}

fn token(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte)))
    .then(|| value.to_owned())
}

/// Only names of recognized authentication headers are retained, never their values.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AuthHeader {
    Authorization,
    ApiKey,
    XApiKey,
    XGoogApiKey,
}

impl AuthHeader {
    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "authorization" => Some(Self::Authorization),
            "api-key" => Some(Self::ApiKey),
            "x-api-key" => Some(Self::XApiKey),
            "x-goog-api-key" => Some(Self::XGoogApiKey),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RequestOutcome {
    Http { status: u16 },
    TransportFailure,
    Cancelled,
    InvalidRequest,
    InvalidResponse,
}

impl RequestOutcome {
    pub fn is_success(self) -> bool {
        matches!(self, Self::Http { status: 200..=299 })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestAttempt {
    pub auth_headers: Vec<AuthHeader>,
    pub outcome: RequestOutcome,
    pub response: ResponseDebugContext,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ResponseOperation {
    Model,
    ModelCatalog,
    ConnectionProbe,
    InputTokenCount,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Abandoned,
}

/// Credential recovery result; a recovered credential does not imply a successful follow-up.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AuthRecovery {
    #[default]
    NotAttempted,
    Unavailable,
    Failed,
    CredentialsRecovered,
}

/// One logical operation, including its explicitly authorized authentication follow-up.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDiagnostic {
    pub operation: ResponseOperation,
    pub outcome: DiagnosticOutcome,
    pub attempts: u32,
    pub first_failure: Option<RequestAttempt>,
    pub first_unauthorized: Option<RequestAttempt>,
    pub latest: Option<RequestAttempt>,
    pub recovery: AuthRecovery,
}

impl ResponseDiagnostic {
    pub fn new(operation: ResponseOperation) -> Self {
        Self {
            operation,
            outcome: DiagnosticOutcome::Failed,
            attempts: 0,
            first_failure: None,
            first_unauthorized: None,
            latest: None,
            recovery: AuthRecovery::NotAttempted,
        }
    }

    pub fn record(&mut self, attempt: RequestAttempt) {
        self.attempts = self.attempts.saturating_add(1);
        if !attempt.outcome.is_success() && self.first_failure.is_none() {
            self.first_failure = Some(attempt.clone());
        }
        if attempt.outcome == (RequestOutcome::Http { status: 401 })
            && self.first_unauthorized.is_none()
        {
            self.first_unauthorized = Some(attempt.clone());
        }
        self.latest = Some(attempt);
    }
}

/// Product-owned destination for completed, content-free response diagnostics.
/// Implementations bound retention and must not append credentials, URLs or payloads.
pub trait ResponseDiagnosticSink: Send + Sync {
    fn record_response(&self, diagnostic: ResponseDiagnostic);
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
