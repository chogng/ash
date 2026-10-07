use super::ContextBudget;
use super::ContextBudgetError;
use super::ContextTokenCount;
use super::ContextTokenMeasurement;
use super::ResolvedContextBudget;

/// Pure, provider-neutral budget assessor for one assembled candidate request.
pub struct ContextBudgetPlanner;

impl ContextBudgetPlanner {
    /// Compares a precise or conservative input measurement with both context boundaries.
    ///
    /// Callers should pass the best available pre-invocation measurement: an exact local tokenizer
    /// or provider preflight result when supported, otherwise a conservative accounted estimate.
    pub fn assess(
        budget: ContextBudget,
        measurement: ContextTokenMeasurement,
    ) -> Result<ContextBudgetAssessment, ContextBudgetError> {
        let decision = match budget.resolve()? {
            ResolvedContextBudget::ProviderManaged => ContextBudgetDecision::ProviderManaged,
            ResolvedContextBudget::CoreManaged(limits) => {
                let accounted_input = measurement.accounted_input();
                if accounted_input > limits.hard_maximum_input() {
                    ContextBudgetDecision::ExceedsContextWindow {
                        accounted_input,
                        hard_limit: limits.hard_maximum_input(),
                        overage: subtract(accounted_input, limits.hard_maximum_input()),
                    }
                } else if accounted_input > limits.maximum_input() {
                    ContextBudgetDecision::NeedsCompaction {
                        accounted_input,
                        pressure_limit: limits.maximum_input(),
                        hard_limit: limits.hard_maximum_input(),
                        overage: subtract(accounted_input, limits.maximum_input()),
                    }
                } else {
                    ContextBudgetDecision::Fits {
                        accounted_input,
                        pressure_limit: limits.maximum_input(),
                        hard_limit: limits.hard_maximum_input(),
                        remaining_before_pressure: subtract(
                            limits.maximum_input(),
                            accounted_input,
                        ),
                    }
                }
            }
        };
        Ok(ContextBudgetAssessment {
            measurement,
            decision,
        })
    }
}

/// Measurement plus the resulting pressure or hard-window decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextBudgetAssessment {
    measurement: ContextTokenMeasurement,
    decision: ContextBudgetDecision,
}

impl ContextBudgetAssessment {
    pub const fn measurement(&self) -> &ContextTokenMeasurement {
        &self.measurement
    }

    pub const fn decision(&self) -> &ContextBudgetDecision {
        &self.decision
    }
}

/// The action implied by an input measurement at the configured pressure and hard boundaries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextBudgetDecision {
    /// The selected model has no verified limits, so the engine makes no fit claim.
    ProviderManaged,
    Fits {
        accounted_input: ContextTokenCount,
        pressure_limit: ContextTokenCount,
        hard_limit: ContextTokenCount,
        remaining_before_pressure: ContextTokenCount,
    },
    NeedsCompaction {
        accounted_input: ContextTokenCount,
        pressure_limit: ContextTokenCount,
        hard_limit: ContextTokenCount,
        overage: ContextTokenCount,
    },
    ExceedsContextWindow {
        accounted_input: ContextTokenCount,
        hard_limit: ContextTokenCount,
        overage: ContextTokenCount,
    },
}

const fn subtract(total: ContextTokenCount, used: ContextTokenCount) -> ContextTokenCount {
    ContextTokenCount::new(total.get().saturating_sub(used.get()))
}

#[cfg(test)]
#[path = "planner_tests.rs"]
mod tests;
