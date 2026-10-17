use ash_utils_plugins::PluginSkillRoot;
use ash_utils_plugins::PluginSkillSource;
use std::collections::BTreeSet;

use crate::InstalledPluginPackage;
use crate::InstalledPluginRef;
use crate::PluginError;
use crate::PluginErrorKind;
use crate::PluginPackageStore;

/// Immutable exact-package set published to Plugin contribution consumers.
#[derive(Clone, Debug)]
pub struct PluginActivationSnapshot {
    generation: u64,
    packages: Vec<InstalledPluginPackage>,
}

impl PluginActivationSnapshot {
    /// Creates one valid activation generation with no selected Plugin packages.
    pub fn empty(generation: u64) -> Result<Self, PluginError> {
        if generation == 0 {
            return Err(PluginError::new(
                PluginErrorKind::PackageConflict,
                "Plugin activation generation must be non-zero",
            ));
        }
        Ok(Self {
            generation,
            packages: Vec::new(),
        })
    }

    /// Resolves one activation generation from exact installed package references.
    pub fn resolve(
        generation: u64,
        store: &PluginPackageStore,
        installed: impl IntoIterator<Item = InstalledPluginRef>,
    ) -> Result<Self, PluginError> {
        if generation == 0 {
            return Err(PluginError::new(
                PluginErrorKind::PackageConflict,
                "Plugin activation generation must be non-zero",
            ));
        }
        let mut packages = installed
            .into_iter()
            .map(|reference| store.activate(&reference))
            .collect::<Result<Vec<_>, _>>()?;
        packages.sort_by(|left, right| {
            left.manifest()
                .id
                .cmp(&right.manifest().id)
                .then_with(|| left.manifest().version.cmp(&right.manifest().version))
        });
        let mut active_ids = BTreeSet::new();
        for package in &packages {
            if !active_ids.insert(package.manifest().id.clone()) {
                return Err(PluginError::new(
                    PluginErrorKind::PackageConflict,
                    "Plugin activation contains multiple active versions of one Plugin",
                ));
            }
        }
        Ok(Self {
            generation,
            packages,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn packages(&self) -> &[InstalledPluginPackage] {
        &self.packages
    }

    /// Resolves only declared Skills from the exact effective package set.
    ///
    /// Keeping manifest traversal here lets runtime composition consume the shared descriptor
    /// without learning package layout or bypassing immutable-object containment checks.
    pub fn skill_roots(&self) -> Result<Vec<PluginSkillRoot>, PluginError> {
        let mut roots = Vec::new();
        for package in &self.packages {
            for contribution in &package.manifest().contributions.skills {
                roots.push(PluginSkillRoot {
                    path: package.resolve_directory(&contribution.path)?,
                    source: PluginSkillSource::LocalPlugin,
                    plugin_id: package.manifest().id.to_string(),
                    skill_name: contribution.id.to_string(),
                });
            }
        }
        Ok(roots)
    }
}

#[cfg(test)]
#[path = "plugin_activation_tests.rs"]
mod tests;
