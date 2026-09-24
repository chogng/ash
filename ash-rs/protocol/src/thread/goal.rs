use crate::ThreadId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Lifecycle state for the one durable Goal owned by a Thread.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ThreadGoalStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
}

impl ThreadGoalStatus {
    pub const fn is_active(self) -> bool {
        matches!(self, Self::Active)
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::BudgetLimited | Self::Complete)
    }

    /// A Goal can only be replaced after the model has explicitly completed it.
    pub const fn is_complete(self) -> bool {
        matches!(self, Self::Complete)
    }

    pub const fn allows_usage_accounting(self) -> bool {
        matches!(self, Self::Active | Self::Paused | Self::BudgetLimited)
    }
}

/// A Goal instruction submitted through the client API, distinct from Agent Goal tool writes.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UserGoalChange {
    Set {
        goal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        objective: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        status: Option<ThreadGoalStatus>,
    },
    Clear {
        goal_id: String,
    },
}

/// The durable Thread-scoped task Goal and its cumulative token usage.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoal {
    pub thread_id: ThreadId,
    pub goal_id: String,
    pub objective: String,
    pub status: ThreadGoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "number | null")]
    pub token_budget: Option<u64>,
    #[ts(type = "number")]
    pub tokens_used: u64,
}

impl ThreadGoal {
    pub const MAX_OBJECTIVE_CHARS: usize = 4_000;

    pub fn validate(&self) -> Result<(), String> {
        if self.thread_id.to_string().trim().is_empty() {
            return Err("goal Thread ID must not be empty".into());
        }
        if self.goal_id.trim().is_empty() {
            return Err("goal ID must not be empty".into());
        }
        if self.objective.trim().is_empty() {
            return Err("goal objective must not be empty".into());
        }
        if self.objective.chars().count() > Self::MAX_OBJECTIVE_CHARS {
            return Err(format!(
                "goal objective must be at most {} characters",
                Self::MAX_OBJECTIVE_CHARS
            ));
        }
        if self.token_budget == Some(0) {
            return Err("goal token budget must be greater than zero".into());
        }
        Ok(())
    }

    pub fn remaining_tokens(&self) -> Option<u64> {
        self.token_budget
            .map(|budget| budget.saturating_sub(self.tokens_used))
    }
}
