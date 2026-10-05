use super::ProviderAdapter;
use ash_api::ApiEndpoint;
use model_provider_info::NormalizedModelProviderConfig;

pub(crate) struct DeepSeekAdapter {
    endpoint: ApiEndpoint,
}

impl DeepSeekAdapter {
    pub(crate) fn new(config: &NormalizedModelProviderConfig) -> Self {
        let endpoint = match config.api_profile {
            model_provider_info::ApiProfile::OpenAiChatCompletions => {
                ApiEndpoint::DeepSeekChatCompletions
            }
            profile => super::api_endpoint(profile),
        };
        Self { endpoint }
    }
}

impl ProviderAdapter for DeepSeekAdapter {
    fn endpoint(&self) -> ApiEndpoint {
        self.endpoint
    }
}
