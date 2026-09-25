use crate::CatalogDiscoveryOutcome;
use crate::CatalogFreshnessPolicy;
use crate::CatalogNotModified;
use crate::CatalogQuery;
use crate::CatalogReadPolicy;
use crate::CatalogReadSource;
use crate::CatalogScopeKey;
use crate::CatalogSourceError;
use crate::CatalogSourceErrorKind;
use crate::CatalogSourceFuture;
use crate::CatalogSourceScopeId;
use crate::CatalogWarningCode;
use crate::DiscoveredCatalog;
use crate::DiscoveredModel;
use crate::DiscoveryCoverage;
use crate::ModelCapabilitiesPatch;
use crate::ModelCatalogSource;
use crate::ModelMetadataPatch;
use crate::ModelRequirements;
use crate::ModelsManager;
use crate::ModelsManagerError;
use crate::UnknownCapabilityPolicy;
use crate::cache::Clock;
use ash_model_provider_config::ApiProfile;
use ash_model_provider_config::EndpointPolicy;
use ash_model_provider_config::ModelCatalogPolicy;
use ash_model_provider_config::ProviderAdapter;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_model_provider_config::ProviderDefinition;
use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAvailability;
use ash_protocol::ModelCatalogFreshness;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelMetadataQuality;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use tokio::sync::Notify;

const START: SystemTime = SystemTime::UNIX_EPOCH;

#[derive(Default)]
struct QueueSource {
    outcomes: Mutex<VecDeque<Result<CatalogDiscoveryOutcome, CatalogSourceError>>>,
    calls: AtomicUsize,
}

impl QueueSource {
    fn new(
        outcomes: impl IntoIterator<Item = Result<CatalogDiscoveryOutcome, CatalogSourceError>>,
    ) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: AtomicUsize::new(0),
        }
    }
}

impl ModelCatalogSource for QueueSource {
    fn discover<'a>(&'a self, _: crate::CatalogDiscoveryRequest) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.outcomes
                .lock()
                .unwrap()
                .pop_front()
                .expect("test source must have an outcome")
        })
    }
}

struct GatedSource {
    calls: AtomicUsize,
    release: Notify,
    observed_at: SystemTime,
}

impl ModelCatalogSource for GatedSource {
    fn discover<'a>(&'a self, request: crate::CatalogDiscoveryRequest) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
            Ok(CatalogDiscoveryOutcome::Modified(DiscoveredCatalog::new(
                request.scope().clone(),
                DiscoveryCoverage::Partial,
                self.observed_at,
            )))
        })
    }
}

struct FakeClock {
    now: Mutex<SystemTime>,
}

impl FakeClock {
    fn new(now: SystemTime) -> Self {
        Self {
            now: Mutex::new(now),
        }
    }

    fn advance(&self, duration: Duration) {
        let mut now = self.now.lock().unwrap();
        *now += duration;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> SystemTime {
        *self.now.lock().unwrap()
    }
}

#[test]
fn static_catalog_is_sorted_and_honors_provider_listing_policy() {
    let manager = ModelsManager::new(registry());
    let strict = provider_id("strict");
    let flexible = provider_id("flexible");
    let entries = manager
        .list_static(
            &[strict.clone(), flexible.clone()],
            &CatalogQuery::selectable(),
        )
        .unwrap();

    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.model().to_owned())
            .collect::<Vec<_>>(),
        vec![model_ref("strict", "alpha"), model_ref("strict", "ash"),]
    );
    assert!(matches!(
        manager.resolve_static(&model_ref("strict", "other"), &ModelRequirements::agent()),
        Err(ModelsManagerError::ModelNotListed { .. })
    ));
    let unlisted = manager
        .resolve_static(
            &model_ref("flexible", "custom-model"),
            &ModelRequirements::agent(),
        )
        .unwrap();
    assert_eq!(
        unlisted.entry().metadata_quality(),
        ModelMetadataQuality::Unknown
    );
    assert!(
        unlisted
            .warnings()
            .iter()
            .any(|warning| warning.code() == CatalogWarningCode::UnlistedModel)
    );
}

