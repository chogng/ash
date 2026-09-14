use ash_core::CoreError;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessInstructions;
use ash_home::AshHome;
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
        Ok(Arc::new(HarnessContext::new(add_home_instructions(
            HarnessInstructions::default(),
            &self.home,
            &[],
            request.read_paths,
        ))))
    }
}

pub(super) fn add_home_instructions(
    instructions: HarnessInstructions,
    home: &AshHome,
    paths: &[PathBuf],
    selected: &[PathBuf],
) -> HarnessInstructions {
    let selected = selected
        .iter()
        .filter_map(|path| {
            let canonical = dunce::canonicalize(path).ok()?;
            let root = dunce::canonicalize(home.root()).ok()?;
            Some(home.root().join(canonical.strip_prefix(root).ok()?))
        })
        .collect::<Vec<_>>();
    let body =
        home.instructions()
            .context_content(paths, &selected, &home.root().join("instructions"));
    let content = Some(format!(
        "<ash-home>{}</ash-home>\n{}",
        home.root()
            .display()
            .to_string()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;"),
        body.unwrap_or_default()
    ));
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
