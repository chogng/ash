use super::ProviderAdapter;
use super::api_endpoint;
use ash_api::ApiEndpoint;
use model_provider_info::NormalizedModelProviderConfig;

pub(crate) struct XaiAdapter {
    endpoint: ApiEndpoint,
}

impl XaiAdapter {
    pub(crate) fn new(config: &NormalizedModelProviderConfig) -> Self {
        Self {
            endpoint: match config.api_profile {
                model_provider_info::ApiProfile::OpenAiChatCompletions => {
                    ApiEndpoint::XaiChatCompletions
                }
                _ => api_endpoint(config.api_profile),
            },
        }
    }
}

impl ProviderAdapter for XaiAdapter {
    fn endpoint(&self) -> ApiEndpoint {
        self.endpoint
    }
}