#[tokio::test]
async fn effective_model_info_uses_the_live_window_without_rewriting_the_scope() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let source = Arc::new(QueueSource::new([Ok(modified(
        &scope,
        DiscoveryCoverage::Partial,
        [
            DiscoveredModel::new(model_id("alpha")).with_metadata(ModelMetadataPatch {
                context_window: Some(ContextWindow::Known(64_000)),
                ..Default::default()
            }),
        ],
    ))]));
    let snapshot = manager.refresh(scope.clone(), source).await.unwrap();
    let mut config = ash_model_provider_config::ModelProviderConfig::new(provider_id("strict"));
    config.model_context.insert(
        model_id("alpha"),
        ash_model_provider_config::ModelContextConfig {
            context_window: 100_000,
            auto_compact_token_limit: Some(90_000),
        },
    );
    let resolved = manager
        .resolve(&scope, &model_id("alpha"), &ModelRequirements::agent())
        .unwrap();
    let info = resolved.entry().model_info(&config).unwrap();
    assert_eq!(info.context_window, ContextWindow::Known(64_000));
    assert_eq!(info.auto_compact_token_limit, Some(57_600));
    assert_eq!(
        resolved.entry().provenance().context_window,
        Some(crate::MetadataSource::ProviderLive)
    );
    assert_eq!(manager.snapshot(&scope).unwrap(), snapshot);
}

#[tokio::test]
async fn partial_absence_is_preserved_but_complete_absence_is_unavailable() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let partial = modified(
        &scope,
        DiscoveryCoverage::Partial,
        [DiscoveredModel::new(model_id("alpha"))],
    );
    let complete = modified(
        &scope,
        DiscoveryCoverage::CompleteAgentCatalog,
        [DiscoveredModel::new(model_id("alpha"))],
    );
    let source = Arc::new(QueueSource::new([Ok(partial), Ok(complete)]));

    manager
        .refresh(scope.clone(), source.clone())
        .await
        .unwrap();
    let partial_snapshot = manager.snapshot(&scope).unwrap();
    assert_eq!(
        availability(&partial_snapshot, "alpha"),
        ModelAvailability::Available
    );
    assert_eq!(
        availability(&partial_snapshot, "ash"),
        ModelAvailability::Unverified
    );

    manager.refresh(scope.clone(), source).await.unwrap();
    let complete_snapshot = manager.snapshot(&scope).unwrap();
    assert_eq!(
        availability(&complete_snapshot, "alpha"),
        ModelAvailability::Available
    );
    assert_eq!(
        availability(&complete_snapshot, "ash"),
        ModelAvailability::Unavailable
    );
}

#[tokio::test]
async fn unknown_live_fields_do_not_erase_known_seed_metadata() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let patch = ModelMetadataPatch {
        context_window: Some(ContextWindow::Unknown),
        capabilities: ModelCapabilitiesPatch {
            tools: Some(CapabilitySupport::Unknown),
            ..ModelCapabilitiesPatch::default()
        },
        ..ModelMetadataPatch::default()
    };
    let source = Arc::new(QueueSource::new([Ok(modified(
        &scope,
        DiscoveryCoverage::Partial,
        [DiscoveredModel::new(model_id("alpha")).with_metadata(patch)],
    ))]));

    manager.refresh(scope.clone(), source).await.unwrap();
    let snapshot = manager.snapshot(&scope).unwrap();
    let alpha = snapshot
        .entries()
        .iter()
        .find(|entry| entry.model().model == model_id("alpha"))
        .unwrap();
    assert_eq!(alpha.info().context_window, ContextWindow::Known(128_000));
    assert_eq!(
        alpha.info().capabilities.tools,
        CapabilitySupport::Supported
    );
}

#[tokio::test]
async fn freshness_transitions_change_generation_without_sleeping() {
    let clock = Arc::new(FakeClock::new(START));
    let manager = ModelsManager::with_clock(
        registry(),
        CatalogFreshnessPolicy::new(Duration::from_secs(10), Duration::from_secs(20)),
        clock.clone(),
    );
    let scope = dynamic_scope("strict", "account-a");
    let source = Arc::new(QueueSource::new([Ok(modified_at(
        &scope,
        DiscoveryCoverage::Partial,
        [],
        START,
    ))]));
    let fresh = manager.refresh(scope.clone(), source).await.unwrap();
    assert_eq!(fresh.freshness(), ModelCatalogFreshness::Fresh);

    clock.advance(Duration::from_secs(11));
    let stale = manager.snapshot(&scope).unwrap();
    assert_eq!(stale.freshness(), ModelCatalogFreshness::StaleUsable);
    assert!(stale.generation() > fresh.generation());

    clock.advance(Duration::from_secs(10));
    let expired = manager.snapshot(&scope).unwrap();
    assert_eq!(expired.freshness(), ModelCatalogFreshness::Expired);
    assert!(expired.generation() > stale.generation());
}

