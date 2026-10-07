use std::fmt;

/// A token quantity used by context budgeting.
///
/// The newtype keeps context-window, output, safety, and measured-input values explicit at call
/// sites instead of passing unlabelled integers between providers and context planners.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct ContextTokenCount(u32);

impl ContextTokenCount {
    pub const ZERO: Self = Self(0);

    pub const fn new(tokens: u32) -> Self {
        Self(tokens)
    }

    pub const fn get(self) -> u32 {
        self.0
    }

    pub const fn saturating_add(self, other: Self) -> Self {
        Self(self.0.saturating_add(other.0))
    }

    pub const fn saturating_sub(self, other: Self) -> Self {
        Self(self.0.saturating_sub(other.0))
    }
}

impl fmt::Display for ContextTokenCount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Selects the ordinary-input pressure boundary independently from the model's hard window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextCompactionLimit {
    ContextWindow,
    Tokens(ContextTokenCount),
}

/// Immutable token allocations for one context-planning operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextBudget {
    /// The caller delegates overflow handling because the selected model has no verified limits.
    ProviderManaged,
    /// Ash owns deterministic pressure and hard-window decisions at the supplied limits.
    CoreManaged {
        context_window: ContextTokenCount,
        reserved_output: ContextTokenCount,
        safety_margin: ContextTokenCount,
        compaction_limit: ContextCompactionLimit,
    },
}

impl ContextBudget {
    pub const fn core_managed(
        context_window: ContextTokenCount,
        reserved_output: ContextTokenCount,
        safety_margin: ContextTokenCount,
        compaction_limit: ContextCompactionLimit,
    ) -> Self {
        Self::CoreManaged {
            context_window,
            reserved_output,
            safety_margin,
            compaction_limit,
        }
    }

    pub const fn provider_managed() -> Self {
        Self::ProviderManaged
    }

    /// Keeps an extra input buffer between ordinary work and the hard request boundary.
    pub const fn with_input_buffer(self, buffer: ContextTokenCount) -> Self {
        match self {
            Self::ProviderManaged => self,
            Self::CoreManaged {
                context_window,
                reserved_output,
                safety_margin,
                compaction_limit,
            } => {
                let limit = context_window.saturating_sub(buffer);
                let limit = match compaction_limit {
                    ContextCompactionLimit::Tokens(existing) if existing.get() < limit.get() => {
                        existing
                    }
                    _ => limit,
                };
                Self::core_managed(
                    context_window,
                    reserved_output,
                    safety_margin,
                    ContextCompactionLimit::Tokens(limit),
                )
            }
        }
    }

    /// Uses the hard window for one bounded checkpoint-writing request.
    pub const fn for_checkpoint(self, output: ContextTokenCount) -> Self {
        match self {
            Self::ProviderManaged => self,
            Self::CoreManaged {
                context_window,
                safety_margin,
                ..
            } => Self::core_managed(
                context_window,
                output,
                safety_margin,
                ContextCompactionLimit::ContextWindow,
            ),
        }
    }

    /// Conservatively reduces the planned input capacity by a measured estimator error.
    ///
    /// Both the ordinary pressure window and hard model window are reduced. Provider-managed
    /// budgets remain provider-managed because they expose no local capacity to adjust.
    pub const fn with_input_capacity_reduction(self, reduction: ContextTokenCount) -> Self {
        let Self::CoreManaged {
            context_window,
            reserved_output,
            safety_margin,
            compaction_limit,
        } = self
        else {
            return self;
        };
        let context_window = context_window.saturating_sub(reduction);
        let compaction_limit = match compaction_limit {
            ContextCompactionLimit::ContextWindow => ContextCompactionLimit::ContextWindow,
            ContextCompactionLimit::Tokens(limit) => {
                ContextCompactionLimit::Tokens(limit.saturating_sub(reduction))
            }
        };
        Self::CoreManaged {
            context_window,
            reserved_output,
            safety_margin,
            compaction_limit,
        }
    }

    /// Resolves configured allocations into the two limits used by context planning.
    ///
    /// The pressure limit triggers ordinary history compaction. The hard limit protects both the
    /// final model request and the independent compaction request from exceeding the model window.
    pub fn resolve(self) -> Result<ResolvedContextBudget, ContextBudgetError> {
        let Self::CoreManaged {
            context_window,
            reserved_output,
            safety_margin,
            compaction_limit,
        } = self
        else {
            return Ok(ResolvedContextBudget::ProviderManaged);
        };
        let hard_input = context_window
            .get()
            .checked_sub(reserved_output.get())
            .and_then(|remaining| remaining.checked_sub(safety_margin.get()))
            .filter(|remaining| *remaining > 0)
            .map(ContextTokenCount::new)
            .ok_or(ContextBudgetError::NoInputCapacity)?;
        let pressure_window = match compaction_limit {
            ContextCompactionLimit::ContextWindow => context_window.get(),
            ContextCompactionLimit::Tokens(limit) => limit.get().min(context_window.get()),
        };
        let pressure_input = pressure_window
            .checked_sub(reserved_output.get())
            .and_then(|remaining| remaining.checked_sub(safety_margin.get()))
            .filter(|remaining| *remaining > 0)
            .map(ContextTokenCount::new)
            .ok_or(ContextBudgetError::NoInputCapacity)?;
        Ok(ResolvedContextBudget::CoreManaged(ContextBudgetLimits {
            context_window,
            reserved_output,
            safety_margin,
            maximum_input: pressure_input,
            hard_maximum_input: hard_input,
        }))
    }
}

/// Validated result of resolving a context budget.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolvedContextBudget {
    ProviderManaged,
    CoreManaged(ContextBudgetLimits),
}

/// Validated pressure and hard-window allocations for a Core-managed model request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContextBudgetLimits {
    context_window: ContextTokenCount,
    reserved_output: ContextTokenCount,
    safety_margin: ContextTokenCount,
    maximum_input: ContextTokenCount,
    hard_maximum_input: ContextTokenCount,
}

impl ContextBudgetLimits {
    pub const fn context_window(self) -> ContextTokenCount {
        self.context_window
    }

    pub const fn reserved_output(self) -> ContextTokenCount {
        self.reserved_output
    }

    pub const fn safety_margin(self) -> ContextTokenCount {
        self.safety_margin
    }

    /// Returns the input threshold at which ordinary context should be compacted.
    pub const fn maximum_input(self) -> ContextTokenCount {
        self.maximum_input
    }

    /// Returns the model's hard input capacity after output and safety reservations.
    pub const fn hard_maximum_input(self) -> ContextTokenCount {
        self.hard_maximum_input
    }

    /// Returns the hard capacity available to the independent compaction request.
    pub const fn maximum_compaction_input(self) -> ContextTokenCount {
        self.hard_maximum_input
    }
}

/// A configured Core-managed budget leaves no space for model input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextBudgetError {
    NoInputCapacity,
}

impl fmt::Display for ContextBudgetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoInputCapacity => formatter.write_str(
                "context budget must leave input capacity after output and safety reservations",
            ),
        }
    }
}

impl std::error::Error for ContextBudgetError {}

#[cfg(test)]
#[path = "budget_tests.rs"]
mod tests;
