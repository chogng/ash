use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogReadPolicy {
    CachePreferred,
    RequireFresh,
    CacheOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CatalogFreshnessPolicy {
    fresh_for: Duration,
    stale_usable_for: Duration,
}

impl CatalogFreshnessPolicy {
    pub fn new(fresh_for: Duration, stale_usable_for: Duration) -> Self {
        Self {
            fresh_for,
            stale_usable_for: stale_usable_for.max(fresh_for),
        }
    }

    pub fn fresh_for(self) -> Duration {
        self.fresh_for
    }

    pub fn stale_usable_for(self) -> Duration {
        self.stale_usable_for
    }
}

impl Default for CatalogFreshnessPolicy {
    fn default() -> Self {
        Self::new(
            Duration::from_secs(15 * 60),
            Duration::from_secs(24 * 60 * 60),
        )
    }
}