#[tokio::test]
async fn not_modified_keeps_generation_when_snapshot_is_already_fresh() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let source = Arc::new(QueueSource::new([
        Ok(modified(
            &scope,
            DiscoveryCoverage::Partial,
            [DiscoveredModel::new(model_id("alpha"))],
        )),
        Ok(CatalogDiscoveryOutcome::NotModified(
            CatalogNotModified::new(scope.clone(), SystemTime::now()),
        )),
    ]));
    let first = manager
        .refresh(scope.clone(), source.clone())
        .await
        .unwrap();
    let second = manager.refresh(scope, source).await.unwrap();

    assert_eq!(second.generation(), first.generation());
}

#[tokio::test]
async fn concurrent_refreshes_for_one_scope_are_singleflight() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let source = Arc::new(GatedSource {
        calls: AtomicUsize::new(0),
        release: Notify::new(),
        observed_at: SystemTime::now(),
    });
    let releaser = {
        let source = source.clone();
        tokio::spawn(async move {
            while source.calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            tokio::task::yield_now().await;
            source.release.notify_one();
        })
    };
    let first = manager.refresh(scope.clone(), source.clone());
    let second = manager.refresh(scope, source.clone());
    let (first, second) = tokio::join!(first, second);
    releaser.await.unwrap();

    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(first.unwrap().generation(), second.unwrap().generation());
}

#[tokio::test]
async fn authentication_failure_retains_metadata_and_downgrades_live_availability() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let source = Arc::new(QueueSource::new([
        Ok(modified(
            &scope,
            DiscoveryCoverage::CompleteAgentCatalog,
            [DiscoveredModel::new(model_id("alpha"))],
        )),
        Err(CatalogSourceError::new(
            CatalogSourceErrorKind::Authentication,
            "credential rejected",
        )),
    ]));
    manager
        .refresh(scope.clone(), source.clone())
        .await
        .unwrap();

    assert!(manager.refresh(scope.clone(), source).await.is_err());
    let fallback = manager.snapshot(&scope).unwrap();

    assert_eq!(
        availability(&fallback, "alpha"),
        ModelAvailability::Unverified
    );
    assert_eq!(
        fallback
            .entries()
            .iter()
            .find(|entry| entry.model().model == model_id("alpha"))
            .unwrap()
            .info()
            .context_window,
        ContextWindow::Known(128_000)
    );
    assert!(
        fallback
            .warnings()
            .iter()
            .any(|warning| warning.code() == CatalogWarningCode::AuthenticationRequired)
    );
}

#[tokio::test]
async fn require_fresh_performs_first_discovery_for_a_dynamic_scope() {
    let manager = ModelsManager::new(registry());
    let scope = dynamic_scope("strict", "account-a");
    let source = Arc::new(QueueSource::new([Ok(modified(
        &scope,
        DiscoveryCoverage::Partial,
        [DiscoveredModel::new(model_id("alpha"))],
    ))]));

    let snapshot = manager
        .read(
            scope,
            CatalogReadPolicy::RequireFresh,
            CatalogReadSource::dynamic(source.clone()),
        )
        .await
        .unwrap();

    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(snapshot.freshness(), ModelCatalogFreshness::Fresh);
}

#[test]
fn required_unknown_capability_can_be_excluded() {
    let manager = ModelsManager::new(registry());
    let requirements = ModelRequirements::agent()
        .require_capability(crate::ModelCapability::Reasoning)
        .with_unknown_capability_policy(UnknownCapabilityPolicy::Exclude);

    assert!(matches!(
        manager.resolve_static(&model_ref("strict", "ash"), &requirements),
        Err(ModelsManagerError::CapabilityUnknown { .. })
    ));
}

