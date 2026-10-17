use std::sync::Arc;
use std::sync::Mutex;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::ExtensionPackageManager;
use ash_skills::SkillSourceRoot;
use ash_skills_extension::DynamicSkillSourceProvider;
use ash_skills_extension::DynamicSkillSourceSnapshot;

/// Projects installed Extensions Skill capabilities into the shared Skill runtime.
pub(super) struct ExtensionsSkillSourceProvider {
    manager: Arc<ExtensionPackageManager>,
    state: Mutex<ProjectionState>,
}

#[derive(Default)]
struct ProjectionState {
    fingerprint: Vec<String>,
    generation: u64,
}

impl ExtensionsSkillSourceProvider {
    pub(super) fn new(manager: Arc<ExtensionPackageManager>) -> Self {
        Self {
            manager,
            state: Mutex::new(ProjectionState::default()),
        }
    }
}

impl DynamicSkillSourceProvider for ExtensionsSkillSourceProvider {
    fn snapshot(&self) -> Result<DynamicSkillSourceSnapshot, String> {
        let sources = self
            .manager
            .local_capability_sources(CapabilityKind::Skill)
            .map_err(|error| error.to_string())?;
        let fingerprint = sources
            .iter()
            .map(|source| {
                format!(
                    "{}\0{}\0{}\0{}",
                    source.package().id,
                    source.package().version,
                    source.package().digest,
                    source.capability().id
                )
            })
            .collect::<Vec<_>>();
        let generation = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Extensions Skill projection lock poisoned".to_string())?;
            if state.fingerprint != fingerprint {
                state.fingerprint = fingerprint;
                state.generation = state.generation.checked_add(1).ok_or_else(|| {
                    "Extensions Skill projection generation exhausted".to_string()
                })?;
            }
            state.generation.max(1)
        };
        let roots = sources
            .iter()
            .filter_map(|source| source.skill_root())
            .map(SkillSourceRoot::from_plugin)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(DynamicSkillSourceSnapshot { generation, roots })
    }
}

/// Keeps independently owned dynamic Skill authorities composable.
pub(super) struct CombinedSkillSourceProvider {
    providers: Vec<Arc<dyn DynamicSkillSourceProvider>>,
    state: Mutex<ProjectionState>,
}

impl CombinedSkillSourceProvider {
    pub(super) fn new(providers: Vec<Arc<dyn DynamicSkillSourceProvider>>) -> Self {
        Self {
            providers,
            state: Mutex::new(ProjectionState::default()),
        }
    }
}

impl DynamicSkillSourceProvider for CombinedSkillSourceProvider {
    fn snapshot(&self) -> Result<DynamicSkillSourceSnapshot, String> {
        let mut roots = Vec::new();
        let mut fingerprint = Vec::new();
        for provider in &self.providers {
            let snapshot = provider.snapshot()?;
            fingerprint.push(snapshot.generation.to_string());
            for root in snapshot.roots {
                fingerprint.push(format!(
                    "{}\0{}",
                    root.view().id(),
                    root.host_root().display()
                ));
                roots.push(root);
            }
        }
        let generation = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "combined Skill projection lock poisoned".to_string())?;
            if state.fingerprint != fingerprint {
                state.fingerprint = fingerprint;
                state.generation = state
                    .generation
                    .checked_add(1)
                    .ok_or_else(|| "combined Skill projection generation exhausted".to_string())?;
            }
            state.generation.max(1)
        };
        Ok(DynamicSkillSourceSnapshot { generation, roots })
    }
}
