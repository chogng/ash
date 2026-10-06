use std::collections::BTreeMap;
use std::fmt;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use crate::InstalledPluginPackage;
use crate::InstalledPluginRef;
use crate::LocalPluginPackage;
use crate::PluginActivationSnapshot;
use crate::PluginError;
use crate::PluginErrorKind;
use crate::PluginPackageDigest;
use crate::PluginPackageId;
use crate::PluginPackageStore;

mod persistence;

use persistence::AuthorityStateRef;
use persistence::FileAuthorityPersistence;
use persistence::PersistedAuthority;
use persistence::PersistedCommandReceipt;

const MAX_COMMAND_ID_BYTES: usize = 128;

/// Stable retry identity for one Plugin authority mutation.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PluginAuthorityCommandId(String);

impl PluginAuthorityCommandId {
    pub fn new(value: impl Into<String>) -> Result<Self, PluginError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_COMMAND_ID_BYTES
            || value.chars().any(char::is_control)
        {
            return Err(authority_error(
                PluginErrorKind::CommandConflict,
                "Plugin command ID is invalid",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One exact, retry-safe mutation of installed or active Plugin authority.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PluginAuthorityCommand {
    Install { package: InstalledPluginRef },
    Enable { package: InstalledPluginRef },
    Disable { package: InstalledPluginRef },
    Grant { package: InstalledPluginRef },
    RevokeGrant { package: InstalledPluginRef },
    RevokePackage { package: InstalledPluginRef },
    RestorePackage { package: InstalledPluginRef },
    Uninstall { package: InstalledPluginRef },
}

/// Compare-and-swap request applied to the durable Plugin authority.
#[derive(Clone, Debug)]
pub struct PluginAuthorityCommandRequest {
    pub command_id: PluginAuthorityCommandId,
    pub expected_revision: u64,
    pub command: PluginAuthorityCommand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginAuthorityDisposition {
    Updated,
    Replayed,
}

/// Result of one committed or exactly replayed Plugin authority command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginAuthorityCommandResult {
    pub revision: u64,
    pub activation_generation: u64,
    pub disposition: PluginAuthorityDisposition,
}

/// Exact installed object and authority commit produced by one local installation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginInstallResult {
    pub package: InstalledPluginRef,
    pub command: PluginAuthorityCommandResult,
}

/// Immutable installed, enabled, granted, and effective projection of Plugin authority.
#[derive(Clone, Debug)]
pub struct PluginAuthoritySnapshot {
    revision: u64,
    installed: Vec<InstalledPluginRef>,
    enabled: Vec<InstalledPluginRef>,
    granted: Vec<InstalledPluginRef>,
    revoked: Vec<InstalledPluginRef>,
    activation: PluginActivationSnapshot,
}

impl PluginAuthoritySnapshot {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn installed(&self) -> &[InstalledPluginRef] {
        &self.installed
    }

    /// Exact packages selected by profile policy, independent of grants.
    pub fn enabled(&self) -> &[InstalledPluginRef] {
        &self.enabled
    }

    /// Exact packages whose contribution authority has been granted.
    pub fn granted(&self) -> &[InstalledPluginRef] {
        &self.granted
    }

    /// Exact packages denied by a trusted distribution revocation decision.
    ///
    /// Revocations are durable tombstones and can therefore refer to packages that are not
    /// currently installed.
    pub fn revoked(&self) -> &[InstalledPluginRef] {
        &self.revoked
    }

    pub fn activation(&self) -> &PluginActivationSnapshot {
        &self.activation
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct InstalledKey {
    id: PluginPackageId,
    version: crate::PluginVersion,
}

impl InstalledKey {
    fn from_package(package: &InstalledPluginRef) -> Self {
        Self {
            id: package.id.clone(),
            version: package.version.clone(),
        }
    }
}

#[derive(Clone)]
struct ActivePlugin {
    package: InstalledPluginRef,
    activation_revision: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct InvocationKey {
    plugin_id: PluginPackageId,
    package_digest: PluginPackageDigest,
    activation_revision: u64,
}

struct AuthorityState {
    revision: u64,
    activation_generation: u64,
    installed: BTreeMap<InstalledKey, InstalledPluginRef>,
    enabled: BTreeMap<PluginPackageId, InstalledPluginRef>,
    granted: BTreeMap<InstalledKey, InstalledPluginRef>,
    revoked: BTreeMap<InstalledKey, InstalledPluginRef>,
    active: BTreeMap<PluginPackageId, ActivePlugin>,
    activation: PluginActivationSnapshot,
    receipts: BTreeMap<String, PersistedCommandReceipt>,
    in_flight: BTreeMap<InvocationKey, usize>,
}

enum Persistence {
    Memory,
    File(FileAuthorityPersistence),
}

impl Persistence {
    fn persist(&self, authority: &PersistedAuthority) -> Result<(), PluginError> {
        match self {
            Self::Memory => Ok(()),
            Self::File(file) => file.persist(authority),
        }
    }
}

struct PluginActivationAuthorityInner {
    store: PluginPackageStore,
    state: Mutex<AuthorityState>,
    drained: Condvar,
    persistence: Persistence,
    subscribers: Mutex<Vec<mpsc::Sender<PluginAuthorityChange>>>,
}

/// Durable source of truth for installed packages and the exact active Plugin set.
///
/// Implementations publish immutable activation snapshots. Runtime consumers must bind an
/// invocation fence to each contribution and acquire its lease immediately before dispatch.
#[derive(Clone)]
pub struct PluginActivationAuthority {
    inner: Arc<PluginActivationAuthorityInner>,
}

impl PluginActivationAuthority {
    /// Opens one profile authority and its colocated content-addressed package store.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PluginError> {
        let root = root.as_ref();
        let store = PluginPackageStore::open(root)?;
        let persistence = FileAuthorityPersistence::open(root.join("authority.json"))?;
        let persisted = persistence
            .load()?
            .unwrap_or_else(PersistedAuthority::empty);
        Self::from_persisted(store, persisted, Persistence::File(persistence))
    }

    /// Creates a process-local authority over an existing package store.
    pub fn in_memory(store: PluginPackageStore) -> Result<Self, PluginError> {
        Self::from_persisted(store, PersistedAuthority::empty(), Persistence::Memory)
    }

    fn from_persisted(
        store: PluginPackageStore,
        persisted: PersistedAuthority,
        persistence: Persistence,
    ) -> Result<Self, PluginError> {
        persisted.validate()?;
        let persisted = persisted.migrate();
        let mut installed = BTreeMap::new();
        for package in persisted.installed {
            store.read(&package)?;
            if installed
                .insert(InstalledKey::from_package(&package), package)
                .is_some()
            {
                return Err(authority_error(
                    PluginErrorKind::PackageConflict,
                    "Plugin authority contains duplicate installed versions",
                ));
            }
        }
        if matches!(&persistence, Persistence::File(_)) {
            store.recover_orphans()?;
        }
        let mut active = BTreeMap::new();
        for record in persisted.active {
            let key = InstalledKey::from_package(&record.package);
            if installed.get(&key) != Some(&record.package)
                || active
                    .insert(
                        record.package.id.clone(),
                        ActivePlugin {
                            package: record.package,
                            activation_revision: record.activation_revision,
                        },
                    )
                    .is_some()
            {
                return Err(authority_error(
                    PluginErrorKind::PackageConflict,
                    "Plugin authority active set does not match installed objects",
                ));
            }
        }
        let enabled = package_map_by_plugin(&installed, persisted.enabled, "enabled")?;
        let granted = package_map_by_key(&installed, persisted.granted, "granted")?;
        let revoked = package_tombstones(persisted.revoked, "revoked")?;
        let expected_active = effective_active(&enabled, &granted, &revoked);
        if !same_active_packages(&active, &expected_active) {
            return Err(authority_error(
                PluginErrorKind::PackageConflict,
                "Plugin authority active set does not match enabled grants",
            ));
        }
        let activation = resolve_activation(persisted.activation_generation, &store, &active)?;
        Ok(Self {
            inner: Arc::new(PluginActivationAuthorityInner {
                store,
                state: Mutex::new(AuthorityState {
                    revision: persisted.revision,
                    activation_generation: persisted.activation_generation,
                    installed,
                    enabled,
                    granted,
                    revoked,
                    active,
                    activation,
                    receipts: persisted.receipts,
                    in_flight: BTreeMap::new(),
                }),
                drained: Condvar::new(),
                persistence,
                subscribers: Mutex::new(Vec::new()),
            }),
        })
    }

    pub fn snapshot(&self) -> PluginAuthoritySnapshot {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        PluginAuthoritySnapshot {
            revision: state.revision,
            installed: state.installed.values().cloned().collect(),
            enabled: state.enabled.values().cloned().collect(),
            granted: state.granted.values().cloned().collect(),
            revoked: state.revoked.values().cloned().collect(),
            activation: state.activation.clone(),
        }
    }

    pub fn subscribe(&self) -> PluginAuthoritySubscription {
        let (sender, receiver) = mpsc::channel();
        self.inner
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(sender);
        PluginAuthoritySubscription { receiver }
    }

    /// Reads metadata from an exact installed object, including disabled and ungranted packages.
    /// The authority lock keeps uninstall from removing that object during validation.
    pub fn installed_manifest(
        &self,
        package: &InstalledPluginRef,
    ) -> Result<crate::PluginManifest, PluginError> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| authority_unavailable("Plugin authority lock is unavailable"))?;
        if state.installed.get(&InstalledKey::from_package(package)) != Some(package) {
            return Err(authority_error(
                PluginErrorKind::SourceUnavailable,
                "Plugin package is not installed",
            ));
        }
        Ok(self.inner.store.read(package)?.manifest().clone())
    }

    /// Validates, copies, and records one local-development package without enabling it.
    pub fn install_local(
        &self,
        command_id: PluginAuthorityCommandId,
        expected_revision: u64,
        package: &LocalPluginPackage,
    ) -> Result<PluginInstallResult, PluginError> {
        self.install_validated(command_id, expected_revision, package)
    }

    fn install_validated(
        &self,
        command_id: PluginAuthorityCommandId,
        expected_revision: u64,
        package: &LocalPluginPackage,
    ) -> Result<PluginInstallResult, PluginError> {
        let installed = self.inner.store.install_local(package)?;
        let command = self.apply(PluginAuthorityCommandRequest {
            command_id,
            expected_revision,
            command: PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        });
        let command = match command {
            Ok(command) => command,
            Err(error) => {
                if !self
                    .snapshot()
                    .installed()
                    .iter()
                    .any(|package| package.digest == installed.digest)
                {
                    let _ = self.inner.store.remove_object(&installed.digest);
                }
                return Err(error);
            }
        };
        Ok(PluginInstallResult {
            package: installed,
            command,
        })
    }

    pub fn apply(
        &self,
        request: PluginAuthorityCommandRequest,
    ) -> Result<PluginAuthorityCommandResult, PluginError> {
        let command_digest = command_digest(&request.command)?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| authority_unavailable("Plugin authority lock is unavailable"))?;
        if let Some(receipt) = state.receipts.get(request.command_id.as_str()) {
            if receipt.expected_revision != request.expected_revision
                || receipt.command_digest != command_digest
            {
                return Err(authority_error(
                    PluginErrorKind::CommandConflict,
                    "Plugin command ID was already used for a different request",
                ));
            }
            return Ok(PluginAuthorityCommandResult {
                revision: receipt.result_revision,
                activation_generation: receipt.activation_generation,
                disposition: PluginAuthorityDisposition::Replayed,
            });
        }
        if state.revision != request.expected_revision {
            return Err(authority_error(
                PluginErrorKind::GenerationConflict,
                format!(
                    "Plugin authority revision conflict: expected {}, actual {}",
                    request.expected_revision, state.revision
                ),
            ));
        }

        let result_revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| authority_unavailable("Plugin authority revision overflow"))?;
        let mut installed = state.installed.clone();
        let mut enabled = state.enabled.clone();
        let mut granted = state.granted.clone();
        let mut revoked = state.revoked.clone();
        apply_command(
            &self.inner.store,
            &mut installed,
            &mut enabled,
            &mut granted,
            &mut revoked,
            &request.command,
        )?;
        let mut active = effective_active(&enabled, &granted, &revoked);
        let activation_changed = !same_active_set(&state.active, &active);
        let activation_generation = if activation_changed {
            state
                .activation_generation
                .checked_add(1)
                .ok_or_else(|| authority_unavailable("Plugin activation generation overflow"))?
        } else {
            state.activation_generation
        };
        stamp_changed_activations(&state.active, &mut active, activation_generation);
        let activation = if activation_changed {
            resolve_activation(activation_generation, &self.inner.store, &active)?
        } else {
            state.activation.clone()
        };
        let drained = revoked_invocations(&state.active, &active);
        let receipt = PersistedCommandReceipt {
            expected_revision: request.expected_revision,
            command_digest,
            result_revision,
            activation_generation,
        };
        let mut receipts = state.receipts.clone();
        receipts.insert(request.command_id.as_str().to_string(), receipt);
        self.inner
            .persistence
            .persist(&PersistedAuthority::from_state(AuthorityStateRef {
                revision: result_revision,
                activation_generation,
                installed: &installed,
                enabled: &enabled,
                granted: &granted,
                revoked: &revoked,
                active: &active,
                receipts: &receipts,
            }))?;
        state.revision = result_revision;
        state.activation_generation = activation_generation;
        let removed_object = match &request.command {
            PluginAuthorityCommand::Uninstall { package }
                if !installed
                    .values()
                    .any(|installed| installed.digest == package.digest) =>
            {
                Some(package.digest.clone())
            }
            _ => None,
        };
        state.installed = installed;
        state.enabled = enabled;
        state.granted = granted;
        state.revoked = revoked;
        state.active = active;
        state.activation = activation;
        state.receipts = receipts;
        drop(state);

        self.publish(result_revision, activation_generation);
        self.wait_for_drain(drained)?;
        if let Some(digest) = removed_object {
            let _ = self.inner.store.remove_object(&digest);
        }
        Ok(PluginAuthorityCommandResult {
            revision: result_revision,
            activation_generation,
            disposition: PluginAuthorityDisposition::Updated,
        })
    }

    /// Creates an exact dispatch fence for one package in the current active snapshot.
    pub fn invocation_fence(
        &self,
        package: &InstalledPluginPackage,
    ) -> Option<PluginInvocationFence> {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = state.active.get(&package.manifest().id)?;
        if active.package.digest != *package.package_digest() {
            return None;
        }
        Some(PluginInvocationFence {
            authority: self.clone(),
            key: InvocationKey {
                plugin_id: active.package.id.clone(),
                package_digest: active.package.digest.clone(),
                activation_revision: active.activation_revision,
            },
        })
    }

    fn publish(&self, revision: u64, activation_generation: u64) {
        self.inner
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|subscriber| {
                subscriber
                    .send(PluginAuthorityChange {
                        revision,
                        activation_generation,
                    })
                    .is_ok()
            });
    }

