use crate::ApprovalReviewModelDefault;
use crate::InputTokenCountModelPolicy;
use crate::ProviderAccessMode;
use crate::ProviderDefinition;
use crate::StaticModelSpec;
use crate::static_model_spec::static_model;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;

/// The sole product-level list of built-in models.
///
/// Every row requires `provider`, `id`, `name`, and `access`. Optional named fields are
/// `context_window`, `auto_compact_token_limit`, `capabilities`, `reasoning`,
/// `model_reasoning_effort`, `default_personality`, `input_token_count`, and
/// `approval_review_default`. Omitted metadata stays unknown, absent, or false. Use
/// `context_window: 1_000_000` for a 1M model. Array order is the display order within a provider.
pub const STATIC_MODEL_CATALOG: &[StaticModelSpec] = &[
    // ChatGPT subscription models.
    static_model! {
        provider: "openai",
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    static_model! {
        provider: "openai",
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    static_model! {
        provider: "openai",
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        access: subscription,
        runtime: chatgpt_subscription,
    },
    // Direct API-key models.
    static_model! {
        provider: "openai",
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        access: api_key,
        context_window: 1_050_000,
        capabilities: {
            tools: supported,
            reasoning: supported,
            parallel_tool_calls: supported,
            image_detail_original: supported,
        },
        reasoning: [low, medium, high, extra_high, max],
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6",
        name: "GPT-5.6",
        access: api_key,
        capabilities: {
            image_detail_original: supported,
        },
        input_token_count: true,
        approval_review_default: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT-5.2",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.1",
        name: "GPT-5.1",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-5-nano",
        name: "GPT-5 Nano",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-4.1",
        name: "GPT-4.1",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "openai",
        id: "o3",
        name: "o3",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "anthropic",
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        access: api_key,
        input_token_count: true,
        approval_review_default: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.5-flash-lite",
        name: "Gemini 3.5 Flash-Lite",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.1-flash-lite",
        name: "Gemini 3.1 Flash-Lite",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "google",
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "xai",
        id: "grok-4.7",
        name: "Grok 4.7",
        access: api_key,
    },
    static_model! {
        provider: "xai",
        id: "grok-4.6",
        name: "Grok 4.6",
        access: api_key,
    },
    static_model! {
        provider: "xai",
        id: "grok-4.5",
        name: "Grok 4.5",
        access: api_key,
        approval_review_default: true,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.8-max",
        name: "Qwen 3.8 Max",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.8-flash",
        name: "Qwen 3.8 Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.7-max",
        name: "Qwen 3.7 Max",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.7-plus",
        name: "Qwen 3.7 Plus",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.7-flash",
        name: "Qwen 3.7 Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.6-flash",
        name: "Qwen 3.6 Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.5-plus",
        name: "Qwen 3.5 Plus",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.5-flash",
        name: "Qwen 3.5 Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-max",
        name: "Qwen 3 Max",
        access: api_key,
        context_window: 256_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-coder-next",
        name: "Qwen 3 Coder Next",
        access: api_key,
        context_window: 256_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-coder-plus",
        name: "Qwen 3 Coder Plus",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-coder-flash",
        name: "Qwen 3 Coder Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen-plus",
        name: "Qwen Plus",
        access: api_key,
        approval_review_default: true,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k3",
        name: "Kimi K3",
        access: api_key,
        context_window: 1_000_000,
        input_token_count: true,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        access: api_key,
        context_window: 256_000,
        input_token_count: true,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        access: api_key,
        input_token_count: true,
        approval_review_default: true,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        access: subscription,
        runtime: kimi_code,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "deepseek",
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        access: api_key,
        approval_review_default: true,
    },
    static_model! {
        provider: "zai",
        id: "glm-5.3",
        name: "GLM-5.3",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "zai",
        id: "glm-5.3-flash",
        name: "GLM-5.3 Flash",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "zai",
        id: "glm-5.3-flashx",
        name: "GLM-5.3 FlashX",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "zai",
        id: "glm-5.2",
        name: "GLM-5.2",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "zai",
        id: "glm-5.1",
        name: "GLM-5.1",
        access: api_key,
        input_token_count: true,
        approval_review_default: true,
    },
    static_model! {
        provider: "bigmodel",
        id: "glm-5.2",
        name: "GLM-5.2",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "bigmodel",
        id: "glm-5-turbo",
        name: "GLM-5 Turbo",
        access: api_key,
        input_token_count: true,
    },
    static_model! {
        provider: "bigmodel",
        id: "glm-5.1",
        name: "GLM-5.1",
        access: api_key,
        input_token_count: true,
        approval_review_default: true,
    },
    static_model! {
        provider: "bigmodel-coding-plan",
        id: "glm-5.1",
        name: "GLM-5.1",
        access: subscription,
        runtime: glm_coding_plan,
        input_token_count: true,
    },
    static_model! {
        provider: "zai-coding-plan",
        id: "glm-5.3",
        name: "GLM-5.3",
        access: subscription,
        runtime: glm_coding_plan,
        input_token_count: true,
    },
    static_model! {
        provider: "zai-coding-plan",
        id: "glm-5.3-flash",
        name: "GLM-5.3 Flash",
        access: subscription,
        runtime: glm_coding_plan,
        input_token_count: true,
    },
    static_model! {
        provider: "zai-coding-plan",
        id: "glm-5.1",
        name: "GLM-5.1",
        access: subscription,
        runtime: glm_coding_plan,
        input_token_count: true,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M3",
        name: "MiniMax M3",
        access: api_key,
        context_window: 1_000_000,
        approval_review_default: true,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.7-highspeed",
        name: "MiniMax M2.7 Highspeed",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.1",
        name: "MiniMax M2.1",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.1-highspeed",
        name: "MiniMax M2.1 Highspeed",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2",
        name: "MiniMax M2",
        access: api_key,
        context_window: 204_800,
    },
    static_model! {
        provider: "mimo",
        id: "mimo-v2.6-pro",
        name: "MiMo V2.6 Pro",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "mimo",
        id: "mimo-v2.6-flash",
        name: "MiMo V2.6 Flash",
        access: api_key,
        context_window: 1_000_000,
    },
    static_model! {
        provider: "mimo",
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        access: api_key,
        approval_review_default: true,
    },
];

/// Finds the single static row owning a provider-scoped model identity.
pub fn find_static_model(model: &ModelRef) -> Option<&'static StaticModelSpec> {
    find_static_model_for_mode(model, ProviderAccessMode::Api)
}

pub fn find_static_model_for_mode(
    model: &ModelRef,
    mode: ProviderAccessMode,
) -> Option<&'static StaticModelSpec> {
    STATIC_MODEL_CATALOG.iter().find(|candidate| {
        candidate.provider_id == model.provider.as_str()
            && candidate.model_id == model.model.as_str()
            && matches!(candidate.access, ash_protocol::ModelAccess::Subscription)
                == (mode == ProviderAccessMode::Subscription)
    })
}

