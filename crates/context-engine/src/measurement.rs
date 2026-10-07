use super::ContextTokenCount;
use std::fmt;

/// Stable category describing where a pre-invocation token measurement came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextTokenMeasurementSourceKind {
    ProviderPreflight,
    LocalTokenizer,
    Heuristic,
}

/// Identifies the implementation that produced a pre-invocation input count.
///
/// Source is deliberately independent from accuracy. A provider preflight endpoint may return an
/// exact count or an estimate, depending on the provider contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextTokenMeasurementSource {
    kind: ContextTokenMeasurementSourceKind,
    revision: String,
}

impl ContextTokenMeasurementSource {
    pub fn provider_preflight(
        revision: impl Into<String>,
    ) -> Result<Self, ContextTokenMeasurementError> {
        Self::new(
            ContextTokenMeasurementSourceKind::ProviderPreflight,
            revision,
        )
    }

    pub fn local_tokenizer(
        revision: impl Into<String>,
    ) -> Result<Self, ContextTokenMeasurementError> {
        Self::new(ContextTokenMeasurementSourceKind::LocalTokenizer, revision)
    }

    pub fn heuristic(revision: impl Into<String>) -> Result<Self, ContextTokenMeasurementError> {
        Self::new(ContextTokenMeasurementSourceKind::Heuristic, revision)
    }

    fn new(
        kind: ContextTokenMeasurementSourceKind,
        revision: impl Into<String>,
    ) -> Result<Self, ContextTokenMeasurementError> {
        let revision = revision.into();
        if revision.trim().is_empty() {
            return Err(ContextTokenMeasurementError::MissingSourceRevision);
        }
        Ok(Self { kind, revision })
    }

    pub const fn kind(&self) -> ContextTokenMeasurementSourceKind {
        self.kind
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

/// Describes whether the reported count is exact for the selected model or conservative.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextTokenMeasurementAccuracy {
    Exact,
    Estimated,
}

/// Cost category used by the caller to decide when input measurement is worth performing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextTokenMeasurementCapability {
    Unavailable,
    Local,
    Remote,
}

/// Result of asking a model integration to measure one candidate request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextTokenMeasurementOutcome {
    Unavailable,
    Measured(ContextTokenMeasurement),
}

/// A validated input-token measurement for one fully assembled candidate request.
///
/// Exact measurements account their exact count. Estimates account a caller-supplied conservative
/// value so an optimistic expected value is not used directly at a budget boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextTokenMeasurement {
    measured_input: ContextTokenCount,
    accounted_input: ContextTokenCount,
    accuracy: ContextTokenMeasurementAccuracy,
    source: ContextTokenMeasurementSource,
}

impl ContextTokenMeasurement {
    pub const fn exact(
        input_tokens: ContextTokenCount,
        source: ContextTokenMeasurementSource,
    ) -> Self {
        Self {
            measured_input: input_tokens,
            accounted_input: input_tokens,
            accuracy: ContextTokenMeasurementAccuracy::Exact,
            source,
        }
    }

    pub fn estimated(
        expected_input: ContextTokenCount,
        conservative_input: ContextTokenCount,
        source: ContextTokenMeasurementSource,
    ) -> Result<Self, ContextTokenMeasurementError> {
        if conservative_input < expected_input {
            return Err(ContextTokenMeasurementError::AccountedInputBelowMeasurement);
        }
        Ok(Self {
            measured_input: expected_input,
            accounted_input: conservative_input,
            accuracy: ContextTokenMeasurementAccuracy::Estimated,
            source,
        })
    }

    pub const fn measured_input(&self) -> ContextTokenCount {
        self.measured_input
    }

    /// Returns the conservative count used for budget decisions.
    pub const fn accounted_input(&self) -> ContextTokenCount {
        self.accounted_input
    }

    pub const fn accuracy(&self) -> ContextTokenMeasurementAccuracy {
        self.accuracy
    }

    pub const fn source(&self) -> &ContextTokenMeasurementSource {
        &self.source
    }
}

/// Invalid provenance or conservative accounting supplied for a token measurement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextTokenMeasurementError {
    MissingSourceRevision,
    AccountedInputBelowMeasurement,
}

impl fmt::Display for ContextTokenMeasurementError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSourceRevision => {
                formatter.write_str("token measurement sources require a non-empty revision")
            }
            Self::AccountedInputBelowMeasurement => formatter.write_str(
                "conservative accounted input must be greater than or equal to the measured count",
            ),
        }
    }
}

impl std::error::Error for ContextTokenMeasurementError {}

#[cfg(test)]
#[path = "measurement_tests.rs"]
mod tests;
