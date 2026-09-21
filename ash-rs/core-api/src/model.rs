use crate::CoreError;
use ash_async_utils::CancellationToken;
use ash_context_engine::ContextBudget;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_protocol::ReasoningConfig;

/// Pixel and patch ceilings applied to one ephemeral provider-bound image clone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelImageInputLimits {
    pub max_dimension: u32,
    pub max_patches: usize,
}

impl ModelImageInputLimits {
    pub const fn new(max_dimension: u32, max_patches: usize) -> Self {
        Self {
            max_dimension,
            max_patches,
        }
    }
}

/// Provider/model-specific image limits selected before attachment materialization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelImageInputPolicy {
    auto: ModelImageInputLimits,
    low: ModelImageInputLimits,
    high: ModelImageInputLimits,
    original: ModelImageInputLimits,
}

impl ModelImageInputPolicy {
    pub const fn new(
        auto: ModelImageInputLimits,
        low: ModelImageInputLimits,
        high: ModelImageInputLimits,
        original: ModelImageInputLimits,
    ) -> Self {
        Self {
            auto,
            low,
            high,
            original,
        }
    }

    pub const fn limits_for(self, detail: ash_protocol::ImageDetail) -> ModelImageInputLimits {
        match detail {
            ash_protocol::ImageDetail::Auto => self.auto,
            ash_protocol::ImageDetail::Low => self.low,
            ash_protocol::ImageDetail::High => self.high,
            ash_protocol::ImageDetail::Original => self.original,
        }
    }
}

impl Default for ModelImageInputPolicy {
    fn default() -> Self {
        const LOW: ModelImageInputLimits = ModelImageInputLimits::new(512, 256);
        const STANDARD: ModelImageInputLimits = ModelImageInputLimits::new(2_048, 1_536);
        Self::new(STANDARD, LOW, STANDARD, STANDARD)
    }
}

/// Receives provider-neutral incremental output for one model invocation.
///
/// Implementations must preserve event order and should return an error when the receiving
/// execution can no longer safely consume a delta, such as after cancellation.
pub trait ModelStreamSink {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), CoreError>;
}

/// Selects the immutable model runtime used for one Turn.
///
/// Legacy Sessions without a durable selection use the resolved configuration default. New
/// Sessions pass their snapshotted model explicitly so later configuration or Session changes
/// cannot alter an already-started Turn.
#[derive(Clone, Copy)]
pub enum ModelSelection<'a> {
    ConfiguredDefault,
    Session(&'a ModelRef),
}

/// Executes one provider-independent model invocation.
///
/// Implementations receive a complete immutable request assembled by Core. They must not read
/// Thread state or mutable product configuration. Implementations should observe `cancellation`
/// before beginning expensive work and at every safe checkpoint supported by their transport.
pub trait ModelService: Send + Sync {
    /// Freezes a configuration-backed selector for one invocation. Already immutable services
    /// return `None`; callers retain that same service for preparation and invocation.
    fn snapshot(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<Option<std::sync::Arc<dyn ModelService>>, CoreError> {
        Ok(None)
    }

    /// Returns the verified billing surface for the selected immutable runtime.
    fn billing_scope(&self, _: ModelSelection<'_>) -> Result<ModelBillingScope, CoreError> {
        Ok(ModelBillingScope::Unavailable)
    }

    /// Returns the immutable context budget for the selected model invocation.
    ///
    /// Implementations should return a Core-managed budget only when the model window and product
    /// output reservation are known. Unknown or unlisted models retain provider-managed overflow
    /// behavior rather than receiving a fabricated context limit.
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::provider_managed())
    }

    /// Returns the provider/model image limits used only for the outbound request clone.
    ///
    /// Unknown adapters use a conservative product default. Implementations that can resolve an
    /// immutable provider/model snapshot should override this with that snapshot's declared
    /// policy; durable attachment bytes are never changed by this operation.
    fn image_input_policy(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ModelImageInputPolicy, CoreError> {
        Ok(ModelImageInputPolicy::default())
    }

    /// Reports whether the selected immutable model can measure input locally or remotely.
    fn reasoning_config(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<Option<ReasoningConfig>, CoreError> {
        Ok(None)
    }

    /// Reports whether the selected immutable model can measure input locally or remotely.
    fn input_token_measurement_capability(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ContextTokenMeasurementCapability, CoreError> {
        Ok(ContextTokenMeasurementCapability::Unavailable)
    }

    /// Measures one fully assembled candidate request before invocation.
    ///
    /// Implementations must measure the same immutable model and canonical request snapshot that
    /// [`Self::invoke`] receives. Post-response usage does not satisfy this contract.
    fn measure_input(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(ContextTokenMeasurementOutcome::Unavailable)
    }

    fn invoke(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError>;

    /// Returns the authoritative result and delivers incremental output when the service supports it.
    /// Synchronous services return only the result. They never synthesize deltas from completed text.
    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        _: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        self.invoke(selection, request, cancellation)
    }
}
