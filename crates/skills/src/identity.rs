use serde::{Deserialize, Serialize};

/// Monotonic identity of one immutable, consumer-visible Skill catalog projection.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SkillCatalogGeneration(u64);

impl SkillCatalogGeneration {
    pub const INITIAL: Self = Self(1);

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn next(self) -> Self {
        Self(
            self.0
                .checked_add(1)
                .expect("skill catalog generation exhausted"),
        )
    }
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
