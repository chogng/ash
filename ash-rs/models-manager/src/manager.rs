use crate::CatalogDiscoveryOutcome;
use crate::CatalogDiscoveryRequest;
use crate::CatalogFreshnessPolicy;
use crate::CatalogQuery;
use crate::CatalogReadPolicy;
use crate::CatalogScopeKey;
use crate::CatalogSourceErrorKind;
use crate::CatalogWarning;
use crate::CatalogWarningCode;
use crate::ModelCatalogEntry;
use crate::ModelCatalogSnapshot;
use crate::ModelCatalogSource;
use crate::ModelRequirements;
use crate::ModelsManagerError;
use crate::ResolvedModel;
use crate::cache::Clock;
use crate::cache::ManagedScope;
use crate::cache::SystemClock;
use crate::cache::classify_freshness;
use crate::cache::read_lock;
use crate::cache::rebuild_snapshot;
use crate::cache::write_lock;
use crate::disk_cache::DiskCatalogCache;
use crate::filter::matches_query;
use crate::filter::validate_requirements;
use crate::merge::apply_discovery;
use crate::merge::mark_unverified;
use crate::model_info::unlisted_entry;
use ash_model_provider_config::ModelCatalogPolicy;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_protocol::ModelCatalogFreshness;
use ash_protocol::ModelId;
use ash_protocol::ModelMetadataQuality;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::RwLock;

pub enum CatalogReadSource {
    Offline,
    Dynamic(Arc<dyn ModelCatalogSource>),
}

impl CatalogReadSource {
    pub fn dynamic(source: Arc<dyn ModelCatalogSource>) -> Self {
        Self::Dynamic(source)
    }
}

#[derive(Clone)]
pub struct ModelsManager {
    inner: Arc<ModelsManagerInner>,
}

struct ModelsManagerInner {
    providers: ProviderConfigRegistry,
    scopes: Arc<RwLock<BTreeMap<CatalogScopeKey, Arc<ManagedScope>>>>,
    freshness: CatalogFreshnessPolicy,
    clock: Arc<dyn Clock>,
    disk_cache: Option<Arc<DiskCatalogCache>>,
}

impl ModelsManager {
    /// Uses a new definition snapshot; cached scopes are reused only while their provider definition matches.
    pub fn with_registry(&self, providers: ProviderConfigRegistry) -> Self {
        Self {
            inner: Arc::new(ModelsManagerInner {
                providers,
                scopes: Arc::clone(&self.inner.scopes),
                freshness: self.inner.freshness.clone(),
                clock: Arc::clone(&self.inner.clock),
                disk_cache: self.inner.disk_cache.clone(),
            }),
        }
    }

    /// Persists observed catalogs across Ash processes in one file per provider.
    pub fn with_disk_cache(&self, directory: PathBuf) -> Self {
        Self {
            inner: Arc::new(ModelsManagerInner {
                providers: self.inner.providers.clone(),
                scopes: Arc::clone(&self.inner.scopes),
                freshness: self.inner.freshness,
                clock: Arc::clone(&self.inner.clock),
                disk_cache: Some(Arc::new(DiskCatalogCache::new(directory))),
            }),
        }
    }
    pub fn new(providers: ProviderConfigRegistry) -> Self {
        Self::with_policy_and_clock(
            providers,
            CatalogFreshnessPolicy::default(),
            Arc::new(SystemClock),
        )
    }

    pub fn with_freshness_policy(
        providers: ProviderConfigRegistry,
        freshness: CatalogFreshnessPolicy,
    ) -> Self {
        Self::with_policy_and_clock(providers, freshness, Arc::new(SystemClock))
    }