    fn wait_for_drain(&self, drained: Vec<InvocationKey>) -> Result<(), PluginError> {
        if drained.is_empty() {
            return Ok(());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| authority_unavailable("Plugin authority lock is unavailable"))?;
        while drained
            .iter()
            .any(|key| state.in_flight.get(key).copied().unwrap_or(0) != 0)
        {
            state = self
                .inner
                .drained
                .wait(state)
                .map_err(|_| authority_unavailable("Plugin invocation drain is unavailable"))?;
        }
        Ok(())
    }

    fn authorizes(&self, key: &InvocationKey) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active_matches(&state.active, key)
    }

    fn acquire(&self, key: &InvocationKey) -> Option<PluginInvocationLease> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !active_matches(&state.active, key) {
            return None;
        }
        *state.in_flight.entry(key.clone()).or_default() += 1;
        Some(PluginInvocationLease {
            authority: self.clone(),
            key: Some(key.clone()),
        })
    }

    fn release(&self, key: &InvocationKey) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let remove = match state.in_flight.get_mut(key) {
            Some(count) => {
                *count -= 1;
                *count == 0
            }
            None => false,
        };
        if remove {
            state.in_flight.remove(key);
            self.inner.drained.notify_all();
        }
    }
}

/// Exact Plugin activation facts attached to one prepared runtime contribution.
#[derive(Clone)]
pub struct PluginInvocationFence {
    authority: PluginActivationAuthority,
    key: InvocationKey,
}

