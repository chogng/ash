use std::collections::BTreeSet;

use crate::{PluginError, PluginErrorKind};

use super::ContributionKind;
use super::ContributionReference;
use super::EditorExtensionActivationEvent;
use super::EditorExtensionContribution;
use super::ManifestLocalId;
use super::Permission;
use super::PluginManifest;

const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const MAX_DISPLAY_NAME_BYTES: usize = 200;
const MAX_DESCRIPTION_BYTES: usize = 4096;
const MAX_DECLARATIVE_EXTENSION_CONTRIBUTIONS: usize = 128;
const MAX_EDITOR_EXTENSION_CONTRIBUTIONS: usize = 64;
const MAX_EDITOR_EXTENSION_ACTIVATION_EVENTS: usize = 64;
const MAX_EDITOR_EXTENSION_ACTIVATION_SELECTOR_BYTES: usize = 128;
const MAX_LICENSE_BYTES: usize = 256;

impl PluginManifest {
    /// Revalidates semantic invariants after programmatic construction or modification.
    pub fn validate(&self) -> Result<(), PluginError> {
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return invalid(format!(
                "unsupported plugin manifest schemaVersion {}; expected {}",
                self.schema_version, SUPPORTED_SCHEMA_VERSION
            ));
        }
        validate_plain_text(&self.display_name, "displayName", MAX_DISPLAY_NAME_BYTES)?;
        if let Some(description) = &self.description {
            validate_description(description)?;
        }
        if let Some(license) = &self.license {
            validate_plain_text(license, "license", MAX_LICENSE_BYTES)?;
        }
        if self.contributions.skills.is_empty()
            && self.contributions.mcp_servers.is_empty()
            && self.contributions.connectors.is_empty()
            && self.contributions.assets.is_empty()
            && self.contributions.editor_extensions.is_empty()
            && self.contributions.declarative_extensions.is_empty()
        {
            return invalid("plugin manifest must declare at least one contribution");
        }

        unique_ids(
            "skill",
            self.contributions
                .skills
                .iter()
                .map(|contribution| &contribution.id),
        )?;
        unique_ids(
            "MCP server",
            self.contributions
                .mcp_servers
                .iter()
                .map(|contribution| &contribution.id),
        )?;
        unique_ids(
            "connector",
            self.contributions
                .connectors
                .iter()
                .map(|contribution| &contribution.id),
        )?;
        unique_ids(
            "asset",
            self.contributions
                .assets
                .iter()
                .map(|contribution| &contribution.id),
        )?;
        unique_ids(
            "Editor Extension",
            self.contributions
                .editor_extensions
                .iter()
                .map(|contribution| &contribution.id),
        )?;
        unique_ids(
            "declarative Extension",
            self.contributions
                .declarative_extensions
                .iter()
                .map(|contribution| &contribution.id),
        )?;
        unique_ids(
            "credential slot",
            self.credential_slots.iter().map(|slot| &slot.name),
        )?;
        validate_editor_extensions(self)?;
        if self.contributions.declarative_extensions.len() > MAX_DECLARATIVE_EXTENSION_CONTRIBUTIONS
        {
            return invalid(format!(
                "plugin manifest may declare at most {MAX_DECLARATIVE_EXTENSION_CONTRIBUTIONS} declarative Extensions"
            ));
        }

        let available = contribution_references(self);
        let mcp_servers = self
            .contributions
            .mcp_servers
            .iter()
            .map(|server| &server.id)
            .collect::<BTreeSet<_>>();
        for connector in &self.contributions.connectors {
            validate_plain_text(
                &connector.display_name,
                "connector displayName",
                MAX_DISPLAY_NAME_BYTES,
            )?;
            validate_description(&connector.description)?;
            if !mcp_servers.contains(&connector.mcp_server) {
                return invalid(format!(
                    "connector '{}' references missing MCP server '{}'",
                    connector.id, connector.mcp_server
                ));
            }
        }
        for slot in &self.credential_slots {
            let mut required = BTreeSet::new();
            for reference in &slot.required_for {
                if !required.insert(reference) {
                    return invalid(format!(
                        "credential slot '{}' repeats requiredFor reference '{}'",
                        slot.name, reference
                    ));
                }
                if !available.contains(reference) {
                    return invalid(format!(
                        "credential slot '{}' references missing contribution '{}'",
                        slot.name, reference
                    ));
                }
            }
        }

