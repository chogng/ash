use super::default_provider;
use crate::ApiKeyHeader;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ProviderAdapter;
use crate::ProviderDefaults;
use crate::ProviderDefinition;

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "anthropic",
        "Anthropic",
        ProviderAdapter::Anthropic,
        ApiProfile::AnthropicMessages,
        "https://api.anthropic.com",
    )
    .with_api_key_header(ApiKeyHeader::XApiKey)
    .with_native_streaming()
    .with_input_token_count(InputTokenCountDefinition::invocation_base(
        InputTokenCountProfile::AnthropicMessages,
    ))
    .with_defaults(ProviderDefaults {
        max_output_tokens: Some(1024),
        ..ProviderDefaults::default()
    })
}