fn registry() -> ProviderConfigRegistry {
    let mut alpha = ModelInfo::new(model_id("alpha"), "Alpha");
    alpha.context_window = ContextWindow::Known(128_000);
    alpha.capabilities.tools = CapabilitySupport::Supported;
    let ash = ModelInfo::new(model_id("ash"), "Ash");
    ProviderConfigRegistry::from_definitions([
        definition("strict", ModelCatalogPolicy::ListedOnly).with_models([ash, alpha]),
        definition("flexible", ModelCatalogPolicy::AllowUnlisted),
    ])
    .unwrap()
}

fn definition(id: &str, policy: ModelCatalogPolicy) -> ProviderDefinition {
    ProviderDefinition::new(
        provider_id(id),
        id,
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
        EndpointPolicy::ConfiguredOnly,
        policy,
    )
}

fn modified(
    scope: &CatalogScopeKey,
    coverage: DiscoveryCoverage,
    models: impl IntoIterator<Item = DiscoveredModel>,
) -> CatalogDiscoveryOutcome {
    modified_at(scope, coverage, models, SystemTime::now())
}

fn modified_at(
    scope: &CatalogScopeKey,
    coverage: DiscoveryCoverage,
    models: impl IntoIterator<Item = DiscoveredModel>,
    observed_at: SystemTime,
) -> CatalogDiscoveryOutcome {
    CatalogDiscoveryOutcome::Modified(
        DiscoveredCatalog::new(scope.clone(), coverage, observed_at).with_models(models),
    )
}

fn dynamic_scope(provider: &str, scope: &str) -> CatalogScopeKey {
    CatalogScopeKey::new(
        provider_id(provider),
        CatalogSourceScopeId::new(scope).unwrap(),
    )
}

fn availability(snapshot: &crate::ModelCatalogSnapshot, model: &str) -> ModelAvailability {
    snapshot
        .entries()
        .iter()
        .find(|entry| entry.model().model == model_id(model))
        .unwrap()
        .availability()
}

fn model_ref(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(provider_id(provider), model_id(model))
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}

fn model_id(value: &str) -> ModelId {
    ModelId::new(value).unwrap()
}

