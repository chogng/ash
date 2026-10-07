use super::ContextBudget;
use super::ContextTokenCount;
use ash_context_engine::ResolvedContextBudget;
use ash_protocol::ModelInputEstimate;
use ash_protocol::ModelRef;
use ash_protocol::ModelUsage;
use std::fmt;

pub(crate) const CONTEXT_CALIBRATION_REVISION: &str = "usage-underestimate-asymmetric-ema-v1";

const RATIO_SCALE: u64 = 1_000_000;
const DECAY_WEIGHT: u64 = 3;

/// Thread-local calibration derived from durable invocation estimate and usage facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ContextCalibration {
    model: ModelRef,
    estimator_revision: String,
    calibration_revision: String,
    correction_ratio_ppm: u64,
    samples: u64,
}

impl ContextCalibration {
    pub(crate) fn matches(&self, model: &ModelRef, estimator_revision: &str) -> bool {
        &self.model == model && self.estimator_revision == estimator_revision
    }

    pub(crate) const fn correction_ratio_ppm(&self) -> u64 {
        self.correction_ratio_ppm
    }

    #[cfg(test)]
    pub(crate) const fn samples(&self) -> u64 {
        self.samples
    }
}

pub(crate) fn next_context_calibrations(
    calibrations: &[ContextCalibration],
    model: &ModelRef,
    estimate: &ModelInputEstimate,
    usage: Option<&ModelUsage>,
) -> Result<Vec<ContextCalibration>, ContextCalibrationError> {
    validate_estimate(estimate)?;
    let Some(reported_input) = usage.and_then(reported_input_tokens) else {
        return Ok(calibrations.to_vec());
    };
    let observed_ratio_ppm = observed_ratio(estimate.estimated_input_tokens, reported_input);
    let mut next = calibrations.to_vec();
    if let Some(calibration) = next
        .iter_mut()
        .find(|calibration| calibration.matches(model, &estimate.estimator_revision))
    {
        if calibration.calibration_revision != estimate.calibration_revision {
            return Err(ContextCalibrationError::UnsupportedRevision);
        }
        calibration.correction_ratio_ppm = if observed_ratio_ppm >= calibration.correction_ratio_ppm
        {
            observed_ratio_ppm
        } else {
            divide_rounding_up(
                u128::from(calibration.correction_ratio_ppm) * u128::from(DECAY_WEIGHT)
                    + u128::from(observed_ratio_ppm),
                u128::from(DECAY_WEIGHT + 1),
            )
            .min(u128::from(u64::MAX)) as u64
        };
        calibration.samples = calibration
            .samples
            .checked_add(1)
            .ok_or(ContextCalibrationError::SampleOverflow)?;
    } else {
        next.push(ContextCalibration {
            model: model.clone(),
            estimator_revision: estimate.estimator_revision.clone(),
            calibration_revision: estimate.calibration_revision.clone(),
            correction_ratio_ppm: observed_ratio_ppm,
            samples: 1,
        });
    }
    Ok(next)
}

/// Applies a calibrated underestimate ratio only to a Core-managed budget.
///
/// The reduction is based on hard input capacity so both ordinary planning and independent
/// compaction requests remain conservative. Provider-managed budgets deliberately remain
/// provider-managed because they expose no verified capacity to adjust.
pub(crate) fn calibrated_budget(
    budget: ContextBudget,
    calibration: Option<&ContextCalibration>,
) -> Result<ContextBudget, ContextCalibrationError> {
    let Some(calibration) = calibration else {
        return Ok(budget);
    };
    if calibration.correction_ratio_ppm() <= RATIO_SCALE {
        return Ok(budget);
    }
    let ResolvedContextBudget::CoreManaged(limits) = budget
        .resolve()
        .map_err(|_| ContextCalibrationError::InvalidBudget)?
    else {
        return Ok(budget);
    };
    let hard_capacity = u128::from(limits.hard_maximum_input().get());
    let calibrated_hard_capacity =
        hard_capacity * u128::from(RATIO_SCALE) / u128::from(calibration.correction_ratio_ppm());
    let ideal_reduction = hard_capacity.saturating_sub(calibrated_hard_capacity);
    let maximum_reduction = u128::from(limits.maximum_input().get().saturating_sub(1));
    let reduction = ideal_reduction
        .min(maximum_reduction)
        .min(u128::from(u32::MAX)) as u32;
    Ok(budget.with_input_capacity_reduction(ContextTokenCount::new(reduction)))
}

fn validate_estimate(estimate: &ModelInputEstimate) -> Result<(), ContextCalibrationError> {
    if estimate.estimated_input_tokens == 0 || estimate.estimator_revision.trim().is_empty() {
        return Err(ContextCalibrationError::InvalidEstimate);
    }
    if estimate.calibration_revision != CONTEXT_CALIBRATION_REVISION {
        return Err(ContextCalibrationError::UnsupportedRevision);
    }
    Ok(())
}

fn reported_input_tokens(usage: &ModelUsage) -> Option<u64> {
    usage
        .input_tokens
        .map(|input| input.max(usage.cached_input_tokens.unwrap_or_default()))
}

fn observed_ratio(estimated_input: u64, reported_input: u64) -> u64 {
    let scaled = u128::from(reported_input) * u128::from(RATIO_SCALE);
    divide_rounding_up(scaled, u128::from(estimated_input))
        .max(u128::from(RATIO_SCALE))
        .min(u128::from(u64::MAX)) as u64
}

fn divide_rounding_up(value: u128, divisor: u128) -> u128 {
    value.div_ceil(divisor)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContextCalibrationError {
    InvalidBudget,
    InvalidEstimate,
    UnsupportedRevision,
    SampleOverflow,
}

impl fmt::Display for ContextCalibrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBudget => {
                formatter.write_str("context calibration exhausted input capacity")
            }
            Self::InvalidEstimate => formatter.write_str(
                "context calibration requires a positive estimate and estimator revision",
            ),
            Self::UnsupportedRevision => {
                formatter.write_str("unsupported context calibration revision")
            }
            Self::SampleOverflow => {
                formatter.write_str("context calibration sample count overflowed")
            }
        }
    }
}

#[cfg(test)]
#[path = "calibration_tests.rs"]
mod tests;
