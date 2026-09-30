use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StableTurnError {
    pub code: StableTurnErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl StableTurnError {
    pub fn policy_circuit_breaker(reason: String) -> Self {
        Self {
            code: StableTurnErrorCode::PolicyCircuitBreaker,
            message: reason,
            retryable: false,
            http_status: None,
        }
    }

    pub fn model_invocation_failed() -> Self {
        Self {
            code: StableTurnErrorCode::ModelInvocationFailed,
            message: "Model invocation failed".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn model_configuration() -> Self {
        Self {
            code: StableTurnErrorCode::ModelConfiguration,
            message: "Model or provider configuration is missing or invalid".into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn provider_credentials() -> Self {
        Self {
            code: StableTurnErrorCode::ProviderCredentials,
            message: "Provider credentials are missing or unavailable".into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn rate_limited() -> Self {
        Self {
            code: StableTurnErrorCode::RateLimited,
            message: "Provider rate limit reached".into(),
            retryable: true,
            http_status: Some(429),
        }
    }

    pub fn connection_failed() -> Self {
        Self {
            code: StableTurnErrorCode::ConnectionFailed,
            message: "Could not connect to the provider".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn provider_unavailable() -> Self {
        Self {
            code: StableTurnErrorCode::ProviderUnavailable,
            message: "Provider is overloaded".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn provider_http(status: u16) -> Self {
        Self {
            code: if matches!(status, 401 | 403) {
                StableTurnErrorCode::ProviderAuth
            } else {
                StableTurnErrorCode::ProviderHttp
            },
            message: format!("Provider returned HTTP {status}"),
            retryable: status >= 500,
            http_status: Some(status),
        }
    }

    pub fn context_overflow() -> Self {
        Self {
            code: StableTurnErrorCode::ContextOverflow,
            message: "The model context window was exceeded".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn provider_auth() -> Self {
        Self {
            code: StableTurnErrorCode::ProviderAuth,
            message: "Model provider authentication failed".into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn invalid_request() -> Self {
        Self {
            code: StableTurnErrorCode::InvalidRequest,
            message: "The model rejected an invalid request".into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn invalid_response() -> Self {
        Self {
            code: StableTurnErrorCode::InvalidResponse,
            message: "The model returned an invalid response".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn completion_persistence_failed() -> Self {
        Self {
            code: StableTurnErrorCode::CompletionPersistenceFailed,
            message: "Turn completion could not be persisted".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn interaction_deadline_elapsed() -> Self {
        Self {
            code: StableTurnErrorCode::InteractionDeadlineElapsed,
            message: "Interaction deadline elapsed before a response was received".into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn tool_repetition() -> Self {
        Self {
            code: StableTurnErrorCode::ToolRepetition,
            message: "The same failing tool call was repeated too many times".into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn usage_limited() -> Self {
        Self {
            code: StableTurnErrorCode::UsageLimited,
            message: "Model provider usage limit reached".into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn change_capture_failed() -> Self {
        Self {
            code: StableTurnErrorCode::WorktreeCaptureFailed,
            message: "Turn change baseline could not be captured".into(),
            retryable: true,
            http_status: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum StableTurnErrorCode {
    PolicyCircuitBreaker,
    ModelInvocationFailed,
    ModelConfiguration,
    ProviderCredentials,
    RateLimited,
    ConnectionFailed,
    ProviderUnavailable,
    ProviderHttp,
    ContextOverflow,
    ProviderAuth,
    InvalidRequest,
    InvalidResponse,
    CompletionPersistenceFailed,
    InteractionDeadlineElapsed,
    ToolRepetition,
    UsageLimited,
    WorktreeCaptureFailed,
}
