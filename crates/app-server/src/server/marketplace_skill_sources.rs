use std::sync::Arc;
use std::sync::Mutex;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::PluginsManager;
use ash_protocol::SkillName;
use ash_protocol::SkillSourceId;
use ash_skills::SkillSourceRoot;
use ash_skills_extension::DynamicSkillSourceProvider;
use ash_skills_extension::DynamicSkillSourceSnapshot;

/// Projects installed Marketplace Skill capabilities into the shared Skill runtime.
pub(super) struct MarketplaceSkillSourceProvider {
    manager: Arc<PluginsManager>,
    state: Mutex<ProjectionState>,
}

#[derive(Default)]
struct ProjectionState {
    fingerprint: Vec<String>,
    generation: u64,
}

impl MarketplaceSkillSourceProvider {
    pub(super) fn new(manager: Arc<PluginsManager>) -> Self {
        Self {
            manager,
            state: Mutex::new(ProjectionState::default()),
        }
    }
}

impl DynamicSkillSourceProvider for MarketplaceSkillSourceProvider {
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
                .map_err(|_| "Marketplace Skill projection lock poisoned".to_string())?;
            if state.fingerprint != fingerprint {
                state.fingerprint = fingerprint;
                state.generation = state.generation.checked_add(1).ok_or_else(|| {
                    "Marketplace Skill projection generation exhausted".to_string()
                })?;
            }
            state.generation.max(1)
        };
        let mut roots = Vec::new();
        for source in sources {
            let id = SkillSourceId::new(format!(
                "marketplace-{}:skill-source:{}",
                source.package().id,
                source.id()
            ))
            .map_err(|error| error.to_string())?;
            let name = SkillName::new(source.id()).map_err(|error| error.to_string())?;
            roots.push(
                SkillSourceRoot::marketplace(id, name, source.host_path())
                    .map_err(|error| error.to_string())?,
            );
        }
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
