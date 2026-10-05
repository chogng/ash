//! Image generation and editing with scoped artifacts and host-reviewed external access.
mod artifact;
mod backend;
mod tool;
pub use backend::GeneratedImage;
pub use backend::ImageGenerationBackend;
pub use backend::ImageGenerationRequest;
pub use backend::JsonImageGenerationBackend;
use extension_api::CapabilityToolContribution;
use extension_api::CapabilityToolContributor;
use extension_api::ExtensionError;
use extension_api::ExtensionItemStore;
use extension_api::ExtensionRegistryBuilder;
use extension_api::ExtensionToolAuthority;
use std::path::Path;
use std::sync::Arc;

struct ImageExtension {
    backend: Arc<dyn ImageGenerationBackend>,
    artifacts: Arc<artifact::Artifacts>,
    items: Arc<ExtensionItemStore>,
    references: Arc<dyn ImageReferenceSource>,
}
/// Installs the real image tool only with a configured backend and artifact directory.
pub fn install(
    builder: &mut ExtensionRegistryBuilder,
    backend: Arc<dyn ImageGenerationBackend>,
    root: &Path,
    items: Arc<ExtensionItemStore>,
    references: Arc<dyn ImageReferenceSource>,
) -> Result<(), String> {
    let artifacts = Arc::new(artifact::Artifacts::open(root)?);
    let extension = Arc::new(ImageExtension {
        backend,
        artifacts,
        items,
        references,
    });
    builder
        .capability_tool_contributor("image-generation", extension.clone())
        .turn_input_contributor("image-generation", extension);
    Ok(())
}
impl CapabilityToolContributor for ImageExtension {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        let scopes = self.backend.network_scopes();
        if scopes.is_empty() || scopes.iter().any(|s| s.trim().is_empty()) {
            return Err(ExtensionError::new(
                "image backend must declare exact network scopes",
            ));
        }
        Ok(vec![CapabilityToolContribution::new(
            Arc::new(tool::ImageTool::new(
                self.backend.clone(),
                self.artifacts.clone(),
                self.items.clone(),
                self.references.clone(),
            )),
            ExtensionToolAuthority::ExternalWrite {
                service: self.backend.service_name().into(),
                network_scopes: scopes,
                credential_reference: self.backend.credential_reference(),
                artifact_root: self.artifacts.root().to_string_lossy().into_owned(),
            },
        )])
    }
}

#[cfg(test)]
#[path = "artifact_tests.rs"]
mod tests;

/// Resolves only images already attached to the authorized Thread; no ambient filesystem access.
pub trait ImageReferenceSource: Send + Sync {
    fn list(
        &self,
        session: &protocol::SessionId,
        thread: &protocol::ThreadId,
    ) -> Result<Vec<String>, String>;
    fn read(
        &self,
        session: &protocol::SessionId,
        thread: &protocol::ThreadId,
        reference: &str,
    ) -> Result<String, String>;
}
impl extension_api::TurnInputContributor for ImageExtension {
    fn contribute(
        &self,
        input: extension_api::TurnInputContext<'_>,
    ) -> Result<Vec<extension_api::PromptFragment>, ExtensionError> {
        let Some(thread_id) = input.thread_id() else {
            return Ok(Vec::new());
        };
        let session = input
            .session_id()
            .ok_or_else(|| ExtensionError::new("image references require a Session"))?;
        let references = self
            .references
            .list(session, thread_id)
            .map_err(ExtensionError::new)?;
        if references.len() > 20
            || references.iter().any(|reference| {
                reference.len() > 256
                    || !reference.starts_with("attachment:")
                    || reference.chars().any(char::is_control)
            })
        {
            return Err(ExtensionError::new("invalid image reference catalog"));
        }
        if references.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![extension_api::PromptFragment::new(
            extension_api::PromptFragmentSource::new("image-generation", "input-images", "v1"),
            extension_api::PromptFragmentLayer::Product,
            extension_api::PromptFragmentRetention::BestEffort,
            format!(
                "Available attached images for imagegen reference_images: {}",
                references.join(", ")
            ),
        )])
    }
}
