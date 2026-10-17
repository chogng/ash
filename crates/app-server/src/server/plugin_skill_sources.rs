use ash_core_plugins::PluginActivationAuthority;
use ash_skills::SkillSourceRoot;
use ash_skills_extension::DynamicSkillSourceProvider;
use ash_skills_extension::DynamicSkillSourceSnapshot;

/// Projects exact effective Plugin Skill contributions into the shared Skill runtime.
pub(super) struct PluginSkillSourceProvider {
    authority: PluginActivationAuthority,
}

impl PluginSkillSourceProvider {
    pub(super) fn new(authority: PluginActivationAuthority) -> Self {
        Self { authority }
    }
}

impl DynamicSkillSourceProvider for PluginSkillSourceProvider {
    fn snapshot(&self) -> Result<DynamicSkillSourceSnapshot, String> {
        let activation = self.authority.snapshot().activation().clone();
        let roots = activation
            .skill_roots()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(SkillSourceRoot::from_plugin)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(DynamicSkillSourceSnapshot {
            generation: activation.generation(),
            roots,
        })
    }
}

#[cfg(test)]
#[path = "plugin_skill_sources_tests.rs"]
mod tests;
