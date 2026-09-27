use ash_protocol::ContextWindow;
use ash_protocol::Model;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::Personality;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;

/// One row in Ash's product-level static model catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StaticModelSpec {
    pub provider_id: &'static str,
    pub model_id: &'static str,
    pub display_name: &'static str,
    pub context_window: ContextWindow,
    pub auto_compact_token_limit: Option<u32>,
    pub capabilities: ModelCapabilities,
    pub supported_reasoning_efforts: &'static [ReasoningEffort],
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
}

impl StaticModelSpec {
    /// Builds the runtime model identity represented by this static row.
    pub fn model_ref(&self) -> ModelRef {
        ModelRef::new(
            ProviderId::new(self.provider_id).expect("static provider ID is valid"),
            ModelId::new(self.model_id).expect("static model ID is valid"),
        )
    }

    /// Builds provider-neutral model metadata from this static row.
    pub fn model(&self) -> Model {
        let mut model = Model::new(
            ModelId::new(self.model_id).expect("static model ID is valid"),
            self.display_name,
        );
        model.context_window = self.context_window;
        model.auto_compact_token_limit = self.auto_compact_token_limit;
        model.capabilities = self.capabilities;
        model.supported_reasoning_efforts = self.supported_reasoning_efforts.to_vec();
        model.model_reasoning_effort = self.model_reasoning_effort;
        model.default_personality = self.default_personality;
        model
    }

    /// Whether the declared context window is exactly one million tokens.
    pub fn has_one_million_context(&self) -> bool {
        self.context_window == ContextWindow::Known(1_000_000)
    }
}

macro_rules! static_model {
    {
        provider: $provider:expr,
        id: $model:expr,
        name: $name:expr,
        $(context_window: $context_window:expr,)?
        $(auto_compact_token_limit: $auto_compact_token_limit:expr,)?
        $(capabilities: {
            $($capability:ident: $support:ident),* $(,)?
        },)?
        $(reasoning: [$($reasoning:ident),* $(,)?],)?
        $(model_reasoning_effort: $model_reasoning_effort:ident,)?
        $(default_personality: $default_personality:ident,)?
    } => {
        $crate::static_model_spec::StaticModelSpec {
            provider_id: $provider,
            model_id: $model,
            display_name: $name,
            context_window: static_model!(@context_window $($context_window)?),
            auto_compact_token_limit: static_model!(@optional_u32 $($auto_compact_token_limit)?),
            capabilities: ash_protocol::ModelCapabilities {
                $($(
                    $capability: static_model!(@support $support),
                )*)?
                ..ash_protocol::ModelCapabilities::UNKNOWN
            },
            supported_reasoning_efforts: &[$($(static_model!(@reasoning $reasoning)),*)?],
            model_reasoning_effort: static_model!(@optional_reasoning $($model_reasoning_effort)?),
            default_personality: static_model!(@optional_personality $($default_personality)?),
        }
    };



    (@context_window) => { ash_protocol::ContextWindow::Unknown };
    (@context_window $tokens:expr) => { ash_protocol::ContextWindow::Known($tokens) };
    (@optional_u32) => { None };
    (@optional_u32 $value:expr) => { Some($value) };

    (@support supported) => { ash_protocol::CapabilitySupport::Supported };
    (@support unsupported) => { ash_protocol::CapabilitySupport::Unsupported };
    (@support unknown) => { ash_protocol::CapabilitySupport::Unknown };

    (@reasoning none) => { ash_protocol::ReasoningEffort::None };
    (@reasoning minimal) => { ash_protocol::ReasoningEffort::Minimal };
    (@reasoning low) => { ash_protocol::ReasoningEffort::Low };
    (@reasoning medium) => { ash_protocol::ReasoningEffort::Medium };
    (@reasoning high) => { ash_protocol::ReasoningEffort::High };
    (@reasoning extra_high) => { ash_protocol::ReasoningEffort::ExtraHigh };
    (@reasoning max) => { ash_protocol::ReasoningEffort::Max };
    (@optional_reasoning) => { None };
    (@optional_reasoning $value:ident) => { Some(static_model!(@reasoning $value)) };

    (@personality friendly) => { ash_protocol::Personality::Friendly };
    (@personality pragmatic) => { ash_protocol::Personality::Pragmatic };
    (@personality none) => { ash_protocol::Personality::None };
    (@optional_personality) => { None };
    (@optional_personality $value:ident) => { Some(static_model!(@personality $value)) };
}

pub(crate) use static_model;

#[cfg(test)]
#[path = "static_model_spec_tests.rs"]
mod tests;
