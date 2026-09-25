use crate::CatalogCacheHint;
use crate::CatalogFreshnessPolicy;
use crate::CatalogGeneration;
use crate::CatalogScopeKey;
use crate::CatalogValidator;
use crate::CatalogWarning;
use crate::ModelCatalogSnapshot;
use crate::ModelsManagerError;
use crate::merge::CatalogRecord;
use crate::merge::seed_records;
use ash_model_provider_config::ProviderDefinition;
use ash_protocol::ModelCatalogFreshness;
use ash_protocol::ModelId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::RwLock;
use std::time::Duration;
use std::time::SystemTime;
use tokio::sync::Mutex as AsyncMutex;

pub(crate) struct ManagedScope {
    pub(crate) definition: ProviderDefinition,
    pub(crate) state: RwLock<ScopeState>,
    pub(crate) refresh: AsyncMutex<()>,
}

impl ManagedScope {
    pub(crate) fn new(
        definition: ProviderDefinition,
        scope: &CatalogScopeKey,
        generation: CatalogGeneration,
    ) -> Self {
        let records = seed_records(&definition);
        let snapshot = Arc::new(build_snapshot(
            scope,
            generation,
            ModelCatalogFreshness::StaticOnly,
            &records,
            &[],
        ));
        Self {
            definition,
            state: RwLock::new(ScopeState {
                records,
                last_discovered_ids: BTreeSet::new(),
                snapshot,
                last_success: None,
                cache_hint: CatalogCacheHint::unspecified(),
                validator: None,
                warnings: Vec::new(),
                refresh_serial: 0,
                last_refresh_error: None,
                has_live_observation: false,
            }),
            refresh: AsyncMutex::new(()),
        }
    }
}

pub(crate) struct ScopeState {
    pub(crate) records: BTreeMap<ModelId, CatalogRecord>,
    /// Membership of the latest account-scoped observation, independent of seed metadata.
    pub(crate) last_discovered_ids: BTreeSet<ModelId>,
    pub(crate) snapshot: Arc<ModelCatalogSnapshot>,
    pub(crate) last_success: Option<SystemTime>,
    pub(crate) cache_hint: CatalogCacheHint,
    pub(crate) validator: Option<CatalogValidator>,
    pub(crate) warnings: Vec<CatalogWarning>,
    pub(crate) refresh_serial: u64,
    pub(crate) last_refresh_error: Option<ModelsManagerError>,
    pub(crate) has_live_observation: bool,
}

/// Supplies deterministic wall time to freshness classification without sleeping in tests.
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}

pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

pub(crate) fn classify_freshness(
    state: &ScopeState,
    now: SystemTime,
    policy: CatalogFreshnessPolicy,
) -> ModelCatalogFreshness {
    let Some(last_success) = state.last_success else {
        return ModelCatalogFreshness::StaticOnly;
    };
    let age = now.duration_since(last_success).unwrap_or(Duration::ZERO);
    let fresh_for = state
        .cache_hint
        .fresh_for()
        .map(|hint| hint.min(policy.fresh_for()))
        .unwrap_or_else(|| policy.fresh_for());
    let stale_usable_for = state
        .cache_hint
        .stale_usable_for()
        .map(|hint| hint.min(policy.stale_usable_for()))
        .unwrap_or_else(|| policy.stale_usable_for())
        .max(fresh_for);
    if age <= fresh_for {
        ModelCatalogFreshness::Fresh
    } else if age <= stale_usable_for {
        ModelCatalogFreshness::StaleUsable
    } else {
        ModelCatalogFreshness::Expired
    }
}

pub(crate) fn rebuild_snapshot(
    scope: &CatalogScopeKey,
    state: &mut ScopeState,
    freshness: ModelCatalogFreshness,
) {
    let candidate = build_snapshot(
        scope,
        state.snapshot.generation(),
        freshness,
        &state.records,
        &state.warnings,
    );
    if state.snapshot.has_same_contents(&candidate) {
        return;
    }
    state.snapshot = Arc::new(build_snapshot(
        scope,
        state.snapshot.generation().next(),
        freshness,
        &state.records,
        &state.warnings,
    ));
}

pub(crate) fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn build_snapshot(
    scope: &CatalogScopeKey,
    generation: CatalogGeneration,
    freshness: ModelCatalogFreshness,
    records: &BTreeMap<ModelId, CatalogRecord>,
    warnings: &[CatalogWarning],
) -> ModelCatalogSnapshot {
    let entries = records
        .values()
        .map(|record| record.entry(scope.provider()))
        .collect();
    ModelCatalogSnapshot::new(
        scope.clone(),
        generation,
        freshness,
        entries,
        warnings.to_vec(),
    )
}