pub(crate) fn attach_static_models(definitions: &mut [ProviderDefinition]) {
    for spec in STATIC_MODEL_CATALOG {
        if spec.access == ash_protocol::ModelAccess::Subscription {
            continue;
        }
        let definition = definitions
            .iter_mut()
            .find(|definition| definition.id.as_str() == spec.provider_id)
            .unwrap_or_else(|| {
                panic!(
                    "static model '{}' names unknown provider '{}'",
                    spec.model_id, spec.provider_id
                )
            });
        definition.models.push(spec.model());
        if spec.supports_input_token_count {
            let input_token_count = definition.input_token_count.as_mut().unwrap_or_else(|| {
                panic!(
                    "static model '{}/{}' enables input token counting without a provider endpoint",
                    spec.provider_id, spec.model_id
                )
            });
            if let InputTokenCountModelPolicy::ListedModels { models } =
                &mut input_token_count.models
            {
                models.push(ModelId::new(spec.model_id).expect("static model ID is valid"));
            }
        }
        if spec.is_approval_review_default {
            assert!(
                matches!(
                    definition.defaults.approval_review_model,
                    ApprovalReviewModelDefault::ActiveModel
                ),
                "provider '{}' has multiple approval review defaults",
                spec.provider_id
            );
            definition.defaults.approval_review_model = ApprovalReviewModelDefault::Model {
                model: ModelId::new(spec.model_id).expect("static model ID is valid"),
            };
        }
    }
}

pub(crate) fn attach_subscription_models(definition: &mut ProviderDefinition) {
    definition.models = STATIC_MODEL_CATALOG
        .iter()
        .filter(|spec| {
            spec.provider_id == definition.id.as_str()
                && spec.access == ash_protocol::ModelAccess::Subscription
        })
        .map(StaticModelSpec::model)
        .collect();
}
