use crate::context::CompactionPlan;
use crate::context::ContextInput;
use crate::context::ContextPlanner;
use crate::context::ContextPreparation;
use crate::context::ContextPreparationError;

/// Coordinates context preparation for one loaded Thread without owning canonical history.
///
/// The first implementation intentionally holds no plan cache, reference baseline, or token
/// estimate. Dropping it and preparing again from the same durable facts must produce an
/// equivalent plan.
#[derive(Default)]
pub(crate) struct ContextManager {
    observed_thread_sequence: u64,
}

impl ContextManager {
    pub(crate) fn prepare(
        &mut self,
        input: &ContextInput,
    ) -> Result<ContextPreparation, ContextPreparationError> {
        self.validate_sequence(input)?;
        let preparation = ContextPlanner::prepare(input)?;
        self.observed_thread_sequence = input.source_thread_sequence();
        Ok(preparation)
    }

    pub(crate) fn prepare_overflow_recovery(
        &mut self,
        input: &ContextInput,
    ) -> Result<CompactionPlan, ContextPreparationError> {
        self.validate_sequence(input)?;
        let plan = ContextPlanner::prepare_overflow_recovery(input)?;
        self.observed_thread_sequence = input.source_thread_sequence();
        Ok(plan)
    }

    pub(crate) fn prepare_manual_compaction(
        &mut self,
        input: &ContextInput,
        retention_prompt: Option<&str>,
    ) -> Result<CompactionPlan, ContextPreparationError> {
        self.validate_sequence(input)?;
        let plan = ContextPlanner::prepare_manual_compaction(input, retention_prompt)?;
        self.observed_thread_sequence = input.source_thread_sequence();
        Ok(plan)
    }

    fn validate_sequence(&self, input: &ContextInput) -> Result<(), ContextPreparationError> {
        if input.source_thread_sequence() < self.observed_thread_sequence {
            return Err(ContextPreparationError::UnsupportedContextShape(format!(
                "context input sequence {} is older than observed Thread sequence {}",
                input.source_thread_sequence(),
                self.observed_thread_sequence
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "context_manager_tests.rs"]
mod tests;