#[tokio::test]
async fn changed_provider_definitions_replace_seed_cache_and_keep_unaffected_discovery() {
    let manager = ModelsManager::new(registry());
    assert_eq!(
        manager
            .static_snapshot(&provider_id("strict"))
            .unwrap()
            .entries()
            .len(),
        2
    );
    let scope = dynamic_scope("flexible", "endpoint");
    let source = Arc::new(QueueSource::new([Ok(modified(
        &scope,
        DiscoveryCoverage::CompleteAgentCatalog,
        [DiscoveredModel::new(model_id("remote"))],
    ))]));
    manager
        .refresh(scope.clone(), source.clone())
        .await
        .unwrap();
    let changed = ProviderConfigRegistry::from_definitions([
        definition("strict", ModelCatalogPolicy::ListedOnly)
            .with_models([ModelInfo::new(model_id("replacement"), "Replacement")]),
        definition("flexible", ModelCatalogPolicy::AllowUnlisted),
    ])
    .unwrap();
    let updated = manager.with_registry(changed);
    let snapshot = updated.static_snapshot(&provider_id("strict")).unwrap();
    assert!(snapshot.generation() > crate::CatalogGeneration::INITIAL);
    assert_eq!(snapshot.entries().len(), 1);
    assert_eq!(snapshot.entries()[0].model().model, model_id("replacement"));
    assert_eq!(
        updated.snapshot(&scope).unwrap().entries()[0].model().model,
        model_id("remote")
    );
    assert_eq!(
        manager
            .static_snapshot(&provider_id("strict"))
            .unwrap()
            .entries()
            .len(),
        2
    );
    assert_eq!(
        updated
            .static_snapshot(&provider_id("strict"))
            .unwrap()
            .entries()
            .len(),
        1
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn disk_cache_restores_each_subscription_scope_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("models");
    let manager = ModelsManager::new(registry()).with_disk_cache(directory.clone());
    for (scope_name, model_name) in [("account-a", "alpha-a"), ("account-b", "alpha-b")] {
        let scope = dynamic_scope("flexible", scope_name);
        manager
            .refresh(
                scope.clone(),
                Arc::new(QueueSource::new([Ok(modified(
                    &scope,
                    DiscoveryCoverage::CompleteAgentCatalog,
                    [DiscoveredModel::new(model_id(model_name)).with_metadata(
                        ModelMetadataPatch {
                            display_name: Some(format!("Model {model_name}")),
                            ..Default::default()
                        },
                    )],
                ))])),
            )
            .await
            .unwrap();
    }

    assert!(directory.join("flexible.json").is_file());
    let restarted = ModelsManager::new(registry()).with_disk_cache(directory);
    for (scope_name, model_name) in [("account-a", "alpha-a"), ("account-b", "alpha-b")] {
        let scope = dynamic_scope("flexible", scope_name);
        let snapshot = restarted.snapshot(&scope).unwrap();
        assert_eq!(snapshot.entries().len(), 1);
        assert_eq!(snapshot.entries()[0].model().model, model_id(model_name));
        assert_eq!(
            snapshot.entries()[0].availability(),
            ModelAvailability::Available
        );
        assert_eq!(
            snapshot.entries()[0].info().display_name,
            format!("Model {model_name}")
        );
    }
    assert!(
        restarted
            .snapshot(&dynamic_scope("flexible", "account-c"))
            .unwrap()
            .entries()
            .is_empty()
    );
}

#[tokio::test]
async fn disk_cache_separates_providers_and_escapes_file_names() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("models");
    let providers = ProviderConfigRegistry::from_definitions([
        definition("first", ModelCatalogPolicy::AllowUnlisted),
        definition("second", ModelCatalogPolicy::AllowUnlisted),
        definition("../outside", ModelCatalogPolicy::AllowUnlisted),
    ])
    .unwrap();
    let manager = ModelsManager::new(providers.clone()).with_disk_cache(directory.clone());
    for (provider, model) in [
        ("first", "first-model"),
        ("second", "second-model"),
        ("../outside", "escaped-model"),
    ] {
        let scope = dynamic_scope(provider, "same-account");
        manager
            .refresh(
                scope.clone(),
                Arc::new(QueueSource::new([Ok(modified(
                    &scope,
                    DiscoveryCoverage::CompleteAgentCatalog,
                    [DiscoveredModel::new(model_id(model))],
                ))])),
            )
            .await
            .unwrap();
    }
    for (file, present, absent) in [
        ("first.json", "first-model", "second-model"),
        ("second.json", "second-model", "first-model"),
        ("%2E%2E%2Foutside.json", "escaped-model", "first-model"),
    ] {
        let content = std::fs::read_to_string(directory.join(file)).unwrap();
        assert!(content.contains(present));
        assert!(!content.contains(absent));
    }
    assert!(!root.path().join("outside.json").exists());
    let restarted = ModelsManager::new(providers).with_disk_cache(directory);
    for (provider, model) in [
        ("first", "first-model"),
        ("second", "second-model"),
        ("../outside", "escaped-model"),
    ] {
        let snapshot = restarted
            .snapshot(&dynamic_scope(provider, "same-account"))
            .unwrap();
        assert_eq!(snapshot.entries()[0].model().model, model_id(model));
    }
}

#[tokio::test]
async fn corrupt_disk_cache_is_rebuilt_from_discovery() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("models");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("flexible.json"), b"invalid json").unwrap();
    let scope = dynamic_scope("flexible", "account-a");
    let manager = ModelsManager::new(registry()).with_disk_cache(directory.clone());
    assert!(manager.snapshot(&scope).unwrap().entries().is_empty());
    manager
        .refresh(
            scope.clone(),
            Arc::new(QueueSource::new([Ok(modified(
                &scope,
                DiscoveryCoverage::CompleteAgentCatalog,
                [DiscoveredModel::new(model_id("alpha-a"))],
            ))])),
        )
        .await
        .unwrap();
    assert_eq!(
        ModelsManager::new(registry())
            .with_disk_cache(directory)
            .snapshot(&scope)
            .unwrap()
            .entries()
            .len(),
        1
    );
}
