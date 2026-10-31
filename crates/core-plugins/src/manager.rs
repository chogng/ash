use crate::AshExtensionSourceConfig;
use crate::ExtensionSourceDescription;
use crate::ExtensionSourcesSnapshot;
use crate::sources::source_provider;
use ash_utils_plugins::ExtensionSourceId;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::AcquireCapabilityRequest;
use crate::AcquiredCapability;
use crate::ArtifactHandle;
use crate::CapabilityDescriptor;
use crate::CapabilityKind;
use crate::CapabilityLease;
use crate::CapabilityRef;
use crate::DownloadPackageRequest;
use crate::ExtensionPackagePayload;
use crate::ExtensionPackageService;
use crate::ExtensionSources;
use crate::ExtensionsClientError;
use crate::ExtensionsErrorCode;
use crate::GetPackageRequest;
use crate::InstallPackageRequest;
use crate::InstallationState;
use crate::InstalledPackage;
use crate::ListInstalledRequest;
use crate::OpenResourceRequest;
use crate::PackageDetails;
use crate::PackageRef;
use crate::ReleaseCapabilityRequest;
use crate::ResourceContent;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::UninstallMode;
use crate::UninstallPackageRequest;
use crate::UpdatePackageRequest;
use serde::Deserialize;
use serde::Serialize;

use crate::extension_packages_activation as activation;
use crate::extension_packages_store::Store;
use crate::extension_packages_store::opaque_id;

/// Ash's local owner for installed Plugin packages and capability leases.
///
/// The manager receives named providers for source discovery and verified packages. All
/// artifact storage, installation state, update/uninstall behavior, resource access, and leases
/// remain local to the Ash profile.
pub struct ExtensionPackageManager {
    providers: Mutex<ExtensionSources>,
    store: Store,
    runtime: Mutex<RuntimeState>,
    update_check: Mutex<()>,
    lease_sequence: AtomicU64,
    session_nonce: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct DurableState {
    #[serde(default)]
    update_policy: ExtensionUpdatePolicy,
    #[serde(default)]
    update_policy_revision: u64,
    #[serde(default)]
    sources: BTreeMap<ash_utils_plugins::ExtensionSourceId, crate::AshExtensionSourceConfig>,
    #[serde(default)]
    source_revision: u64,
    installations: BTreeMap<String, InstallationRecord>,
}

/// Profile-wide registry update policy; bundled product packages follow product updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionUpdatePolicy {
    pub auto_check_updates: bool,
    pub auto_update: bool,
}

