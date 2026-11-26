//! User-scoped Instructions and Agent definitions from the selected Ash home.

use agent_roles::AgentRoleCatalog;
use agent_roles::AgentRoleCatalogSnapshot;
use agent_roles::UserRoleMutationError;
use ash_instructions::InstructionCatalog;
use ash_instructions::InstructionCatalogSnapshot;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

/// Owns user-scoped Agent and Instruction catalogs under one absolute home directory.
pub struct AshHome {
    root: AbsolutePathBuf,
    instructions: Mutex<InstructionCatalog>,
    agents: Mutex<AgentRoleCatalog>,
}

impl AshHome {
    /// Selects the home whose `instructions` directory belongs to this user.
    pub fn new(home: AbsolutePathBuf) -> Self {
        Self {
            instructions: Mutex::new(InstructionCatalog::discover_user(home.as_path())),
            agents: Mutex::new(AgentRoleCatalog::discover_user(home.as_path())),
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

    pub fn agents(&self) -> Arc<AgentRoleCatalogSnapshot> {
        self.agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .refresh()
    }

    pub fn create_agent(&self, name: &str, description: &str, prompt: &str) -> std::io::Result<()> {
        self.agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .create_user_role(name, description, prompt)
    }

    pub fn update_agent(
        &self,
        name: &str,
        expected_content_digest: &str,
        description: &str,
        prompt: &str,
    ) -> Result<(), UserRoleMutationError> {
        self.agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .update_user_role(name, expected_content_digest, description, prompt)
    }

    pub fn delete_agent(
        &self,
        name: &str,
        expected_content_digest: &str,
    ) -> Result<(), UserRoleMutationError> {
        self.agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .delete_user_role(name, expected_content_digest)
    }
}

#[cfg(test)]
#[path = "home_tests.rs"]
mod tests;
