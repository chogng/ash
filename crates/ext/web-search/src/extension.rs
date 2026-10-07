use std::sync::Arc;

use ash_extension_api::CapabilityToolContribution;
use ash_extension_api::CapabilityToolContributor;
use ash_extension_api::ExtensionError;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::ExtensionToolAuthority;

use crate::WebSearchBackend;
use crate::tool::WebSearchTool;

struct WebSearchExtension {
    backend: Arc<dyn WebSearchBackend>,
    items: Arc<ash_extension_api::ExtensionItemStore>,
}

impl CapabilityToolContributor for WebSearchExtension {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        let network_scopes = self.backend.network_scopes();
        if network_scopes.is_empty() || network_scopes.iter().any(|scope| scope.trim().is_empty()) {
            return Err(ExtensionError::new(
                "Web Search backend must declare at least one exact network scope",
            ));
        }
        Ok(vec![CapabilityToolContribution::new(
            Arc::new(WebSearchTool::new(
                Arc::clone(&self.backend),
                self.items.clone(),
            )),
            ExtensionToolAuthority::ExternalRead {
                service: self.backend.service_name().to_owned(),
                network_scopes,
                credential_reference: self.backend.credential_reference(),
            },
        )])
    }
}

/// Installs Web Search into the capability-bearing extension registry.
pub fn install(builder: &mut ExtensionRegistryBuilder, backend: Arc<dyn WebSearchBackend>) {
    builder.capability_tool_contributor(
        "web-search",
        Arc::new(WebSearchExtension {
            backend,
            items: Arc::new(ash_extension_api::ExtensionItemStore::new(builder.state())),
        }),
    );
}
