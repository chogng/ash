use super::default_provider;
use crate::ApiKeyHeader;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ProviderAdapter;
use crate::ProviderDefinition;

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "google",
        "Google",
        ProviderAdapter::Google,
        ApiProfile::OpenAiChatCompletions,
        "https://generativelanguage.googleapis.com/v1beta/openai",
    )
    .with_api_key_header(ApiKeyHeader::Bearer)
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::provider_default(
            InputTokenCountProfile::GoogleGenerateContent,
            "https://generativelanguage.googleapis.com/v1beta",
        )
        .with_models(
            crate::STATIC_MODEL_CATALOG
                .iter()
                .filter(|model| model.provider_id == "google")
                .map(|model| model.model().id),
        ),
    );
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("gemini-3.6-flash").expect("built-in model ID"),
    };
    definition
}
