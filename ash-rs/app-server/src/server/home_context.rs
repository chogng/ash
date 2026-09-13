use ash_core::CoreError;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessInstructions;
use ash_home::AshHome;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::path::PathBuf;

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
        _request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        Ok(Arc::new(HarnessContext::new(add_home_instructions(
            HarnessInstructions::default(),
            &self.home,
            &[],
        ))))
    }
}

pub(super) fn add_home_instructions(
    instructions: HarnessInstructions,
    home: &AshHome,
    paths: &[PathBuf],
) -> HarnessInstructions {
    let content = home.instructions().automatic_content(paths);
    let revision = content_revision("user-instructions", content.as_deref().unwrap_or_default());
    instructions.with_user_instructions(content, revision)
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
