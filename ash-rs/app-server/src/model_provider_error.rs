use core_api::CoreError;
use ash_model_provider::ApiError;
use ash_model_provider::ModelProviderError;
use ash_protocol::StableTurnError;

pub(super) fn map_model_provider_error(error: ModelProviderError) -> CoreError {
    if let ModelProviderError::Cancelled(message) = &error {
        return CoreError::Cancelled(message.clone());
    }

    let retry_after_ms = error
        .retry_after()
        .and_then(|delay| u64::try_from(delay.as_millis()).ok());
    let mapped = match &error {
        ModelProviderError::ConfigurationMissing
        | ModelProviderError::Config(_)
        | ModelProviderError::ModelNotRegistered { .. } => {
            CoreError::ModelFailure(StableTurnError::model_configuration())
        }
        ModelProviderError::Credential(_) => {
            CoreError::ModelFailure(StableTurnError::provider_credentials())
        }
        ModelProviderError::Api(ApiError::RateLimited { .. }) => CoreError::ModelTransient {
            failure: StableTurnError::rate_limited(),
            retry_after_ms,
        },
        ModelProviderError::Api(ApiError::Transport(_)) => CoreError::ModelTransient {
            failure: StableTurnError::connection_failed(),
            retry_after_ms,
        },
        ModelProviderError::Api(ApiError::Overloaded) => CoreError::ModelTransient {
            failure: StableTurnError::provider_unavailable(),
            retry_after_ms,
        },
        ModelProviderError::Api(ApiError::HttpStatus(status)) => {
            let failure = StableTurnError::provider_http(*status);
            if failure.retryable {
                CoreError::ModelTransient {
                    failure,
                    retry_after_ms,
                }
            } else {
                CoreError::ModelFailure(failure)
            }
        }

        ModelProviderError::ContextOverflow(_)
        | ModelProviderError::Api(ApiError::ContextOverflow(_)) => CoreError::ModelContextOverflow,
        ModelProviderError::AuthFailed(_) | ModelProviderError::Api(ApiError::AuthFailed(_)) => {
            CoreError::ModelAuthFailed
        }
        ModelProviderError::InvalidRequest(_)
        | ModelProviderError::Api(ApiError::InvalidRequest(_)) => CoreError::ModelInvalidRequest,
        ModelProviderError::InvalidResponse(_)
        | ModelProviderError::Api(ApiError::InvalidResponse(_)) => CoreError::ModelInvalidResponse,
        ModelProviderError::Api(ApiError::UsageLimited) => CoreError::ModelUsageLimited,
        _ => CoreError::Model("model invocation failed".into()),
    };
    log::debug!("model provider invocation failed: {error:?}");
    mapped
}

#[cfg(test)]
#[path = "model_provider_error_tests.rs"]
mod tests;
