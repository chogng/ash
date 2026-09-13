use super::InstructionFragment;
use super::InstructionLayer;
use super::InstructionRetention;
use super::InstructionSource;

/// Immutable system, user, and directory instructions supplied by the host.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HarnessInstructions {
    system_body: String,
    system_revision: String,
    user_instructions: Option<String>,
    user_revision: String,
    directory_instructions: Option<String>,
    directory_revision: String,
}

impl HarnessInstructions {
    /// Creates prompt additions from a system body and optional directory instructions.
    pub fn new(system_body: impl Into<String>, directory_instructions: Option<String>) -> Self {
        Self {
            system_body: system_body.into(),
            system_revision: "unversioned-system".into(),
            user_instructions: None,
            user_revision: "unversioned-user".into(),
            directory_instructions,
            directory_revision: "unversioned-directory".into(),
        }
    }

    /// Creates host additions containing only optional directory instructions.
    pub fn directory(directory_instructions: Option<String>) -> Self {
        Self::new(String::new(), directory_instructions)
    }

    pub fn with_system_revision(mut self, revision: impl Into<String>) -> Self {
        self.system_revision = revision.into();
        self
    }

    /// Adds the selected Ash home's Global Instructions to this host snapshot.
    pub fn with_user_instructions(
        mut self,
        instructions: Option<String>,
        revision: impl Into<String>,
    ) -> Self {
        self.user_instructions = instructions;
        self.user_revision = revision.into();
        self
    }

    pub fn with_directory_revision(mut self, revision: impl Into<String>) -> Self {
        self.directory_revision = revision.into();
        self
    }

    pub fn system_body(&self) -> &str {
        &self.system_body
    }

    pub fn directory_instructions(&self) -> Option<&str> {
        self.directory_instructions.as_deref()
    }

    pub fn user_instructions(&self) -> Option<&str> {
        self.user_instructions.as_deref()
    }

    pub(crate) fn context_fragments(&self) -> Vec<InstructionFragment> {
        let mut fragments = Vec::new();
        if !self.system_body.trim().is_empty() {
            fragments.push(InstructionFragment::new(
                InstructionSource::new(
                    "system",
                    "ash-system-prompt",
                    self.system_revision.clone(),
                ),
                InstructionLayer::System,
                InstructionRetention::Required,
                self.system_body.clone(),
            ));
        }
        if let Some(instructions) = self
            .user_instructions
            .as_ref()
            .filter(|instructions| !instructions.trim().is_empty())
        {
            fragments.push(InstructionFragment::new(
                InstructionSource::new("user", "ash-home-instructions", self.user_revision.clone()),
                InstructionLayer::User,
                InstructionRetention::Required,
                format!(
                    "<user-instructions>\nUser Instructions from the selected Ash home. They rank below system and safety policy, and above Directory Instructions. Within this scope, ASH.md refines shared AGENTS.md guidance.\n{}\n</user-instructions>",
                    instructions
                ),
            ));
        }
        if let Some(instructions) = self
            .directory_instructions
            .as_ref()
            .filter(|instructions| !instructions.trim().is_empty())
        {
            fragments.push(InstructionFragment::new(
                InstructionSource::new(
                    "directory",
                    "directory-instructions",
                    self.directory_revision.clone(),
                ),
                InstructionLayer::Directory,
                InstructionRetention::Required,
                format!(
                    "<directory-instructions>\nDirectory Instructions apply only to their declared roots. They rank below system, safety policy, and User Instructions. Within a root, ASH.md refines shared AGENTS.md guidance.\n{}\n</directory-instructions>",
                    instructions
                ),
            ));
        }
        fragments
    }
}
