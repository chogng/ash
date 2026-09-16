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
    .with_voice_models(crate::VoiceModelCatalog {
        default_model: crate::ModelId::new("gpt-live-1").expect("built-in voice model"),
        models: vec![crate::VoiceModelDefinition {
            id: crate::ModelId::new("gpt-live-1").expect("built-in voice model"),
            default_voice: "marin".into(),
            voices: [
                "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta",
                "echo", "gleam", "marin", "meridian", "quartz", "ripple", "sage", "shimmer",
                "stone", "tempo", "verse", "vesper", "willow",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        }],
    })
    .with_input_token_count(InputTokenCountDefinition::invocation_base(
        InputTokenCountProfile::OpenAiResponses,
    ))
}