impl Default for ExtensionUpdatePolicy {
    fn default() -> Self {
        Self {
            auto_check_updates: true,
            auto_update: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AvailableExtensionUpdate {
    pub installation_id: String,
    pub current: PackageRef,
    pub available: PackageRef,
}

/// A reconstructable check result plus the authoritative persisted policy and revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionUpdatesSnapshot {
    pub revision: u64,
    pub policy: ExtensionUpdatePolicy,
    pub checking: bool,
    pub last_checked_at: Option<u64>,
    pub available: Vec<AvailableExtensionUpdate>,
    pub updated: Vec<PackageRef>,
    pub failures: Vec<String>,
}

#[derive(Default)]
struct UpdateCheckState {
    checking: bool,
    last_checked_at: Option<u64>,
    available: Vec<AvailableExtensionUpdate>,
    updated: Vec<PackageRef>,
    failures: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallationRecord {
    pub installation_id: String,
    pub package: PackageRef,
    pub state: InstallationState,
    pub capabilities: Vec<CapabilityRecord>,
    #[serde(default)]
    product_runtime_authority: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CapabilityRecord {
    pub descriptor: CapabilityDescriptor,
    pub path: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub language_ids: Vec<String>,
}

/// A locally verified capability source for trusted in-process runtime adapters.
///
/// This handle is never serialized or projected through App Server. Product runtimes may use its
/// host path only to construct their own validated, read-only source handles; remote clients must
/// continue to use capability leases and opaque resources.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalCapabilitySource {
    package: PackageRef,
    capability: CapabilityRef,
    kind: CapabilityKind,
    id: String,
    runtime: Option<String>,
    language_ids: Vec<String>,
    package_root: PathBuf,
    relative_path: String,
    host_path: PathBuf,
    product_runtime: bool,
    editor_extension_root: Option<PathBuf>,
}

/// Independently verified sources. A damaged package cannot hide healthy installations or
/// prevent a consumer from retiring a source that has been removed or disabled.
pub struct LocalCapabilitySourceSnapshot {
    pub sources: Vec<LocalCapabilitySource>,
    pub failures: Vec<(PackageRef, ExtensionsClientError)>,
}

impl LocalCapabilitySource {
    /// Describes an exact Skill without exposing package naming conventions to its consumer.
    pub fn skill_root(&self) -> Option<ash_utils_plugins::PluginSkillRoot> {
        (self.kind == CapabilityKind::Skill).then(|| ash_utils_plugins::PluginSkillRoot {
            path: self.host_path.clone(),
            source: ash_utils_plugins::PluginSkillSource::Extensions,
            plugin_id: self.package.id.clone(),
            skill_name: self.id.clone(),
        })
    }

    /// True only for exact installed bytes downloaded under a product-pinned
    /// publisher delegation whose trust authority is still selected by this host.
    pub fn is_product_runtime(&self) -> bool {
        self.product_runtime
    }

    /// Exact editor asset root declared by the same verified package. Executable
    /// consumers may read their sidecar here without guessing a directory layout.
    pub fn editor_extension_root(&self) -> Option<&std::path::Path> {
        self.editor_extension_root.as_deref()
    }

    pub fn package(&self) -> &PackageRef {
        &self.package
    }

    pub fn capability(&self) -> &CapabilityRef {
        &self.capability
    }

    pub fn kind(&self) -> CapabilityKind {
        self.kind
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn runtime(&self) -> Option<&str> {
        self.runtime.as_deref()
    }

    pub fn language_ids(&self) -> &[String] {
        &self.language_ids
    }

    /// Returns the verified immutable artifact root for trusted in-process adapters.
    pub fn package_root(&self) -> &std::path::Path {
        &self.package_root
    }

    /// Returns this capability's signed package-relative path.
    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub fn host_path(&self) -> &std::path::Path {
        &self.host_path
    }
}

#[derive(Default)]
struct RuntimeState {
    durable: DurableState,
    update_check: UpdateCheckState,
    leases: BTreeMap<String, LeaseRecord>,
    generation: u64,
    subscribers: Vec<mpsc::Sender<u64>>,
}

struct LeaseRecord {
    lease: CapabilityLease,
}

impl ExtensionPackageManager {
    fn source_providers(&self) -> Result<ExtensionSources, ExtensionsClientError> {
        self.providers
            .lock()
            .map(|sources| sources.clone())
            .map_err(|_| ExtensionsClientError::storage())
    }

    /// Pins an exact verified source for a trusted product consumer. This grants package
    /// retention only; executable admission is checked by that consumer's separate authority.
    pub fn acquire_local_source(
        &self,
        source: &LocalCapabilitySource,
    ) -> Result<CapabilityLease, ExtensionsClientError> {
        let mut runtime = self.lock_runtime()?;
        let installation_id = self.validate_local_source(&runtime.durable, source)?;
        Ok(self.insert_lease(&mut runtime, source.capability.clone(), installation_id))
    }

    /// Checks the exact retained artifact before a product consumer admits new work.
    pub fn local_source_is_current(&self, source: &LocalCapabilitySource) -> bool {
        self.lock_runtime()
            .is_ok_and(|runtime| self.validate_local_source(&runtime.durable, source).is_ok())
    }

    fn validate_local_source(
        &self,
        durable: &DurableState,
        source: &LocalCapabilitySource,
    ) -> Result<String, ExtensionsClientError> {
        let (installation, capability) = find_capability(durable, &source.capability)?;
        self.ensure_supported_package(&installation.package)?;
        if installation.state != InstallationState::Installed
            || installation.package != source.package
            || capability.descriptor.kind != source.kind
            || capability.path != source.relative_path
            || self
                .store
                .verified_package_path(&installation.package, &capability.path)?
                != source.host_path
        {
            return Err(installation_in_use());
        }
        let product_runtime = installation.product_runtime_authority.is_some()
            && installation.product_runtime_authority
                == self.product_runtime_authority(&installation.package.id, durable)?;
        if source.product_runtime != product_runtime {
            return Err(ExtensionsClientError::package_untrusted());
        }
        Ok(installation.installation_id.clone())
    }

    fn insert_lease(
        &self,
        runtime: &mut RuntimeState,
        capability: CapabilityRef,
        installation_id: String,
    ) -> CapabilityLease {
        let sequence = self
            .lease_sequence
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        let lease = CapabilityLease {
            id: opaque_id("lease", &[&self.session_nonce, &sequence, &capability.id]),
            capability,
            installation_id,
        };
        runtime.leases.insert(
            lease.id.clone(),
            LeaseRecord {
                lease: lease.clone(),
            },
        );
        lease
    }

    /// Opens one profile-owned installation store over its explicitly registered sources.
    pub fn open(
        state_root: impl Into<PathBuf>,
        mut providers: ExtensionSources,
    ) -> Result<Self, ExtensionsClientError> {
        let store = Store::open(state_root.into())?;
        let mut durable: DurableState = store.read_state()?;
        if durable.update_policy.auto_update && !durable.update_policy.auto_check_updates {
            return Err(ExtensionsClientError::local_storage(
                "invalid persisted extension update policy",
            ));
        }
        crate::sources::restore_sources(&mut providers, &durable.sources, &store)?;
        durable
            .installations
            .retain(|_, installation| installation.state == InstallationState::Installed);
        let mut installations = BTreeMap::new();
        for (key, mut installation) in durable.installations {
            if key != installation.installation_id
                || key != installation_id(&installation.package)
                || crate::PluginVersion::new(&installation.package.version).is_err()
                || crate::PluginPackageDigest::new(&installation.package.digest).is_err()
            {
                return Err(ExtensionsClientError::storage());
            }
            if !installation.package.id.contains('@') {
                installation.package.id =
                    providers.legacy_id(&installation.package.id)?.to_string();
                installation.installation_id = installation_id(&installation.package);
            } else {
                ash_utils_plugins::PluginId::parse(&installation.package.id)
                    .map_err(|_| ExtensionsClientError::storage())?;
            }
            if installations
                .insert(installation.installation_id.clone(), installation)
                .is_some()
            {
                return Err(ExtensionsClientError::storage());
            }
        }
        durable.installations = installations;
        for installation in durable.installations.values_mut() {
            for capability in &mut installation.capabilities {
                capability.descriptor.reference = capability_reference(
                    &installation.installation_id,
                    capability.descriptor.kind,
                    &capability.descriptor.id,
                );
            }
        }
        store.write_state(&durable)?;
        let session_nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ExtensionsClientError::storage())?
            .as_nanos()
            .to_string();
        Ok(Self {
            providers: Mutex::new(providers),
            store,
            runtime: Mutex::new(RuntimeState {
                durable,
                update_check: UpdateCheckState::default(),
                leases: BTreeMap::new(),
                generation: 1,
                subscribers: Vec::new(),
            }),
            update_check: Mutex::new(()),
            lease_sequence: AtomicU64::new(1),
            session_nonce,
        })
    }

    /// Subscribes to committed installation-state changes for local domain adapters.
    pub fn subscribe(&self) -> Result<mpsc::Receiver<u64>, ExtensionsClientError> {
        let (sender, receiver) = mpsc::channel();
        self.lock_runtime()?.subscribers.push(sender);
        Ok(receiver)
    }

    /// Returns the current process-local installation generation.
    pub fn generation(&self) -> Result<u64, ExtensionsClientError> {
        Ok(self.lock_runtime()?.generation)
    }

    /// Identifies this process-local change stream for profile-level notification deduplication.
    pub fn change_source_id(&self) -> &str {
        &self.session_nonce
    }

    pub fn updates(&self) -> Result<ExtensionUpdatesSnapshot, ExtensionsClientError> {
        let runtime = self.lock_runtime()?;
        Ok(ExtensionUpdatesSnapshot {
            revision: runtime.durable.update_policy_revision,
            policy: runtime.durable.update_policy.clone(),
            checking: runtime.update_check.checking,
            last_checked_at: runtime.update_check.last_checked_at,
            available: runtime.update_check.available.clone(),
            updated: runtime.update_check.updated.clone(),
            failures: runtime.update_check.failures.clone(),
        })
    }

    pub fn set_update_policy(
        &self,
        policy: ExtensionUpdatePolicy,
        expected_revision: u64,
    ) -> Result<ExtensionUpdatesSnapshot, ExtensionsClientError> {
        if policy.auto_update && !policy.auto_check_updates {
            return Err(ExtensionsClientError::invalid_request(
                "automatic updates require automatic checks",
            ));
        }
        let mut runtime = self.lock_runtime()?;
        if runtime.durable.update_policy_revision != expected_revision {
            return Err(ExtensionsClientError::invalid_request(
                "extension update policy revision conflict",
            ));
        }
        let mut durable = runtime.durable.clone();
        durable.update_policy = policy;
        durable.update_policy_revision = durable
            .update_policy_revision
            .checked_add(1)
            .ok_or_else(ExtensionsClientError::storage)?;
        self.store.write_state(&durable)?;
        runtime.durable = durable;
        publish_change(&mut runtime)?;
        drop(runtime);
        self.updates()
    }

    /// Checks signed registries without granting execution to a new package identity.
    pub fn check_for_updates(&self) -> Result<ExtensionUpdatesSnapshot, ExtensionsClientError> {
        let _check = self
            .update_check
            .lock()
            .map_err(|_| ExtensionsClientError::storage())?;
        self.check_updates_now(|| false)
    }

    /// Called by the single profile worker. Failed sources are retried at the next hourly check.
    pub fn check_for_updates_if_due(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<(), ExtensionsClientError> {
        let _check = match self.update_check.try_lock() {
            Ok(check) => check,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(ExtensionsClientError::storage());
            }
        };
        let runtime = self.lock_runtime()?;
        let now = update_time()?;
        if cancelled.load(Ordering::Acquire)
            || !runtime.durable.update_policy.auto_check_updates
            || runtime
                .update_check
                .last_checked_at
                .is_some_and(|last| now.saturating_sub(last) < 3_600_000)
        {
            return Ok(());
        }
        drop(runtime);
        self.check_updates_now(|| cancelled.load(Ordering::Acquire))
            .map(|_| ())
    }

    fn check_updates_now(
        &self,
        cancelled: impl Fn() -> bool,
    ) -> Result<ExtensionUpdatesSnapshot, ExtensionsClientError> {
        let installations = {
            let mut runtime = self.lock_runtime()?;
            runtime.update_check = UpdateCheckState {
                checking: true,
                last_checked_at: Some(update_time()?),
                ..Default::default()
            };
            publish_change(&mut runtime)?;
            runtime
                .durable
                .installations
                .values()
                .filter(|record| {
                    record.state == InstallationState::Installed
                        && record.product_runtime_authority.is_none()
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut available = Vec::new();
        let mut updated = Vec::new();
        let mut failures = Vec::new();
        for installation in installations {
            if cancelled() {
                break;
            }
            let candidate = match self.get(GetPackageRequest {
                package_id: installation.package.id.clone(),
                version: None,
            }) {
                Ok(details) => details.package,
                Err(_) => {
                    failures.push(installation.package.id.clone());
                    continue;
                }
            };
            let (Ok(current), Ok(next)) = (
                semver::Version::parse(&installation.package.version),
                semver::Version::parse(&candidate.version),
            ) else {
                failures.push(installation.package.id.clone());
                continue;
            };
            if next <= current || !next.pre.is_empty() {
                continue;
            }
            let apply = {
                let runtime = self.lock_runtime()?;
                // A concurrent uninstall or manual update retires this exact installation.
                let current = runtime
                    .durable
                    .installations
                    .get(&installation.installation_id);
                if !current.is_some_and(|record| {
                    record.package == installation.package
                        && record.state == InstallationState::Installed
                }) {
                    continue;
                }
                runtime.durable.update_policy.auto_update
            };
            let update = AvailableExtensionUpdate {
                installation_id: installation.installation_id.clone(),
                current: installation.package.clone(),
                available: candidate.clone(),
            };
            if apply && !cancelled() {
                match self.update(UpdatePackageRequest {
                    installation_id: installation.installation_id,
                    version: Some(candidate.version),
                }) {
                    Ok(installed) => updated.push(installed.package),
                    Err(_) => {
                        failures.push(installation.package.id);
                        available.push(update);
                    }
                }
            } else {
                available.push(update);
            }
        }
        let mut runtime = self.lock_runtime()?;
        runtime.update_check.checking = false;
        runtime.update_check.available = available;
        runtime.update_check.updated = updated;
        runtime.update_check.failures = failures;
        publish_change(&mut runtime)?;
        drop(runtime);
        self.updates()
    }

    /// Returns verified sources of one capability kind for trusted local runtime composition.
    ///
    /// The ordinary Extensions service contract intentionally exposes no filesystem paths. This
    /// local-only adapter revalidates the complete immutable artifact before returning a host
    /// handle and must not be used by transports or Renderer code.
    pub fn local_capability_sources(
        &self,
        kind: CapabilityKind,
    ) -> Result<Vec<LocalCapabilitySource>, ExtensionsClientError> {
        let snapshot = self.local_capability_source_snapshot(kind)?;
        if let Some((_, error)) = snapshot.failures.into_iter().next() {
            return Err(error);
        }
        Ok(snapshot.sources)
    }

    /// Verifies each installation independently for consumers that must reconcile revocations
    /// even when another package is unavailable. Storage failures still fail the whole snapshot.
    pub fn local_capability_source_snapshot(
        &self,
        kind: CapabilityKind,
    ) -> Result<LocalCapabilitySourceSnapshot, ExtensionsClientError> {
        let durable = self
            .runtime
            .lock()
            .map_err(|_| ExtensionsClientError::storage())?
            .durable
            .clone();
        let mut sources = Vec::new();
        let mut failures = Vec::new();
        for installation in durable
            .installations
            .values()
            .filter(|installation| installation.state == InstallationState::Installed)
        {
            match self.store.is_retired_package(&installation.package) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    failures.push((installation.package.clone(), error));
                    continue;
                }
            }
            for capability in installation
                .capabilities
                .iter()
                .filter(|capability| capability.descriptor.kind == kind)
            {
                let source = (|| {
                    let mut editor_assets = installation
                        .capabilities
                        .iter()
                        .filter(|entry| entry.descriptor.kind == CapabilityKind::EditorExtension);
                    let editor_extension_root = editor_assets
                        .next()
                        .map(|entry| {
                            self.store
                                .verified_package_path(&installation.package, &entry.path)
                        })
                        .transpose()?;
                    if editor_assets.next().is_some() {
                        return Err(ExtensionsClientError::package_untrusted());
                    }
                    Ok(LocalCapabilitySource {
                        editor_extension_root,
                        product_runtime: installation.product_runtime_authority.is_some()
                            && installation.product_runtime_authority
                                == self.product_runtime_authority(
                                    &installation.package.id,
                                    &durable,
                                )?,
                        package: installation.package.clone(),
                        capability: capability.descriptor.reference.clone(),
                        kind,
                        id: capability.descriptor.id.clone(),
                        runtime: capability.runtime.clone(),
                        language_ids: capability.language_ids.clone(),
                        package_root: self.store.verified_package_root(&installation.package)?,
                        relative_path: capability.path.clone(),
                        host_path: self
                            .store
                            .verified_package_path(&installation.package, &capability.path)?,
                    })
                })();
                match source {
                    Ok(source) => sources.push(source),
                    Err(error) => failures.push((installation.package.clone(), error)),
                }
            }
        }
        sources.sort_by(|left, right| {
            (
                &left.package.id,
                &left.package.version,
                &left.id,
                &left.capability.id,
            )
                .cmp(&(
                    &right.package.id,
                    &right.package.version,
                    &right.id,
                    &right.capability.id,
                ))
        });
        Ok(LocalCapabilitySourceSnapshot { sources, failures })
    }

    fn product_runtime_authority(
        &self,
        package_id: &str,
        durable: &DurableState,
    ) -> Result<Option<String>, ExtensionsClientError> {
        let id = ash_utils_plugins::PluginId::parse(package_id)
            .map_err(|_| ExtensionsClientError::package_untrusted())?;
        if durable.sources.contains_key(id.source_id()) {
            return Ok(None);
        }
        Ok(self
            .source_providers()?
            .product_runtime_authority(package_id))
    }

    fn install_downloaded(
        &self,
        downloaded: &dyn ExtensionPackagePayload,
    ) -> Result<InstalledPackage, ExtensionsClientError> {
        let artifact = self.store.materialize(downloaded)?;
        self.ensure_supported_package(&artifact.package)?;
        let installation_id = installation_id(&artifact.package);
        let capabilities = downloaded
            .capabilities()
            .iter()
            .map(|capability| CapabilityRecord {
                descriptor: CapabilityDescriptor {
                    reference: capability_reference(
                        &installation_id,
                        capability.kind,
                        &capability.id,
                    ),
                    kind: capability.kind,
                    id: capability.id.clone(),
                    contract_version: "1".into(),
                    permissions: Vec::new(),
                    authentication_provider: None,
                },
                path: capability.path.clone(),
                runtime: capability.runtime.clone(),
                language_ids: capability.language_ids.clone(),
            })
            .collect::<Vec<_>>();
        let mut installation = InstallationRecord {
            product_runtime_authority: {
                let runtime = self.lock_runtime()?;
                self.product_runtime_authority(&artifact.package.id, &runtime.durable)?
            },
            installation_id: installation_id.clone(),
            package: artifact.package,
            state: InstallationState::Installed,
            capabilities,
        };
        for capability in &mut installation.capabilities {
            capability.descriptor =
                activation::descriptor(&self.store, &installation.package, capability)?;
        }
        let mut runtime = self.lock_runtime()?;
        let installation = runtime
            .durable
            .installations
            .entry(installation_id)
            .or_insert(installation)
            .clone();
        self.store.write_state(&runtime.durable)?;
        publish_change(&mut runtime)?;
        Ok(installation.public())
    }

    fn lock_runtime(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, RuntimeState>, ExtensionsClientError> {
        self.runtime.lock().map_err(|_| {
            ExtensionsClientError::business(
                ExtensionsErrorCode::ServiceUnavailable,
                "Extensions Manager is unavailable",
                true,
            )
        })
    }

    fn ensure_supported_package(&self, package: &PackageRef) -> Result<(), ExtensionsClientError> {
        if self.store.is_retired_package(package)? {
            return Err(ExtensionsClientError::business(
                ExtensionsErrorCode::PackageUntrusted,
                "retired extension package format",
                false,
            ));
        }
        Ok(())
    }
}

impl ExtensionPackageManager {
    pub fn sources(&self) -> Result<ExtensionSourcesSnapshot, ExtensionsClientError> {
        let runtime = self.lock_runtime()?;
        let providers = self.source_providers()?;
        Ok(ExtensionSourcesSnapshot {
            revision: runtime.durable.source_revision,
            sources: providers
                .providers
                .iter()
                .map(|(id, _provider)| ExtensionSourceDescription {
                    id: id.clone(),
                    kind: crate::ExtensionRegistryKind::Ash,
                    enabled: !providers.disabled.contains(id),
                    product_owned: !runtime.durable.sources.contains_key(id),
                })
                .collect(),
        })
    }

    /// Adds a new immutable source identity. Reusing an ID cannot replace its trust root.
    pub fn add_source(
        &self,
        config: AshExtensionSourceConfig,
        expected_revision: u64,
    ) -> Result<ExtensionSourcesSnapshot, ExtensionsClientError> {
        let provider = source_provider(&config, &self.store.source_cache_root(&config.id))?;
        {
            let mut runtime = self.lock_runtime()?;
            let mut providers = self
                .providers
                .lock()
                .map_err(|_| ExtensionsClientError::storage())?;
            if runtime.durable.source_revision != expected_revision
                || providers.providers.contains_key(&config.id)
                || providers.providers.len() >= 32
            {
                return Err(ExtensionsClientError::invalid_request(
                    "extension source revision or identity conflict",
                ));
            }
            let mut durable = runtime.durable.clone();
            durable.source_revision = durable
                .source_revision
                .checked_add(1)
                .ok_or_else(ExtensionsClientError::storage)?;
            durable.sources.insert(config.id.clone(), config.clone());
            self.store.write_state(&durable)?;
            if !config.enabled {
                providers.disabled.insert(config.id.clone());
            }
            providers.providers.insert(config.id, provider);
            runtime.durable = durable;
            publish_change(&mut runtime)?;
        }
        self.sources()
    }

    /// Pausing discovery leaves exact installed packages and their domain policies intact.
    pub fn set_source_enabled(
        &self,
        id: &ExtensionSourceId,
        enabled: bool,
        expected_revision: u64,
    ) -> Result<ExtensionSourcesSnapshot, ExtensionsClientError> {
        {
            let mut runtime = self.lock_runtime()?;
            let mut providers = self
                .providers
                .lock()
                .map_err(|_| ExtensionsClientError::storage())?;
            if runtime.durable.source_revision != expected_revision {
                return Err(ExtensionsClientError::invalid_request(
                    "extension source revision conflict",
                ));
            }
            let mut durable = runtime.durable.clone();
            let source = durable.sources.get_mut(id).ok_or_else(|| {
                ExtensionsClientError::invalid_request(
                    "product extension sources cannot be changed",
                )
            })?;
            source.enabled = enabled;
            durable.source_revision = durable
                .source_revision
                .checked_add(1)
                .ok_or_else(ExtensionsClientError::storage)?;
            self.store.write_state(&durable)?;
            if enabled {
                providers.disabled.remove(id);
            } else {
                providers.disabled.insert(id.clone());
            }
            runtime.durable = durable;
            publish_change(&mut runtime)?;
        }
        self.sources()
    }
}

impl ExtensionPackageService for ExtensionPackageManager {
    fn search_page(
        &self,
        request: crate::SearchPackagesPageRequest,
    ) -> Result<crate::SearchPackagesPageResult, ExtensionsClientError> {
        self.source_providers()?.search_page(request)
    }

    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError> {
        self.source_providers()?.search(request)
    }

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, ExtensionsClientError> {
        self.source_providers()?.get(request)
    }

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<ArtifactHandle, ExtensionsClientError> {
        let downloaded = self.source_providers()?.download(request)?;
        let artifact = self.store.materialize(downloaded.as_ref())?;
        self.ensure_supported_package(&artifact.package)?;
        Ok(artifact)
    }

    fn install(
        &self,
        request: InstallPackageRequest,
    ) -> Result<InstalledPackage, ExtensionsClientError> {
        let downloaded = self.source_providers()?.download(DownloadPackageRequest {
            package_id: request.package_id,
            version: request.version,
        })?;
        self.install_downloaded(downloaded.as_ref())
    }

    fn update(
        &self,
        request: UpdatePackageRequest,
    ) -> Result<InstalledPackage, ExtensionsClientError> {
        let package_id = {
            let runtime = self.lock_runtime()?;
            runtime
                .durable
                .installations
                .get(&request.installation_id)
                .ok_or_else(installation_not_found)?
                .package
                .id
                .clone()
        };
        let downloaded = self.source_providers()?.download(DownloadPackageRequest {
            package_id,
            version: request.version,
        })?;
        let installed = self.install_downloaded(downloaded.as_ref())?;
        if installed.installation_id != request.installation_id {
            self.uninstall(UninstallPackageRequest {
                installation_id: request.installation_id,
                mode: UninstallMode::WhenUnused,
            })?;
        }
        Ok(installed)
    }

    fn uninstall(&self, request: UninstallPackageRequest) -> Result<(), ExtensionsClientError> {
        let mut runtime = self.lock_runtime()?;
        if !runtime
            .durable
            .installations
            .contains_key(&request.installation_id)
        {
            return Err(installation_not_found());
        }
        let in_use = runtime
            .leases
            .values()
            .any(|lease| lease.lease.installation_id == request.installation_id);
        match (request.mode, in_use) {
            (UninstallMode::IfUnused, true) => return Err(installation_in_use()),
            (UninstallMode::WhenUnused, true) => {
                runtime
                    .durable
                    .installations
                    .get_mut(&request.installation_id)
                    .expect("installation existence was checked")
                    .state = InstallationState::PendingRemoval;
            }
            (UninstallMode::IfUnused | UninstallMode::WhenUnused, false) => {
                runtime
                    .durable
                    .installations
                    .remove(&request.installation_id);
            }
        }
        self.store.write_state(&runtime.durable)?;
        publish_change(&mut runtime)
    }

    fn list_installed(
        &self,
        _: ListInstalledRequest,
    ) -> Result<Vec<InstalledPackage>, ExtensionsClientError> {
        let runtime = self.lock_runtime()?;
        Ok(runtime
            .durable
            .installations
            .values()
            .map(InstallationRecord::public)
            .collect())
    }

    fn acquire_capability(
        &self,
        request: AcquireCapabilityRequest,
    ) -> Result<AcquiredCapability, ExtensionsClientError> {
        let mut runtime = self.lock_runtime()?;
        let (installation, capability) = find_capability(&runtime.durable, &request.capability)?;
        let installation = installation.clone();
        self.ensure_supported_package(&installation.package)?;
        let capability = capability.clone();
        if installation.state == InstallationState::PendingRemoval {
            return Err(installation_in_use());
        }
        let spec = activation::acquire_spec(&self.store, &installation, &capability)?;
        let lease = self.insert_lease(
            &mut runtime,
            request.capability,
            installation.installation_id,
        );
        Ok(AcquiredCapability { lease, spec })
    }

    fn release_capability(
        &self,
        request: ReleaseCapabilityRequest,
    ) -> Result<crate::ReleaseCapabilityOutcome, ExtensionsClientError> {
        let mut runtime = self.lock_runtime()?;
        let lease = runtime
            .leases
            .remove(&request.lease_id)
            .ok_or_else(lease_not_found)?;
        let installation_id = lease.lease.installation_id;
        let still_in_use = runtime
            .leases
            .values()
            .any(|candidate| candidate.lease.installation_id == installation_id);
        let installation_changed = !still_in_use
            && runtime
                .durable
                .installations
                .get(&installation_id)
                .is_some_and(|installation| {
                    installation.state == InstallationState::PendingRemoval
                });
        if installation_changed {
            runtime.durable.installations.remove(&installation_id);
            self.store.write_state(&runtime.durable)?;
            publish_change(&mut runtime)?;
        }
        Ok(crate::ReleaseCapabilityOutcome {
            installation_changed,
        })
    }

    fn open_resource(
        &self,
        request: OpenResourceRequest,
    ) -> Result<ResourceContent, ExtensionsClientError> {
        let runtime = self.lock_runtime()?;
        let lease = runtime
            .leases
            .get(&request.lease_id)
            .ok_or_else(lease_not_found)?;
        let installation = runtime
            .durable
            .installations
            .get(&lease.lease.installation_id)
            .ok_or_else(installation_not_found)?;
        let capability = installation
            .capabilities
            .iter()
            .find(|capability| capability.descriptor.reference == lease.lease.capability)
            .ok_or_else(capability_not_found)?;
        activation::open_resource(&self.store, installation, capability, &request.resource)
    }
}

impl InstallationRecord {
    fn public(&self) -> InstalledPackage {
        InstalledPackage {
            installation_id: self.installation_id.clone(),
            package: self.package.clone(),
            state: self.state,
            capabilities: self
                .capabilities
                .iter()
                .map(|capability| capability.descriptor.clone())
                .collect(),
        }
    }
}

fn find_capability<'a>(
    state: &'a DurableState,
    reference: &CapabilityRef,
) -> Result<(&'a InstallationRecord, &'a CapabilityRecord), ExtensionsClientError> {
    state
        .installations
        .values()
        .find_map(|installation| {
            installation
                .capabilities
                .iter()
                .find(|capability| capability.descriptor.reference == *reference)
                .map(|capability| (installation, capability))
        })
        .ok_or_else(capability_not_found)
}

fn installation_id(package: &PackageRef) -> String {
    opaque_id("ins", &[&package.id, &package.version, &package.digest])
}

fn capability_reference(
    installation_id: &str,
    kind: CapabilityKind,
    capability_id: &str,
) -> CapabilityRef {
    CapabilityRef {
        id: opaque_id(
            "cap",
            &[installation_id, capability_kind_tag(kind), capability_id],
        ),
    }
}

fn capability_kind_tag(kind: CapabilityKind) -> &'static str {
    match kind {
        CapabilityKind::Skill => "skill",
        CapabilityKind::Mcp => "mcp",
        CapabilityKind::Connector => "connector",
        CapabilityKind::Theme => "theme",
        CapabilityKind::Language => "language",
        CapabilityKind::Localization => "localization",
        CapabilityKind::Executable => "executable",
        CapabilityKind::EditorExtension => "editorExtension",
        CapabilityKind::Asset => "asset",
    }
}

fn installation_not_found() -> ExtensionsClientError {
    ExtensionsClientError::business(
        ExtensionsErrorCode::InstallationNotFound,
        "Extensions installation was not found",
        false,
    )
}

fn update_time() -> Result<u64, ExtensionsClientError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(ExtensionsClientError::storage)
}

fn publish_change(runtime: &mut RuntimeState) -> Result<(), ExtensionsClientError> {
    runtime.generation = runtime
        .generation
        .checked_add(1)
        .ok_or_else(ExtensionsClientError::storage)?;
    let generation = runtime.generation;
    runtime
        .subscribers
        .retain(|subscriber| subscriber.send(generation).is_ok());
    Ok(())
}

fn installation_in_use() -> ExtensionsClientError {
    ExtensionsClientError::business(
        ExtensionsErrorCode::InstallationInUse,
        "Extensions installation is in use",
        false,
    )
}

fn capability_not_found() -> ExtensionsClientError {
    ExtensionsClientError::business(
        ExtensionsErrorCode::CapabilityNotFound,
        "Extensions capability was not found",
        false,
    )
}

fn lease_not_found() -> ExtensionsClientError {
    ExtensionsClientError::business(
        ExtensionsErrorCode::LeaseNotFound,
        "Extensions capability lease was not found",
        false,
    )
}
