use super::instruction_operations::InstructionCatalogSource;
use super::instruction_operations::selected_instruction_content;
use ash_core::CoreError;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessInstructions;
use ash_home::AshHome;
use ash_protocol::InstructionSource;
use sha2::Digest;
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Arc;

/// Supplies home Instructions even before a Directory is selected.
pub(super) struct HomeContext {
    home: Arc<AshHome>,
}

impl HomeContext {
    pub(super) fn new(home: Arc<AshHome>) -> Self {
        Self { home }
    }
}

impl HarnessContextProvider for HomeContext {
    fn snapshot(
        &self,
        request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        let selected = selected_instruction_content(
            &[InstructionCatalogSource::user(&self.home)],
            request.selected_instructions,
        )?;
        Ok(Arc::new(HarnessContext::new(add_home_instructions(
            HarnessInstructions::default(),
            &self.home,
            &[],
            selected.get(&InstructionSource::User).map(String::as_str),
        ))))
    }
}

pub(super) fn add_home_instructions(
    instructions: HarnessInstructions,
    home: &AshHome,
    paths: &[PathBuf],
    selected: Option<&str>,
) -> HarnessInstructions {
    let content = combine_home_content(home.instructions().automatic_content(paths), selected);
    let revision = content_revision("user-instructions", content.as_deref().unwrap_or_default());
    instructions.with_user_instructions(content, revision)
}

fn combine_home_content(automatic: Option<String>, selected: Option<&str>) -> Option<String> {
    match (automatic, selected) {
        (Some(automatic), Some(selected)) => Some(format!("{automatic}\n\n{selected}")),
        (Some(automatic), None) => Some(automatic),
        (None, Some(selected)) => Some(selected.to_owned()),
        (None, None) => None,
    }
}

pub(super) fn content_revision(kind: &str, content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    format!(
        "{kind}:sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

#[cfg(test)]
#[path = "home_context_tests.rs"]
mod tests;