impl PluginInvocationFence {
    pub fn authorizes(&self) -> bool {
        self.authority.authorizes(&self.key)
    }

    /// Acquires a lease that keeps a committed disable/update waiting until dispatch completes.
    pub fn acquire(&self) -> Option<PluginInvocationLease> {
        self.authority.acquire(&self.key)
    }
}

/// RAII lease for one invocation admitted by exact live Plugin authority.
#[must_use = "dropping the lease releases the Plugin invocation"]
pub struct PluginInvocationLease {
    authority: PluginActivationAuthority,
    key: Option<InvocationKey>,
}

impl Drop for PluginInvocationLease {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.authority.release(&key);
        }
    }
}

/// Blocking subscription to consumer-visible Plugin activation generations.
pub struct PluginAuthoritySubscription {
    receiver: mpsc::Receiver<PluginAuthorityChange>,
}

/// Committed authority revision and the effective runtime generation it resolved to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PluginAuthorityChange {
    pub revision: u64,
    pub activation_generation: u64,
}

impl PluginAuthoritySubscription {
    pub fn try_recv(&self) -> Result<PluginAuthorityChange, mpsc::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<PluginAuthorityChange, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

fn apply_command(
    store: &PluginPackageStore,
    installed: &mut BTreeMap<InstalledKey, InstalledPluginRef>,
    enabled: &mut BTreeMap<PluginPackageId, InstalledPluginRef>,
    granted: &mut BTreeMap<InstalledKey, InstalledPluginRef>,
    revoked: &mut BTreeMap<InstalledKey, InstalledPluginRef>,
    command: &PluginAuthorityCommand,
) -> Result<(), PluginError> {
    match command {
        PluginAuthorityCommand::Install { package } => {
            store.read(package)?;
            let key = InstalledKey::from_package(package);
            if revoked.get(&key) == Some(package) {
                return Err(authority_error(
                    PluginErrorKind::PackageRevoked,
                    "revoked Plugin package cannot be installed",
                ));
            }
            if let Some(existing) = installed.get(&key)
                && existing != package
            {
                return Err(authority_error(
                    PluginErrorKind::PackageConflict,
                    "one Plugin version cannot refer to multiple package digests",
                ));
            }
            installed.insert(key, package.clone());
        }
        PluginAuthorityCommand::Enable { package } => {
            let key = InstalledKey::from_package(package);
            if revoked.get(&key) == Some(package) {
                return Err(authority_error(
                    PluginErrorKind::PackageRevoked,
                    "revoked Plugin package cannot be enabled",
                ));
            }
            if installed.get(&key) != Some(package) {
                return Err(authority_error(
                    PluginErrorKind::SourceUnavailable,
                    "Plugin enable targets an uninstalled package",
                ));
            }
            store.activate(package)?;
            enabled.insert(package.id.clone(), package.clone());
        }
        PluginAuthorityCommand::Disable { package } => {
            if enabled.get(&package.id) != Some(package) {
                return Err(authority_error(
                    PluginErrorKind::SourceUnavailable,
                    "Plugin disable targets a package that is not enabled",
                ));
            }
            enabled.remove(&package.id);
        }
        PluginAuthorityCommand::Grant { package } => {
            let key = InstalledKey::from_package(package);
            if revoked.get(&key) == Some(package) {
                return Err(authority_error(
                    PluginErrorKind::PackageRevoked,
                    "revoked Plugin package cannot be granted",
                ));
            }
            if installed.get(&key) != Some(package) {
                return Err(authority_error(
                    PluginErrorKind::SourceUnavailable,
                    "Plugin grant targets an uninstalled package",
                ));
            }
            store.activate(package)?;
            granted.insert(key, package.clone());
        }
        PluginAuthorityCommand::RevokeGrant { package } => {
            let key = InstalledKey::from_package(package);
            if granted.get(&key) != Some(package) {
                return Err(authority_error(
                    PluginErrorKind::SourceUnavailable,
                    "Plugin grant revocation targets a package that is not granted",
                ));
            }
            granted.remove(&key);
        }
        PluginAuthorityCommand::RevokePackage { package } => {
            let key = InstalledKey::from_package(package);
            if let Some(existing) = revoked.get(&key)
                && existing != package
            {
                return Err(authority_error(
                    PluginErrorKind::PackageConflict,
                    "one revoked Plugin version cannot refer to multiple package digests",
                ));
            }
            revoked.insert(key, package.clone());
        }
        PluginAuthorityCommand::RestorePackage { package } => {
            let key = InstalledKey::from_package(package);
            if revoked.get(&key) != Some(package) {
                return Err(authority_error(
                    PluginErrorKind::SourceUnavailable,
                    "Plugin restore targets a package that is not revoked",
                ));
            }
            revoked.remove(&key);
        }
        PluginAuthorityCommand::Uninstall { package } => {
            let key = InstalledKey::from_package(package);
            if installed.get(&key) != Some(package) {
                return Err(authority_error(
                    PluginErrorKind::SourceUnavailable,
                    "Plugin uninstall targets an uninstalled package",
                ));
            }
            if enabled.get(&package.id) == Some(package) || granted.get(&key) == Some(package) {
                return Err(authority_error(
                    PluginErrorKind::PackageInUse,
                    "enabled or granted Plugin package must be disabled and revoked before uninstall",
                ));
            }
            installed.remove(&key);
        }
    }
    Ok(())
}

fn effective_active(
    enabled: &BTreeMap<PluginPackageId, InstalledPluginRef>,
    granted: &BTreeMap<InstalledKey, InstalledPluginRef>,
    revoked: &BTreeMap<InstalledKey, InstalledPluginRef>,
) -> BTreeMap<PluginPackageId, ActivePlugin> {
    enabled
        .iter()
        .filter(|(_, package)| {
            let key = InstalledKey::from_package(package);
            granted.get(&key) == Some(*package) && revoked.get(&key) != Some(*package)
        })
        .map(|(id, package)| {
            (
                id.clone(),
                ActivePlugin {
                    package: package.clone(),
                    activation_revision: 0,
                },
            )
        })
        .collect()
}

fn same_active_packages(
    left: &BTreeMap<PluginPackageId, ActivePlugin>,
    right: &BTreeMap<PluginPackageId, ActivePlugin>,
) -> bool {
    left.len() == right.len()
        && left.iter().all(|(id, active)| {
            right
                .get(id)
                .is_some_and(|other| other.package == active.package)
        })
}

fn package_map_by_plugin(
    installed: &BTreeMap<InstalledKey, InstalledPluginRef>,
    packages: Vec<InstalledPluginRef>,
    label: &str,
) -> Result<BTreeMap<PluginPackageId, InstalledPluginRef>, PluginError> {
    let mut result = BTreeMap::new();
    for package in packages {
        if installed.get(&InstalledKey::from_package(&package)) != Some(&package)
            || result.insert(package.id.clone(), package).is_some()
        {
            return Err(authority_error(
                PluginErrorKind::PackageConflict,
                format!("Plugin authority {label} set does not match installed objects"),
            ));
        }
    }
    Ok(result)
}

fn package_map_by_key(
    installed: &BTreeMap<InstalledKey, InstalledPluginRef>,
    packages: Vec<InstalledPluginRef>,
    label: &str,
) -> Result<BTreeMap<InstalledKey, InstalledPluginRef>, PluginError> {
    let mut result = BTreeMap::new();
    for package in packages {
        let key = InstalledKey::from_package(&package);
        if installed.get(&key) != Some(&package) || result.insert(key, package).is_some() {
            return Err(authority_error(
                PluginErrorKind::PackageConflict,
                format!("Plugin authority {label} set does not match installed objects"),
            ));
        }
    }
    Ok(result)
}

fn package_tombstones(
    packages: Vec<InstalledPluginRef>,
    label: &str,
) -> Result<BTreeMap<InstalledKey, InstalledPluginRef>, PluginError> {
    let mut result = BTreeMap::new();
    for package in packages {
        let key = InstalledKey::from_package(&package);
        if let Some(existing) = result.insert(key, package.clone())
            && existing != package
        {
            return Err(authority_error(
                PluginErrorKind::PackageConflict,
                format!("Plugin authority {label} set contains conflicting package digests"),
            ));
        }
    }
    Ok(result)
}

fn same_active_set(
    left: &BTreeMap<PluginPackageId, ActivePlugin>,
    right: &BTreeMap<PluginPackageId, ActivePlugin>,
) -> bool {
    left.len() == right.len()
        && left.iter().all(|(id, package)| {
            right
                .get(id)
                .is_some_and(|other| package.package == other.package)
        })
}

fn stamp_changed_activations(
    previous: &BTreeMap<PluginPackageId, ActivePlugin>,
    next: &mut BTreeMap<PluginPackageId, ActivePlugin>,
    activation_generation: u64,
) {
    for (id, active) in next {
        active.activation_revision = previous
            .get(id)
            .filter(|previous| previous.package == active.package)
            .map(|previous| previous.activation_revision)
            .unwrap_or(activation_generation);
    }
}

fn revoked_invocations(
    previous: &BTreeMap<PluginPackageId, ActivePlugin>,
    next: &BTreeMap<PluginPackageId, ActivePlugin>,
) -> Vec<InvocationKey> {
    previous
        .iter()
        .filter(|(id, active)| {
            next.get(*id)
                .is_none_or(|next| next.package != active.package)
        })
        .map(|(_, active)| InvocationKey {
            plugin_id: active.package.id.clone(),
            package_digest: active.package.digest.clone(),
            activation_revision: active.activation_revision,
        })
        .collect()
}

fn active_matches(active: &BTreeMap<PluginPackageId, ActivePlugin>, key: &InvocationKey) -> bool {
    active.get(&key.plugin_id).is_some_and(|active| {
        active.package.digest == key.package_digest
            && active.activation_revision == key.activation_revision
    })
}

fn resolve_activation(
    generation: u64,
    store: &PluginPackageStore,
    active: &BTreeMap<PluginPackageId, ActivePlugin>,
) -> Result<PluginActivationSnapshot, PluginError> {
    PluginActivationSnapshot::resolve(
        generation,
        store,
        active.values().map(|active| active.package.clone()),
    )
}

fn command_digest(command: &PluginAuthorityCommand) -> Result<String, PluginError> {
    let bytes = serde_json::to_vec(command)
        .map_err(|_| authority_unavailable("Plugin command could not be encoded"))?;
    let digest = Sha256::digest(bytes);
    let mut value = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(value)
}

fn authority_unavailable(message: impl Into<String>) -> PluginError {
    authority_error(PluginErrorKind::AuthorityUnavailable, message)
}

fn authority_error(kind: PluginErrorKind, message: impl Into<String>) -> PluginError {
    PluginError::new(kind, message)
}

impl fmt::Debug for PluginActivationAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PluginActivationAuthority")
            .field("snapshot", &self.snapshot())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[path = "plugin_authority_tests.rs"]
mod tests;
