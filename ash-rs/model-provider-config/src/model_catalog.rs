use crate::StaticModelSpec;
use crate::static_model_spec::static_model;
use ash_protocol::ModelRef;

/// The sole product-level text model catalog, independent of accounts and connections.
/// Array order is the stable display order; unknown metadata stays unknown.
pub const STATIC_MODEL_CATALOG: &[StaticModelSpec] = &[
    static_model! {
        provider: "openai",
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        context_window: 1_050_000,
        capabilities: {
            tools: supported,
            reasoning: supported,
            parallel_tool_calls: supported,
            image_detail_original: supported,
        },
        reasoning: [low, medium, high, extra_high, max],
    },
    static_model! {
        provider: "openai",
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
    },
    static_model! {
        provider: "openai",
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.6",
        name: "GPT-5.6",
        capabilities: {
            image_detail_original: supported,
        },
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT-5.2",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5.1",
        name: "GPT-5.1",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
    },
    static_model! {
        provider: "openai",
        id: "gpt-5-nano",
        name: "GPT-5 Nano",
    },
    static_model! {
        provider: "openai",
        id: "gpt-4.1",
        name: "GPT-4.1",
    },
    static_model! {
        provider: "openai",
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
    },
    static_model! {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
    },
    static_model! {
        provider: "openai",
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
    },
    static_model! {
        provider: "openai",
        id: "o3",
        name: "o3",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-fable-5-1",
        name: "Claude Fable 5.1",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
    },
    static_model! {
        provider: "anthropic",
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.5-flash-lite",
        name: "Gemini 3.5 Flash-Lite",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.1-flash-lite",
        name: "Gemini 3.1 Flash-Lite",
    },
    static_model! {
        provider: "google",
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
    },
    static_model! {
        provider: "google",
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
    },
    static_model! {
        provider: "xai",
        id: "grok-4.7",
        name: "Grok 4.7",
    },
    static_model! {
        provider: "xai",
        id: "grok-4.6",
        name: "Grok 4.6",
    },
    static_model! {
        provider: "xai",
        id: "grok-4.5",
        name: "Grok 4.5",
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.8-max",
        name: "Qwen 3.8 Max",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.8-flash",
        name: "Qwen 3.8 Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.7-max",
        name: "Qwen 3.7 Max",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.7-plus",
        name: "Qwen 3.7 Plus",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.7-flash",
        name: "Qwen 3.7 Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.6-flash",
        name: "Qwen 3.6 Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.5-plus",
        name: "Qwen 3.5 Plus",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3.5-flash",
        name: "Qwen 3.5 Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-max",
        name: "Qwen 3 Max",
        context_window: 256_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-coder-next",
        name: "Qwen 3 Coder Next",
        context_window: 256_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-coder-plus",
        name: "Qwen 3 Coder Plus",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen3-coder-flash",
        name: "Qwen 3 Coder Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "qwen",
        id: "qwen-plus",
        name: "Qwen Plus",
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k3",
        name: "Kimi K3",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        context_window: 256_000,
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.6",
        name: "Kimi K2.6",
    },
    static_model! {
        provider: "kimi",
        id: "kimi-k2.5",
        name: "Kimi K2.5",
    },
    static_model! {
        provider: "deepseek",
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
    },
    static_model! {
        provider: "zai",
        id: "glm-5.3",
        name: "GLM-5.3",
    },
    static_model! {
        provider: "zai",
        id: "glm-5.3-flash",
        name: "GLM-5.3 Flash",
    },
    static_model! {
        provider: "zai",
        id: "glm-5.3-flashx",
        name: "GLM-5.3 FlashX",
    },
    static_model! {
        provider: "zai",
        id: "glm-5.2",
        name: "GLM-5.2",
    },
    static_model! {
        provider: "zai",
        id: "glm-5.1",
        name: "GLM-5.1",
    },
    static_model! {
        provider: "zai",
        id: "glm-5-turbo",
        name: "GLM-5 Turbo",
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M3",
        name: "MiniMax M3",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.7-highspeed",
        name: "MiniMax M2.7 Highspeed",
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.1",
        name: "MiniMax M2.1",
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2.1-highspeed",
        name: "MiniMax M2.1 Highspeed",
        context_window: 204_800,
    },
    static_model! {
        provider: "minimax",
        id: "MiniMax-M2",
        name: "MiniMax M2",
        context_window: 204_800,
    },
    static_model! {
        provider: "mimo",
        id: "mimo-v2.6-pro",
        name: "MiMo V2.6 Pro",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "mimo",
        id: "mimo-v2.6-flash",
        name: "MiMo V2.6 Flash",
        context_window: 1_000_000,
    },
    static_model! {
        provider: "mimo",
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
    },
];

/// Finds a model by its stable vendor and model identity.
pub fn find_static_model(model: &ModelRef) -> Option<&'static StaticModelSpec> {
    STATIC_MODEL_CATALOG.iter().find(|spec| {
        spec.provider_id == model.provider.as_str() && spec.model_id == model.model.as_str()
    })
}

pub(crate) fn attach_static_models(definitions: &mut [crate::ProviderDefinition]) {
    for definition in definitions {
        definition.models = STATIC_MODEL_CATALOG
            .iter()
            .filter(|spec| spec.provider_id == definition.id.as_str())
            .map(StaticModelSpec::model)
            .collect();
    }
}