        let mut permissions = BTreeSet::new();
        for permission in &self.permissions {
            if !permissions.insert(permission) {
                return invalid("plugin manifest contains a duplicate permission");
            }
            if let Permission::Network { hosts } = permission {
                if hosts.is_empty() {
                    return invalid("network permission must declare at least one exact host");
                }
                let mut unique_hosts = BTreeSet::new();
                if hosts.iter().any(|host| !unique_hosts.insert(host)) {
                    return invalid("network permission contains a duplicate host");
                }
            }
        }

        for key in self.metadata.keys() {
            if !is_namespaced_metadata_key(key) {
                return invalid(format!(
                    "metadata key '{key}' must use a namespaced '<publisher>/<key>' form"
                ));
            }
        }
        Ok(())
    }
}

fn validate_editor_extensions(manifest: &PluginManifest) -> Result<(), PluginError> {
    let extensions = &manifest.contributions.editor_extensions;
    if extensions.len() > MAX_EDITOR_EXTENSION_CONTRIBUTIONS {
        return invalid(format!(
            "plugin manifest may declare at most {MAX_EDITOR_EXTENSION_CONTRIBUTIONS} Editor Extensions"
        ));
    }
    if extensions
        .iter()
        .filter(|extension| extension.api == super::EditorExtensionApi::Vscode)
        .count()
        > 1
    {
        return invalid(
            "A Plugin package may declare only one VS Code API entry for its package-root manifest",
        );
    }

    let mut entrypoints = BTreeSet::new();
    for extension in extensions {
        if !entrypoints.insert(&extension.entrypoint) {
            return invalid(format!(
                "Editor Extension entrypoint '{}' is declared more than once",
                extension.entrypoint
            ));
        }
        if extension.runtime == super::EditorExtensionRuntime::HostRpc
            && !manifest.permissions.iter().any(|permission| {
                matches!(
                    permission,
                    Permission::Process { executable } if executable == &extension.entrypoint
                )
            })
        {
            return invalid(format!(
                "Editor Extension '{}' entrypoint '{}' requires an exact process permission",
                extension.id, extension.entrypoint
            ));
        }
        validate_editor_extension(extension)?;
    }
    Ok(())
}

fn validate_editor_extension(extension: &EditorExtensionContribution) -> Result<(), PluginError> {
    if extension.runtime == super::EditorExtensionRuntime::HostRpc
        && extension.api != super::EditorExtensionApi::Ash
    {
        return invalid("Editor Extension api is only available for JavaScript entries");
    }
    if extension.runtime == super::EditorExtensionRuntime::JavaScript {
        let suffix = std::path::Path::new(extension.entrypoint.as_str())
            .extension()
            .and_then(|extension| extension.to_str());
        let supported = match extension.api {
            super::EditorExtensionApi::Ash => matches!(suffix, Some("js" | "mjs")),
            super::EditorExtensionApi::Vscode => matches!(suffix, Some("js" | "mjs" | "cjs")),
        };
        if !supported {
            return invalid(
                "JavaScript Editor Extension entrypoint has an unsupported module format",
            );
        }
        if extension.capabilities.iter().any(|capability| {
            !matches!(
                capability,
                super::EditorExtensionCapability::RemoteAuthorityResolver
                    | super::EditorExtensionCapability::Command
                    | super::EditorExtensionCapability::LanguageProvider
                    | super::EditorExtensionCapability::StatusBar
                    | super::EditorExtensionCapability::TaskProvider
                    | super::EditorExtensionCapability::DebugAdapter
            )
        }) {
            return invalid(
                "JavaScript SDK v1 supports command, language provider, status bar, Task provider, Debug and Remote resolver registrations",
            );
        }
    }

    if extension.activation_events.is_empty() {
        return invalid(format!(
            "Editor Extension '{}' must declare at least one activation event",
            extension.id
        ));
    }
    if extension.activation_events.len() > MAX_EDITOR_EXTENSION_ACTIVATION_EVENTS {
        return invalid(format!(
            "Editor Extension '{}' may declare at most {MAX_EDITOR_EXTENSION_ACTIVATION_EVENTS} activation events",
            extension.id
        ));
    }
    if extension.capabilities.is_empty() {
        return invalid(format!(
            "Editor Extension '{}' must declare at least one capability",
            extension.id
        ));
    }

    let capabilities = extension
        .capabilities
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if capabilities.len() != extension.capabilities.len() {
        return invalid(format!(
            "Editor Extension '{}' contains a duplicate capability",
            extension.id
        ));
    }

    let mut events = BTreeSet::new();
    for event in &extension.activation_events {
        if !events.insert(event) {
            return invalid(format!(
                "Editor Extension '{}' contains a duplicate activation event",
                extension.id
            ));
        }
        validate_activation_event(extension, event)?;
        if let Some(required) = event.required_capability()
            && !capabilities.contains(&required)
        {
            return invalid(format!(
                "Editor Extension '{}' activation event requires undeclared capability '{required:?}'",
                extension.id
            ));
        }
    }
    Ok(())
}