    pub fn static_snapshot(
        &self,
        provider: &ProviderId,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelsManagerError> {
        self.snapshot(&CatalogScopeKey::provider_seed(provider.clone()))
    }

    pub fn snapshot(
        &self,
        scope: &CatalogScopeKey,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelsManagerError> {
        let managed = self.ensure_scope(scope)?;
        self.update_freshness(scope, &managed);
        Ok(read_lock(&managed.state).snapshot.clone())
    }

    pub async fn read(
        &self,
        scope: CatalogScopeKey,
        policy: CatalogReadPolicy,
        source: CatalogReadSource,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelsManagerError> {
        let snapshot = self.snapshot(&scope)?;
        if scope.is_provider_seed() || policy == CatalogReadPolicy::CacheOnly {
            return Ok(snapshot);
        }
        match (policy, snapshot.freshness(), source) {
            (_, ModelCatalogFreshness::Fresh, _) => Ok(snapshot),
            (
                CatalogReadPolicy::CachePreferred,
                ModelCatalogFreshness::StaleUsable,
                CatalogReadSource::Dynamic(source),
            ) => {
                let manager = self.clone();
                drop(tokio::spawn(async move {
                    let _ = manager.refresh(scope, source).await;
                }));
                Ok(snapshot)
            }
            (CatalogReadPolicy::CachePreferred, ModelCatalogFreshness::StaleUsable, _) => {
                Ok(snapshot)
            }
            (_, _, CatalogReadSource::Dynamic(source)) => self.refresh(scope, source).await,
            (CatalogReadPolicy::CachePreferred, ModelCatalogFreshness::StaticOnly, _) => {
                Ok(snapshot)
            }
            _ => Err(ModelsManagerError::DynamicSourceRequired(scope)),
        }
    }

    pub async fn refresh(
        &self,
        scope: CatalogScopeKey,
        source: Arc<dyn ModelCatalogSource>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelsManagerError> {
        let managed = self.ensure_scope(&scope)?;
        if scope.is_provider_seed() {
            return Ok(read_lock(&managed.state).snapshot.clone());
        }
        let observed_serial = read_lock(&managed.state).refresh_serial;
        let _refresh_guard = managed.refresh.lock().await;
        {
            let state = read_lock(&managed.state);
            if state.refresh_serial != observed_serial {
                return state
                    .last_refresh_error
                    .clone()
                    .map_or_else(|| Ok(state.snapshot.clone()), Err);
            }
        }
        let validator = read_lock(&managed.state).validator.clone();
        let request = CatalogDiscoveryRequest::new(scope.clone(), validator);
        let result = source.discover(request).await;
        match result {
            Ok(outcome) => self.commit_discovery(&scope, &managed, outcome),
            Err(error) => {
                let manager_error = ModelsManagerError::Source {
                    scope: scope.clone(),
                    error,
                };
                self.commit_failure(&scope, &managed, manager_error.clone());
                Err(manager_error)
            }
        }
    }

    pub fn list_static(
        &self,
        providers: &[ProviderId],
        query: &CatalogQuery,
    ) -> Result<Vec<ModelCatalogEntry>, ModelsManagerError> {
        let scopes = providers
            .iter()
            .cloned()
            .map(CatalogScopeKey::provider_seed)
            .collect::<Vec<_>>();
        self.list(&scopes, query)
    }

    pub fn list(
        &self,
        scopes: &[CatalogScopeKey],
        query: &CatalogQuery,
    ) -> Result<Vec<ModelCatalogEntry>, ModelsManagerError> {
        let mut entries = Vec::new();
        for scope in scopes {
            entries.extend(
                self.snapshot(scope)?
                    .entries()
                    .iter()
                    .filter(|entry| matches_query(entry, query))
                    .cloned(),
            );
        }
        entries.sort_by(|left, right| {
            left.model()
                .provider
                .cmp(&right.model().provider)
                .then_with(|| left.model().model.cmp(&right.model().model))
        });
        Ok(entries)
    }

    pub fn resolve_static(
        &self,
        model: &ModelRef,
        requirements: &ModelRequirements,
    ) -> Result<ResolvedModel, ModelsManagerError> {
        self.resolve(
            &CatalogScopeKey::provider_seed(model.provider.clone()),
            &model.model,
            requirements,
        )
    }

    pub fn resolve(
        &self,
        scope: &CatalogScopeKey,
        model: &ModelId,
        requirements: &ModelRequirements,
    ) -> Result<ResolvedModel, ModelsManagerError> {
        let managed = self.ensure_scope(scope)?;
        let snapshot = self.snapshot(scope)?;
        let entry = snapshot
            .entries()
            .iter()
            .find(|entry| &entry.model().model == model)
            .cloned();
        let entry = match entry {
            Some(entry) => entry,
            None if managed.definition.model_catalog_policy
                == ModelCatalogPolicy::AllowUnlisted =>
            {
                unlisted_entry(scope.provider(), model)
            }
            None => {
                return Err(ModelsManagerError::ModelNotListed {
                    provider: scope.provider().clone(),
                    model: model.clone(),
                });
            }
        };
        let mut warnings = snapshot.warnings().to_vec();
        warnings.extend(entry.warnings().iter().cloned());
        warnings.extend(validate_requirements(&entry, requirements)?);
        if entry.metadata_quality() == ModelMetadataQuality::Unknown {
            warnings.push(CatalogWarning::new(
                CatalogWarningCode::UnlistedModel,
                "model is not present in the provider catalog and remains unverified",
            ));
        }
        if matches!(
            snapshot.freshness(),
            ModelCatalogFreshness::StaleUsable | ModelCatalogFreshness::Expired
        ) {
            warnings.push(CatalogWarning::new(
                CatalogWarningCode::StaleCatalog,
                "model was resolved from a stale catalog snapshot",
            ));
        }
        Ok(ResolvedModel::new(entry, snapshot.generation(), warnings))
    }

    fn with_policy_and_clock(
        providers: ProviderConfigRegistry,
        freshness: CatalogFreshnessPolicy,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            inner: Arc::new(ModelsManagerInner {
                providers,
                scopes: Arc::new(RwLock::new(BTreeMap::new())),
                freshness,
                clock,
                disk_cache: None,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_clock(
        providers: ProviderConfigRegistry,
        freshness: CatalogFreshnessPolicy,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self::with_policy_and_clock(providers, freshness, clock)
    }

    fn ensure_scope(
        &self,
        scope: &CatalogScopeKey,
    ) -> Result<Arc<ManagedScope>, ModelsManagerError> {
        let definition = self
            .inner
            .providers
            .get(scope.provider())
            .cloned()
            .ok_or_else(|| ModelsManagerError::UnknownProvider(scope.provider().clone()))?;
        if let Some(managed) = read_lock(&self.inner.scopes).get(scope) {
            if managed.definition == definition {
                return Ok(managed.clone());
            }
        }
        let mut scopes = write_lock(&self.inner.scopes);
        if let Some(managed) = scopes.get(scope) {
            if managed.definition == definition {
                return Ok(managed.clone());
            }
        }
        let generation = scopes
            .get(scope)
            .map_or(crate::CatalogGeneration::INITIAL, |managed| {
                read_lock(&managed.state).snapshot.generation().next()
            });
        let managed = Arc::new(ManagedScope::new(definition, scope, generation));
        if !scope.is_provider_seed()
            && let Some(cache) = &self.inner.disk_cache
        {
            match cache.load(scope) {
                Ok(Some(catalog)) => {
                    let mut state = write_lock(&managed.state);
                    apply_discovery(&mut state.records, &catalog);
                    state.last_success = Some(catalog.observed_at);
                    state.cache_hint = catalog.cache_hint;
                    state.validator = catalog.validator;
                    state.has_live_observation = true;
                    let freshness =
                        classify_freshness(&state, self.inner.clock.now(), self.inner.freshness);
                    rebuild_snapshot(scope, &mut state, freshness);
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!(
                        "could not read model catalog for {}: {error}",
                        scope.provider()
                    );
                }
            }
        }
        scopes.insert(scope.clone(), managed.clone());
        Ok(managed)
    }

    fn update_freshness(&self, scope: &CatalogScopeKey, managed: &ManagedScope) {
        let now = self.inner.clock.now();
        let mut state = write_lock(&managed.state);
        let freshness = classify_freshness(&state, now, self.inner.freshness);
        rebuild_snapshot(scope, &mut state, freshness);
    }

    fn commit_discovery(
        &self,
        scope: &CatalogScopeKey,
        managed: &ManagedScope,
        outcome: CatalogDiscoveryOutcome,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelsManagerError> {
        let returned_scope = match &outcome {
            CatalogDiscoveryOutcome::Modified(catalog) => &catalog.scope,
            CatalogDiscoveryOutcome::NotModified(catalog) => &catalog.scope,
        };
        if returned_scope != scope {
            let error = ModelsManagerError::ScopeMismatch {
                requested: scope.clone(),
                returned: returned_scope.clone(),
            };
            self.commit_failure(scope, managed, error.clone());
            return Err(error);
        }
        if let CatalogDiscoveryOutcome::Modified(catalog) = &outcome {
            let mut models = BTreeSet::new();
            for model in &catalog.models {
                if !models.insert(model.id.clone()) {
                    let error = ModelsManagerError::DuplicateDiscoveredModel {
                        scope: scope.clone(),
                        model: model.id.clone(),
                    };
                    self.commit_failure(scope, managed, error.clone());
                    return Err(error);
                }
            }
        }
        if matches!(outcome, CatalogDiscoveryOutcome::NotModified(_))
            && !read_lock(&managed.state).has_live_observation
        {
            let error = ModelsManagerError::NotModifiedWithoutObservation(scope.clone());
            self.commit_failure(scope, managed, error.clone());
            return Err(error);
        }
        if let Some(cache) = &self.inner.disk_cache {
            let saved = match &outcome {
                CatalogDiscoveryOutcome::Modified(catalog) => cache.store(catalog),
                CatalogDiscoveryOutcome::NotModified(observation) => cache.touch(observation),
            };
            if let Err(error) = saved {
                log::warn!(
                    "could not persist model catalog for {}: {error}",
                    scope.provider()
                );
            }
        }
        let mut state = write_lock(&managed.state);
        match outcome {
            CatalogDiscoveryOutcome::Modified(catalog) => {
                apply_discovery(&mut state.records, &catalog);
                state.last_success = Some(catalog.observed_at);
                state.cache_hint = catalog.cache_hint;
                state.validator = catalog.validator;
                state.has_live_observation = true;
            }
            CatalogDiscoveryOutcome::NotModified(catalog) => {
                state.last_success = Some(catalog.observed_at);
                state.cache_hint = catalog.cache_hint;
                if catalog.validator.is_some() {
                    state.validator = catalog.validator;
                }
            }
        }
        state.warnings.clear();
        state.refresh_serial = state.refresh_serial.saturating_add(1);
        state.last_refresh_error = None;
        let freshness = classify_freshness(&state, self.inner.clock.now(), self.inner.freshness);
        rebuild_snapshot(scope, &mut state, freshness);
        Ok(state.snapshot.clone())
    }

    fn commit_failure(
        &self,
        scope: &CatalogScopeKey,
        managed: &ManagedScope,
        error: ModelsManagerError,
    ) {
        let mut state = write_lock(&managed.state);
        let (code, message, unverify) = warning_for_error(&error);
        if unverify {
            mark_unverified(&mut state.records);
        }
        state.warnings = vec![CatalogWarning::new(code, message)];
        state.refresh_serial = state.refresh_serial.saturating_add(1);
        state.last_refresh_error = Some(error);
        let freshness = classify_freshness(&state, self.inner.clock.now(), self.inner.freshness);
        rebuild_snapshot(scope, &mut state, freshness);
    }
}

fn warning_for_error(error: &ModelsManagerError) -> (CatalogWarningCode, String, bool) {
    match error {
        ModelsManagerError::Source { error, .. } => match error.kind() {
            CatalogSourceErrorKind::Authentication | CatalogSourceErrorKind::Permission => (
                CatalogWarningCode::AuthenticationRequired,
                "catalog discovery requires valid provider authentication".into(),
                true,
            ),
            CatalogSourceErrorKind::Unsupported => (
                CatalogWarningCode::DiscoveryUnsupported,
                "provider does not support dynamic model discovery".into(),
                false,
            ),
            _ => (
                CatalogWarningCode::RefreshFailed,
                "catalog refresh failed; retaining the last known snapshot".into(),
                false,
            ),
        },
        _ => (
            CatalogWarningCode::RefreshFailed,
            "catalog refresh returned an invalid observation".into(),
            false,
        ),
    }
}
