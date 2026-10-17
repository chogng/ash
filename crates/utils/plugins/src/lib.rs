//! Shared plugin identities, package discovery, contribution naming and plaintext mention syntax.
//!
//! Package owners supply verified roots and declarations. These helpers neither install packages
//! nor grant execution; consumers retain their own content validation and runtime policy.

pub mod mcp_connector;
pub mod mention_syntax;
mod package_id;
mod plugin_id;
pub mod plugin_namespace;

pub use package_id::InvalidPluginPackageId;
pub use package_id::PluginPackageId;
pub use plugin_id::ExtensionSourceId;
pub use plugin_id::InvalidPluginId;
pub use plugin_id::PluginId;

use std::path::PathBuf;

/// Package provenance retained when a plugin contribution enters the Skill runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginSkillSource {
    LocalPlugin,
    Extensions,
}

/// One exact manifest-declared Skill directory supplied by its owning package authority.
///
/// This is a local composition contract, not a transport DTO or a filesystem authorization.
/// IDs and paths have already been normalized by the package owner; the Skill consumer validates
/// the directory and Skill content before use. No recursive discovery is implied by this root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginSkillRoot {
    pub path: PathBuf,
    pub source: PluginSkillSource,
    pub plugin_id: String,
    pub skill_name: String,
}

impl PluginSkillRoot {
    /// Keeps historical source IDs stable across package versions and activation generations.
    pub fn source_id(&self) -> String {
        let prefix = match self.source {
            PluginSkillSource::LocalPlugin => "plugin",
            PluginSkillSource::Extensions => "extension_packages",
        };
        format!(
            "{prefix}-{}:skill-source:{}",
            self.plugin_id, self.skill_name
        )
    }
}
