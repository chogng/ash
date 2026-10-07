//! User-scoped Ash Instructions from the selected Ash home.

use ash_instructions::InstructionCatalog;
use ash_instructions::InstructionCatalogSnapshot;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

/// Refreshes Ash-owned user Instructions under one absolute home directory.
pub struct AshHome {
    root: AbsolutePathBuf,
    instructions: Mutex<InstructionCatalog>,
}

impl AshHome {
    /// Selects the home whose `instructions` directory belongs to this user.
    pub fn new(home: AbsolutePathBuf) -> Self {
        Self {
            instructions: Mutex::new(InstructionCatalog::discover_user(home.as_path())),
            root: home,
        }
    }

    /// Returns the selected Ash data root used by this home instance.
    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    /// Returns a coherent snapshot of the current user Instructions.
    pub fn instructions(&self) -> Arc<InstructionCatalogSnapshot> {
        self.instructions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .refresh()
    }
}

#[cfg(test)]
#[path = "home_tests.rs"]
mod tests;
