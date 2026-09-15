use ash_config::ConfigChange;
use ash_config::SkillEnablement;
use ash_config::SkillSourceEnablement;
use ash_config::SkillsConfig;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::SessionId;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillId;
use ash_protocol::SkillRef;
use ash_protocol::UserInput;
use ash_skills::ActivatedSkill;
use ash_skills::SkillCatalog;
use ash_skills::SkillCatalogEntry;
use ash_skills::SkillCompatibility;
use ash_skills::SkillDiagnosticCode;
use ash_skills::SkillResource;
use ash_skills::SkillResourcePath;
use ash_skills::SkillSourceId;
use ash_skills::SkillSourceRoot;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

const BUILT_IN_SOURCE_ID: &str = "builtin:skill-source:ash-release";
const DIR_SOURCE_ID: &str = "dir:skill-source:.ash";

/// Supplies resolved Skill configuration to the shared Skill runtime.
///
/// Implementations must resolve configuration authority before returning and must not convert an
/// untrusted client path directly into a validated [`SkillSourceRoot`].
pub trait SkillConfigSnapshotProvider: Send + Sync {
    fn snapshot(&self) -> Result<SkillsConfig, String>;

    fn config_changes(&self) -> Option<std::sync::mpsc::Receiver<ConfigChange>> {
        None
    }
}

/// Supplies host-authorized dynamic Skill source roots.
///
/// Implementations must return roots that have already passed the owning domain's authority and
/// containment checks. The monotonically meaningful generation participates in runtime source
/// replacement; implementations must not expose arbitrary client-provided paths.
pub trait DynamicSkillSourceProvider: Send + Sync {
    fn snapshot(&self) -> Result<DynamicSkillSourceSnapshot, String>;
}

/// Supplies Session-authorized session-dir Skill roots.
pub trait SessionSkillSourceProvider: Send + Sync {
    fn snapshot(&self, session_id: &SessionId) -> Result<DynamicSkillSourceSnapshot, String>;
}

/// One immutable generation of host-authorized dynamic Skill sources.
pub struct DynamicSkillSourceSnapshot {
    pub generation: u64,
    pub roots: Vec<SkillSourceRoot>,
}

/// Receives generation changes without coupling the Skill runtime to a transport or product host.
pub trait SkillRuntimeEventSink: Send + Sync {
    fn skills_changed(&self, generation: u64);
}

#[cfg(test)]
pub(crate) struct NoSkillRuntimeEvents;

