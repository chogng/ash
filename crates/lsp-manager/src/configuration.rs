use std::path::{Path, PathBuf};

use crate::{LanguageServerDefinition, LanguageServerRestartPolicy};

/// Product policy controlling whether configured language servers may run.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LspManagerEnablement {
    /// Retain document snapshots without starting or contacting language servers.
    #[default]
    Disabled,
    /// Start the caller-resolved server definitions and synchronize matching documents.
    Enabled,
}

/// Immutable product configuration consumed by one language-service supervisor.
#[derive(Clone, Debug)]
pub struct LspManagerConfiguration {
    pub(crate) dir_root: PathBuf,
    pub(crate) enablement: LspManagerEnablement,
    pub(crate) servers: Vec<LanguageServerDefinition>,
    pub(crate) restart_policy: LanguageServerRestartPolicy,
    pub(crate) generation: u64,
}

impl LspManagerConfiguration {
    pub fn disabled(dir_root: impl Into<PathBuf>) -> Self {
        Self {
            dir_root: dir_root.into(),
            enablement: LspManagerEnablement::Disabled,
            servers: Vec::new(),
            restart_policy: LanguageServerRestartPolicy::standard(),
            generation: 0,
        }
    }

    pub fn enabled(dir_root: impl Into<PathBuf>, servers: Vec<LanguageServerDefinition>) -> Self {
        Self {
            dir_root: dir_root.into(),
            enablement: LspManagerEnablement::Enabled,
            servers,
            restart_policy: LanguageServerRestartPolicy::standard(),
            generation: 0,
        }
    }

    pub fn dir_root(&self) -> &Path {
        &self.dir_root
    }

    pub const fn enablement(&self) -> LspManagerEnablement {
        self.enablement
    }

    pub fn servers(&self) -> &[LanguageServerDefinition] {
        &self.servers
    }

    pub const fn restart_policy(&self) -> LanguageServerRestartPolicy {
        self.restart_policy
    }

    /// Binds request metrics and cache invalidation to the host's resolved configuration version.
    pub const fn with_generation(mut self, generation: u64) -> Self {
        self.generation = generation;
        self
    }

    pub const fn with_restart_policy(mut self, policy: LanguageServerRestartPolicy) -> Self {
        self.restart_policy = policy;
        self
    }
}
