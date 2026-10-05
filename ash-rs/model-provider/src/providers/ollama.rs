use super::ProviderAdapter;
use super::api_endpoint;
use ash_api::ApiEndpoint;
use model_provider_info::NormalizedModelProviderConfig;

pub(crate) struct OllamaAdapter {
    endpoint: ApiEndpoint,
}

impl OllamaAdapter {
    pub(crate) fn new(config: &NormalizedModelProviderConfig) -> Self {
        Self {
            endpoint: api_endpoint(config.api_profile),
        }
    }
}

impl ProviderAdapter for OllamaAdapter {
    fn endpoint(&self) -> ApiEndpoint {
        self.endpoint
    }
}
