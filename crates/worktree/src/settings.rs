//! Codex Desktop-compatible managed worktree settings.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use serde_json::Value;

const WORKTREE_ROOT: &str = "git-worktree-root";
const AUTO_CLEANUP: &str = "worktree-auto-cleanup-enabled";
const KEEP_COUNT: &str = "worktree-keep-count";

pub const DEFAULT_WORKTREE_KEEP_COUNT: usize = 15;

/// Effective host-local settings understood by Codex Desktop worktrees.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeSettings {
    pub root: PathBuf,
    pub auto_cleanup_enabled: bool,
    pub keep_count: usize,
}

impl WorktreeSettings {
    /// Uses the Codex Desktop defaults for one Codex home directory.
    pub fn defaults(codex_home: &Path) -> Self {
        Self {
            root: dunce::simplified(&codex_home.join("worktrees")).to_path_buf(),
            auto_cleanup_enabled: true,
            keep_count: DEFAULT_WORKTREE_KEEP_COUNT,
        }
    }

    /// Resolves the established `[desktop]` worktree keys.
    pub fn from_desktop_config(
        codex_home: &Path,
        desktop: &HashMap<String, Value>,
    ) -> Result<Self> {
        let root = match desktop.get(WORKTREE_ROOT) {
            None | Some(Value::Null) => codex_home.join("worktrees"),
            Some(value) => {
                let configured = value
                    .as_str()
                    .context("desktop.git-worktree-root must be a string")?
                    .trim();
                if configured.is_empty() {
                    codex_home.join("worktrees")
                } else {
                    let path = PathBuf::from(configured);
                    if !path.is_absolute() {
                        bail!("desktop.git-worktree-root must be an absolute path");
                    }
                    path
                }
            }
        };

        let auto_cleanup_enabled = match desktop.get(AUTO_CLEANUP) {
            None => true,
            Some(value) => value
                .as_bool()
                .context("desktop.worktree-auto-cleanup-enabled must be a boolean")?,
        };
        let keep_count = match desktop.get(KEEP_COUNT) {
            None => DEFAULT_WORKTREE_KEEP_COUNT,
            Some(value) => {
                let count = value
                    .as_u64()
                    .context("desktop.worktree-keep-count must be a positive integer")?;
                if count == 0 {
                    bail!("desktop.worktree-keep-count must be a positive integer");
                }
                usize::try_from(count).context("desktop.worktree-keep-count is too large")?
            }
        };

        Ok(Self {
            root: dunce::simplified(&root).to_path_buf(),
            auto_cleanup_enabled,
            keep_count,
        })
    }
}
