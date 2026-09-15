use super::ContextBudget;
use super::ContextTokenCount;
use ash_context_engine::ContextBudgetDecision;
use ash_context_engine::ContextBudgetPlanner;
use ash_context_engine::ContextTokenMeasurement;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ResolvedContextBudget;
use std::fmt;

const REMOTE_MEASUREMENT_MINIMUM_HEADROOM: ContextTokenCount = ContextTokenCount::new(4_096);
const MAXIMUM_MEASUREMENT_REPLANS: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContextMeasurementDisposition {
    Ready,
    Replan,
}

/// Invocation-local policy for deciding when provider token preflight is worth its latency.
///
/// Deterministic local tokenizers run for every candidate. Remote preflight runs only near the
/// ordinary pressure boundary or after compaction. Measured estimator error is converted into a
/// conservative input-capacity reduction for the next deterministic Core plan.
#[derive(Default)]
pub(crate) struct ContextMeasurementPolicy {
    input_capacity_reduction: ContextTokenCount,
    force_next_measurement: bool,
    replans: u8,
}

impl ContextMeasurementPolicy {
    pub(crate) fn adjusted_budget(&self, budget: ContextBudget) -> ContextBudget {
        budget.with_input_capacity_reduction(self.input_capacity_reduction)
    }

    pub(crate) fn should_measure(
        &self,
        budget: ContextBudget,
        estimated_input: ContextTokenCount,
        capability: ContextTokenMeasurementCapability,
    ) -> Result<bool, ContextMeasurementPolicyError> {
        match capability {
            ContextTokenMeasurementCapability::Unavailable => Ok(false),
            ContextTokenMeasurementCapability::Local => Ok(true),
            ContextTokenMeasurementCapability::Remote => {
                if self.force_next_measurement {
                    return Ok(true);
                }
                let ResolvedContextBudget::CoreManaged(limits) =
                    self.adjusted_budget(budget).resolve()?
                else {
                    return Ok(false);
                };
                let proportional_headroom =
                    ContextTokenCount::new(limits.maximum_input().get() / 10);
                let headroom = proportional_headroom.max(REMOTE_MEASUREMENT_MINIMUM_HEADROOM);
                Ok(estimated_input.saturating_add(headroom) >= limits.maximum_input())
            }
        }
    }

    pub(crate) fn assess(
        &mut self,
        budget: ContextBudget,
        estimated_input: ContextTokenCount,
        measurement: ContextTokenMeasurement,
    ) -> Result<ContextMeasurementDisposition, ContextMeasurementPolicyError> {
        let accounted_input = measurement.accounted_input();
        let assessment = ContextBudgetPlanner::assess(self.adjusted_budget(budget), measurement)?;
        match assessment.decision() {
            ContextBudgetDecision::ProviderManaged | ContextBudgetDecision::Fits { .. } => {
                self.force_next_measurement = false;
                Ok(ContextMeasurementDisposition::Ready)
            }
            ContextBudgetDecision::NeedsCompaction { .. }
            | ContextBudgetDecision::ExceedsContextWindow { .. } => {
                let estimator_error = accounted_input.saturating_sub(estimated_input);
                if estimator_error == ContextTokenCount::ZERO {
                    return Err(ContextMeasurementPolicyError::AdjustmentStalled);
                }
                if self.replans >= MAXIMUM_MEASUREMENT_REPLANS {
                    return Err(ContextMeasurementPolicyError::ReplanLimitReached);
                }
                self.input_capacity_reduction = self
                    .input_capacity_reduction
                    .saturating_add(estimator_error);
                self.force_next_measurement = true;
                self.replans += 1;
                Ok(ContextMeasurementDisposition::Replan)
            }
        }
    }

    pub(crate) fn note_compaction(&mut self) {
        self.force_next_measurement = true;
    }

    pub(crate) fn finish_invocation(&mut self) {
        *self = Self::default();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContextMeasurementPolicyError {
    InvalidBudget,
    AdjustmentStalled,
    ReplanLimitReached,
}

impl fmt::Display for ContextMeasurementPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBudget => formatter.write_str(
                "context budget leaves no input capacity after measured-token adjustment",
            ),
            Self::AdjustmentStalled => formatter.write_str(
                "measured input exceeds the context budget without a correctable estimator error",
            ),
            Self::ReplanLimitReached => formatter
                .write_str("input token measurement remained unstable after three context replans"),
        }
    }
}

impl From<ash_context_engine::ContextBudgetError> for ContextMeasurementPolicyError {
    fn from(_: ash_context_engine::ContextBudgetError) -> Self {
        Self::InvalidBudget
    }
}

#[cfg(test)]
#[path = "measurement_policy_tests.rs"]
mod tests;