#[cfg(test)]
impl SkillRuntimeEventSink for NoSkillRuntimeEvents {
    fn skills_changed(&self, _: u64) {}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillCatalogReload {
    Cached,
    Refresh,
}

pub enum BuiltInSkillSource {
    Root(PathBuf),
    Missing,
    Omitted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillRuntimeEntry {
    pub catalog_entry: SkillCatalogEntry,
    pub enablement: SkillEnablement,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillRuntimeDiagnostic {
    pub source: String,
    pub subject: Option<String>,
    pub code: SkillDiagnosticCode,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillRuntimeSnapshot {
    pub generation: u64,
    pub entries: Vec<SkillRuntimeEntry>,
    pub diagnostics: Vec<SkillRuntimeDiagnostic>,
}

pub struct SkillRuntime {
    built_in_source: BuiltInSkillSource,
    dynamic_sources: Mutex<Option<Arc<dyn DynamicSkillSourceProvider>>>,
    session_sources: Mutex<Option<Arc<dyn SessionSkillSourceProvider>>>,
    pub(crate) config: Arc<dyn SkillConfigSnapshotProvider>,
    pub(crate) dir_root: Mutex<Option<PathBuf>>,
    pub(crate) state: Mutex<SkillRuntimeState>,
    events: Arc<dyn SkillRuntimeEventSink>,
}

pub(crate) struct SkillRuntimeState {
    pub(crate) source_fingerprint: Vec<SourceFingerprint>,
    catalog: SkillCatalog,
    snapshot: Arc<SkillRuntimeSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SourceFingerprint {
    id: SkillSourceId,
    pub(crate) root: PathBuf,
    generation: u64,
}

struct SourceComposition {
    fingerprint: Vec<SourceFingerprint>,
    roots: Vec<SkillSourceRoot>,
    diagnostics: Vec<SkillRuntimeDiagnostic>,
}

#[derive(Clone, Copy)]
enum SourceKind {
    BuiltIn,
    User,
    Directory,
}

impl SkillRuntime {
    pub fn new(
        built_in_source: BuiltInSkillSource,
        config: Arc<dyn SkillConfigSnapshotProvider>,
        events: Arc<dyn SkillRuntimeEventSink>,
    ) -> Result<Arc<Self>, String> {
        Self::with_dynamic_sources(built_in_source, config, events, None)
    }

    pub fn with_dynamic_sources(
        built_in_source: BuiltInSkillSource,
        config: Arc<dyn SkillConfigSnapshotProvider>,
        events: Arc<dyn SkillRuntimeEventSink>,
        dynamic_sources: Option<Arc<dyn DynamicSkillSourceProvider>>,
    ) -> Result<Arc<Self>, String> {
        let skills_config = config.snapshot()?;
        let dynamic_snapshot = dynamic_sources
            .as_ref()
            .map(|provider| provider.snapshot())
            .transpose()?;
        let composition =
            compose_sources(&built_in_source, &skills_config, None, dynamic_snapshot)?;
        let catalog = SkillCatalog::discover(composition.roots)
            .map_err(|error| format!("failed to discover Skill catalog: {error}"))?;
        let snapshot = Arc::new(project_snapshot(
            1,
            catalog.snapshot().as_ref(),
            &skills_config,
            composition.diagnostics,
        ));
        Ok(Arc::new(Self {
            built_in_source,
            dynamic_sources: Mutex::new(dynamic_sources),
            session_sources: Mutex::new(None),
            config,
            dir_root: Mutex::new(None),
            state: Mutex::new(SkillRuntimeState {
                source_fingerprint: composition.fingerprint,
                catalog,
                snapshot,
            }),
            events,
        }))
    }

    pub fn list(&self, reload: SkillCatalogReload) -> Result<Arc<SkillRuntimeSnapshot>, String> {
        self.reconcile(reload)
    }

    pub fn list_for_session(
        &self,
        session_id: &SessionId,
    ) -> Result<Arc<SkillRuntimeSnapshot>, String> {
        self.session_catalog(session_id)
            .map(|(_, snapshot)| snapshot)
    }

    pub fn bind_session_sources(
        &self,
        provider: Arc<dyn SessionSkillSourceProvider>,
    ) -> Result<(), String> {
        *self
            .session_sources
            .lock()
            .map_err(|_| "Session Skill source lock poisoned".to_string())? = Some(provider);
        Ok(())
    }

    /// Replaces host-authorized dynamic sources and publishes their visible projection.
    pub fn bind_dynamic_sources(
        &self,
        provider: Arc<dyn DynamicSkillSourceProvider>,
    ) -> Result<Arc<SkillRuntimeSnapshot>, String> {
        *self
            .dynamic_sources
            .lock()
            .map_err(|_| "Dynamic Skill source lock poisoned".to_string())? = Some(provider);
        self.reconcile(SkillCatalogReload::Refresh)
    }

    pub fn activate_explicit(&self, selected: &SkillRef) -> Result<ActivatedSkill, String> {
        self.activate_available(selected, SkillActivationReason::Explicit)
    }

    pub fn activate_explicit_for_session(
        &self,
        session_id: &SessionId,
        selected: &SkillRef,
    ) -> Result<ActivatedSkill, String> {
        self.activate_session_available(session_id, selected, SkillActivationReason::Explicit)
    }

    pub(crate) fn activate_model_selected(
        &self,
        selected: &SkillRef,
    ) -> Result<ActivatedSkill, String> {
        self.activate_available(selected, SkillActivationReason::Automatic)
    }

    pub(crate) fn activate_model_selected_for_session(
        &self,
        session_id: &SessionId,
        selected: &SkillRef,
    ) -> Result<ActivatedSkill, String> {
        self.activate_session_available(session_id, selected, SkillActivationReason::Automatic)
    }

    pub(crate) fn select_automatic(
        &self,
        input: &[UserInput],
        excluded: &[SkillId],
    ) -> Result<Option<ActivatedSkill>, String> {
        self.reconcile(SkillCatalogReload::Refresh)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Skill runtime lock poisoned".to_string())?;
        let Some(selected) = crate::selector::select(&state.snapshot, input, excluded) else {
            return Ok(None);
        };
        state
            .catalog
            .activate(&selected, SkillActivationReason::Automatic)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn select_automatic_for_session(
        &self,
        session_id: &SessionId,
        input: &[UserInput],
        excluded: &[SkillId],
    ) -> Result<Option<ActivatedSkill>, String> {
        let (catalog, snapshot) = self.session_catalog(session_id)?;
        let Some(selected) = crate::selector::select(snapshot.as_ref(), input, excluded) else {
            return Ok(None);
        };
        catalog
            .activate(&selected, SkillActivationReason::Automatic)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    /// Reads one inert package resource from an enabled, compatible Skill pinned to an exact
    /// `SKILL.md` digest.
    ///
    /// Hosts may materialize the returned bytes into their ordinary resource store. This method
    /// never infers a media type, executes scripts, or grants write/publish authority.
    pub fn read_resource(
        &self,
        selected: &SkillRef,
        path: &SkillResourcePath,
    ) -> Result<SkillResource, String> {
        self.reconcile(SkillCatalogReload::Refresh)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Skill runtime lock poisoned".to_string())?;
        let entry = state
            .snapshot
            .entries
            .iter()
            .find(|entry| entry.catalog_entry.id() == &selected.id)
            .ok_or_else(|| format!("Skill '{}' is not available", selected.id.name))?;
        if entry.enablement != SkillEnablement::Enabled {
            return Err(format!("Skill '{}' is disabled", selected.id.name));
        }
        if !matches!(
            entry.catalog_entry.compatibility(),
            SkillCompatibility::Compatible
        ) {
            return Err(format!("Skill '{}' is not compatible", selected.id.name));
        }
        state
            .catalog
            .read_resource(selected, path)
            .map_err(|error| error.to_string())
    }

    pub fn read_resource_for_session(
        &self,
        session_id: &SessionId,
        selected: &SkillRef,
        path: &SkillResourcePath,
    ) -> Result<SkillResource, String> {
        let (catalog, snapshot) = self.session_catalog(session_id)?;
        require_available(snapshot.as_ref(), selected)?;
        catalog
            .read_resource(selected, path)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn read_model_resource(
        &self,
        selected: &SkillRef,
        path: &SkillResourcePath,
    ) -> Result<SkillResource, String> {
        self.read_resource(selected, path)
    }

    fn activate_available(
        &self,
        selected: &SkillRef,
        reason: SkillActivationReason,
    ) -> Result<ActivatedSkill, String> {
        self.reconcile(SkillCatalogReload::Refresh)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Skill runtime lock poisoned".to_string())?;
        let entry = state
            .snapshot
            .entries
            .iter()
            .find(|entry| entry.catalog_entry.id() == &selected.id)
            .ok_or_else(|| format!("Skill '{}' is not available", selected.id.name))?;
        if entry.enablement != SkillEnablement::Enabled {
            return Err(format!("Skill '{}' is disabled", selected.id.name));
        }
        if !matches!(
            entry.catalog_entry.compatibility(),
            SkillCompatibility::Compatible
        ) {
            return Err(format!("Skill '{}' is not compatible", selected.id.name));
        }
        state
            .catalog
            .activate(selected, reason)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn load_frozen(
        &self,
        frozen: &FrozenSkillActivation,
    ) -> Result<ActivatedSkill, String> {
        self.reconcile(SkillCatalogReload::Refresh)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Skill runtime lock poisoned".to_string())?;
        state
            .catalog
            .activate(
                &SkillRef::pinned(frozen.id.clone(), frozen.content_digest.clone()),
                frozen.reason,
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn load_frozen_for_session(
        &self,
        session_id: &SessionId,
        frozen: &FrozenSkillActivation,
    ) -> Result<ActivatedSkill, String> {
        let (catalog, _) = self.session_catalog(session_id)?;
        catalog
            .activate(
                &SkillRef::pinned(frozen.id.clone(), frozen.content_digest.clone()),
                frozen.reason,
            )
            .map_err(|error| error.to_string())
    }

    fn activate_session_available(
        &self,
        session_id: &SessionId,
        selected: &SkillRef,
        reason: SkillActivationReason,
    ) -> Result<ActivatedSkill, String> {
        let (catalog, snapshot) = self.session_catalog(session_id)?;
        require_available(snapshot.as_ref(), selected)?;
        catalog
            .activate(selected, reason)
            .map_err(|error| error.to_string())
    }

    fn session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<(SkillCatalog, Arc<SkillRuntimeSnapshot>), String> {
        let provider = self
            .session_sources
            .lock()
            .map_err(|_| "Session Skill source lock poisoned".to_string())?
            .clone();
        let config = self.config.snapshot()?;
        let dir_root = self
            .dir_root
            .lock()
            .map_err(|_| "Directory Skill source lock poisoned".to_string())?
            .clone();
        let mut composition = compose_sources(
            &self.built_in_source,
            &config,
            dir_root.as_deref(),
            self.dynamic_sources
                .lock()
                .map_err(|_| "Dynamic Skill source lock poisoned".to_string())?
                .as_ref()
                .map(|provider| provider.snapshot())
                .transpose()?,
        )?;
        let session = provider
            .map(|provider| provider.snapshot(session_id))
            .transpose()?
            .unwrap_or(DynamicSkillSourceSnapshot {
                generation: 1,
                roots: Vec::new(),
            });
        for root in session.roots {
            composition.fingerprint.push(SourceFingerprint {
                id: root.view().id().clone(),
                root: root.host_root().to_path_buf(),
                generation: session.generation,
            });
            composition.roots.push(root);
        }
        composition
            .fingerprint
            .sort_by(|left, right| left.id.cmp(&right.id));
        let catalog = SkillCatalog::discover(composition.roots)
            .map_err(|error| format!("failed to discover Session Skill catalog: {error}"))?;
        let snapshot = Arc::new(project_snapshot(
            session.generation.max(1),
            catalog.snapshot().as_ref(),
            &config,
            composition.diagnostics,
        ));
        Ok((catalog, snapshot))
    }

    pub(crate) fn watched_paths(&self) -> Vec<PathBuf> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut paths = state
            .source_fingerprint
            .iter()
            .map(|source| source.root.clone())
            .collect::<Vec<_>>();
        drop(state);
        if let Some(dir_root) = self
            .dir_root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            let metadata_root = dir_root.join(".ash");
            paths.push(if metadata_root.is_dir() {
                metadata_root
            } else {
                dir_root.clone()
            });
        }
        paths.sort();
        paths.dedup();
        paths
    }

    /// Rebinds the native `.ash/skills` source for the active directory.
    pub fn bind_dir_root(&self, dir_root: PathBuf) -> Result<Arc<SkillRuntimeSnapshot>, String> {
        let previous = {
            let mut current = self
                .dir_root
                .lock()
                .map_err(|_| "Directory Skill source lock poisoned".to_string())?;
            current.replace(dir_root)
        };
        match self.reconcile(SkillCatalogReload::Refresh) {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                *self
                    .dir_root
                    .lock()
                    .map_err(|_| "Directory Skill source lock poisoned".to_string())? = previous;
                Err(error)
            }
        }
    }

    fn reconcile(&self, reload: SkillCatalogReload) -> Result<Arc<SkillRuntimeSnapshot>, String> {
        let skills_config = self.config.snapshot()?;
        let dir_root = self
            .dir_root
            .lock()
            .map_err(|_| "Directory Skill source lock poisoned".to_string())?
            .clone();
        let composition = compose_sources(
            &self.built_in_source,
            &skills_config,
            dir_root.as_deref(),
            self.dynamic_sources
                .lock()
                .map_err(|_| "Dynamic Skill source lock poisoned".to_string())?
                .as_ref()
                .map(|provider| provider.snapshot())
                .transpose()?,
        )?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let catalog_snapshot = if state.source_fingerprint != composition.fingerprint {
            state.catalog = SkillCatalog::discover(composition.roots)
                .map_err(|error| format!("failed to rebuild Skill catalog: {error}"))?;
            state.source_fingerprint = composition.fingerprint;
            state.catalog.snapshot()
        } else {
            match reload {
                SkillCatalogReload::Cached => state.catalog.snapshot(),
                SkillCatalogReload::Refresh => state.catalog.refresh(),
            }
        };
        let next = project_snapshot(
            state
                .snapshot
                .generation
                .checked_add(1)
                .expect("Skill runtime generation overflowed"),
            catalog_snapshot.as_ref(),
            &skills_config,
            composition.diagnostics,
        );
        if same_projection(state.snapshot.as_ref(), &next) {
            return Ok(Arc::clone(&state.snapshot));
        }
        state.snapshot = Arc::new(next);
        let snapshot = Arc::clone(&state.snapshot);
        drop(state);
        self.events.skills_changed(snapshot.generation);
        Ok(snapshot)
    }
}

fn compose_sources(
    built_in_source: &BuiltInSkillSource,
    config: &SkillsConfig,
    dir_root: Option<&Path>,
    dynamic_sources: Option<DynamicSkillSourceSnapshot>,
) -> Result<SourceComposition, String> {
    let mut fingerprint = Vec::new();
    let mut roots = Vec::new();
    let mut diagnostics = Vec::new();
    let built_in_id = SkillSourceId::new(BUILT_IN_SOURCE_ID)
        .expect("the repository built-in Skill source ID is valid");
    let dir_id =
        SkillSourceId::new(DIR_SOURCE_ID).expect("the native Directory Skill source ID is valid");
    match built_in_source {
        BuiltInSkillSource::Root(root) => add_source(
            built_in_id.clone(),
            root.clone(),
            SourceKind::BuiltIn,
            &mut fingerprint,
            &mut roots,
            &mut diagnostics,
        ),
        BuiltInSkillSource::Missing => diagnostics.push(source_unavailable_diagnostic(
            &built_in_id,
            "the bundled Skill directory could not be located",
        )),
        BuiltInSkillSource::Omitted => {}
    }
    for source in config
        .sources
        .values()
        .filter(|source| source.enablement == SkillSourceEnablement::Enabled)
    {
        if source.id == built_in_id || source.id == dir_id {
            diagnostics.push(source_unavailable_diagnostic(
                &source.id,
                "native Skill source identities cannot be registered as user sources",
            ));
            continue;
        }
        let root = PathBuf::from(&source.root_reference);
        if !root.is_absolute() {
            diagnostics.push(source_unavailable_diagnostic(
                &source.id,
                "local Skill source root reference must be an absolute path",
            ));
            continue;
        }
        add_source(
            source.id.clone(),
            root,
            SourceKind::User,
            &mut fingerprint,
            &mut roots,
            &mut diagnostics,
        );
    }
    if let Some(dynamic) = dynamic_sources {
        for root in dynamic.roots {
            let id = root.view().id().clone();
            let canonical_root = root.host_root().to_path_buf();
            fingerprint.push(SourceFingerprint {
                id,
                root: canonical_root,
                generation: dynamic.generation,
            });
            roots.push(root);
        }
    }
    if let Some(dir_root) = dir_root {
        let root = dir_root.join(".ash/skills");
        match std::fs::symlink_metadata(&root) {
            Ok(_) => add_source(
                dir_id.clone(),
                root,
                SourceKind::Directory,
                &mut fingerprint,
                &mut roots,
                &mut diagnostics,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => diagnostics.push(source_unavailable_diagnostic(
                &dir_id,
                "the native Directory Skill source cannot be inspected",
            )),
        }
    }
    fingerprint.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(SourceComposition {
        fingerprint,
        roots,
        diagnostics,
    })
}

fn add_source(
    id: SkillSourceId,
    root: PathBuf,
    kind: SourceKind,
    fingerprint: &mut Vec<SourceFingerprint>,
    roots: &mut Vec<SkillSourceRoot>,
    diagnostics: &mut Vec<SkillRuntimeDiagnostic>,
) {
    let source = match kind {
        SourceKind::BuiltIn => SkillSourceRoot::built_in(id.clone(), &root),
        SourceKind::User => SkillSourceRoot::user(id.clone(), &root),
        SourceKind::Directory => SkillSourceRoot::directory(id.clone(), &root),
    };
    match source {
        Ok(source) => {
            fingerprint.push(SourceFingerprint {
                id,
                root,
                generation: 0,
            });
            roots.push(source);
        }
        Err(error) => diagnostics.push(source_unavailable_diagnostic(&id, &error.to_string())),
    }
}

fn project_snapshot(
    generation: u64,
    catalog: &ash_skills::SkillCatalogSnapshot,
    config: &SkillsConfig,
    mut runtime_diagnostics: Vec<SkillRuntimeDiagnostic>,
) -> SkillRuntimeSnapshot {
    let entries = catalog
        .list()
        .iter()
        .cloned()
        .map(|catalog_entry| SkillRuntimeEntry {
            enablement: config.skill_enablement(catalog_entry.id()),
            catalog_entry,
        })
        .collect();
    runtime_diagnostics.extend(catalog.diagnostics().iter().map(|diagnostic| {
        SkillRuntimeDiagnostic {
            source: diagnostic.source().to_string(),
            subject: diagnostic.subject().map(str::to_owned),
            code: diagnostic.code(),
            message: diagnostic.message().to_owned(),
        }
    }));
    runtime_diagnostics.sort_by(|left, right| {
        (&left.source, &left.subject, left.code, &left.message).cmp(&(
            &right.source,
            &right.subject,
            right.code,
            &right.message,
        ))
    });
    runtime_diagnostics.dedup();
    SkillRuntimeSnapshot {
        generation,
        entries,
        diagnostics: runtime_diagnostics,
    }
}

fn same_projection(current: &SkillRuntimeSnapshot, next: &SkillRuntimeSnapshot) -> bool {
    current.entries == next.entries && current.diagnostics == next.diagnostics
}

fn require_available(snapshot: &SkillRuntimeSnapshot, selected: &SkillRef) -> Result<(), String> {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.catalog_entry.id() == &selected.id)
        .ok_or_else(|| format!("Skill '{}' is not available", selected.id.name))?;
    if entry.enablement != SkillEnablement::Enabled {
        return Err(format!("Skill '{}' is disabled", selected.id.name));
    }
    if !matches!(
        entry.catalog_entry.compatibility(),
        SkillCompatibility::Compatible
    ) {
        return Err(format!("Skill '{}' is not compatible", selected.id.name));
    }
    Ok(())
}

fn source_unavailable_diagnostic(source: &SkillSourceId, message: &str) -> SkillRuntimeDiagnostic {
    SkillRuntimeDiagnostic {
        source: source.to_string(),
        subject: None,
        code: SkillDiagnosticCode::SourceUnavailable,
        message: message.to_owned(),
    }
}