fn validate_activation_event(
    extension: &EditorExtensionContribution,
    event: &EditorExtensionActivationEvent,
) -> Result<(), PluginError> {
    match event {
        EditorExtensionActivationEvent::Startup
        | EditorExtensionActivationEvent::OnDemand { .. } => Ok(()),
        EditorExtensionActivationEvent::OnCommand { id }
        | EditorExtensionActivationEvent::OnLanguage { id } => {
            validate_activation_selector(id, &extension.id)
        }
        EditorExtensionActivationEvent::OnDebugType { debug_type } => {
            validate_activation_selector(debug_type, &extension.id)
        }
        EditorExtensionActivationEvent::OnTaskType { task_type } => {
            validate_activation_selector(task_type, &extension.id)
        }
        EditorExtensionActivationEvent::OnTestProfile { profile_id } => {
            validate_activation_selector(profile_id, &extension.id)
        }
    }
}

fn validate_activation_selector(
    selector: &str,
    extension_id: &ManifestLocalId,
) -> Result<(), PluginError> {
    if selector.trim().is_empty()
        || selector.len() > MAX_EDITOR_EXTENSION_ACTIVATION_SELECTOR_BYTES
        || selector
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return invalid(format!(
            "Editor Extension '{extension_id}' activation selector must be non-empty, contain no whitespace, and be at most {MAX_EDITOR_EXTENSION_ACTIVATION_SELECTOR_BYTES} bytes"
        ));
    }
    Ok(())
}

fn unique_ids<'a>(
    kind: &str,
    ids: impl IntoIterator<Item = &'a ManifestLocalId>,
) -> Result<(), PluginError> {
    let mut unique = BTreeSet::new();
    for id in ids {
        if !unique.insert(id) {
            return invalid(format!("duplicate {kind} contribution id '{id}'"));
        }
    }
    Ok(())
}

fn contribution_references(manifest: &PluginManifest) -> BTreeSet<ContributionReference> {
    manifest
        .contributions
        .skills
        .iter()
        .map(|item| ContributionReference {
            kind: ContributionKind::Skill,
            id: item.id.clone(),
        })
        .chain(
            manifest
                .contributions
                .connectors
                .iter()
                .map(|item| ContributionReference {
                    kind: ContributionKind::Connector,
                    id: item.id.clone(),
                }),
        )
        .chain(
            manifest
                .contributions
                .mcp_servers
                .iter()
                .map(|item| ContributionReference {
                    kind: ContributionKind::Mcp,
                    id: item.id.clone(),
                }),
        )
        .chain(
            manifest
                .contributions
                .assets
                .iter()
                .map(|item| ContributionReference {
                    kind: ContributionKind::Asset,
                    id: item.id.clone(),
                }),
        )
        .chain(
            manifest
                .contributions
                .editor_extensions
                .iter()
                .map(|item| ContributionReference {
                    kind: ContributionKind::EditorExtension,
                    id: item.id.clone(),
                }),
        )
        .collect()
}

fn validate_plain_text(value: &str, field: &str, max: usize) -> Result<(), PluginError> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return invalid(format!(
            "{field} must be non-empty plain text no longer than {max} bytes"
        ));
    }
    Ok(())
}

fn validate_description(value: &str) -> Result<(), PluginError> {
    if value.trim().is_empty()
        || value.len() > MAX_DESCRIPTION_BYTES
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return invalid(format!(
            "description must be non-empty text no longer than {MAX_DESCRIPTION_BYTES} bytes"
        ));
    }
    Ok(())
}

fn is_namespaced_metadata_key(key: &str) -> bool {
    let Some((namespace, name)) = key.split_once('/') else {
        return false;
    };
    key.matches('/').count() == 1 && is_metadata_segment(namespace) && is_metadata_segment(name)
}

fn is_metadata_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['-', '.'])
        && !value.ends_with(['-', '.'])
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.' | b'_')
        })
}

fn invalid(message: impl Into<String>) -> Result<(), PluginError> {
    Err(PluginError::new(PluginErrorKind::ManifestInvalid, message))
}

#[cfg(test)]
#[path = "validation_tests.rs"]
mod tests;
