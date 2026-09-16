use super::default_provider;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ProviderAdapter;
use crate::ProviderDefinition;
use crate::WebSocketApiProfile;

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "openai",
        "OpenAI",
        ProviderAdapter::OpenAi,
        ApiProfile::OpenAiResponses,
        "https://api.openai.com/v1",
    )
    .with_native_streaming()
    .with_websocket_api_profile(WebSocketApiProfile::OpenAiResponses)
    .with_realtime_api_profile(crate::RealtimeApiProfile::OpenAiRealtime)
    .with_live_api_profile(crate::LiveApiProfile::OpenAiLive)
    .with_input_token_count(InputTokenCountDefinition::invocation_base(
        InputTokenCountProfile::OpenAiResponses,
    ))
}
