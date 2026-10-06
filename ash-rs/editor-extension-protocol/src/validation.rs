use std::collections::BTreeSet;

use serde::Serialize;

use super::ActivateParams;
use super::ExtensionCapability;
use super::HostRequestKind;
use super::HostResponseKind;
use super::HostSuccess;
use super::MAX_ACTIVATION_EVENTS;
use super::MAX_DISPLAY_TEXT_BYTES;
use super::MAX_IDENTIFIER_BYTES;
use super::MAX_LANGUAGE_IDS;
use super::MAX_PROVIDER_OPERATIONS;
use super::RegistrationDescriptor;
use super::RegistrationKind;
use crate::ProtocolError;

pub(super) fn validate_activation(params: &ActivateParams) -> Result<(), ProtocolError> {
    validate_identifier(&params.extension_id)?;
    validate_identifier(&params.package.package_id)?;
    validate_digest(&params.package.package_digest)?;
    validate_relative_entrypoint(&params.package.entrypoint)?;
    if params.runtime_api_version == 0 {
        return Err(protocol_error("runtime API version must be non-zero"));
    }
    if params.activation_events.len() > MAX_ACTIVATION_EVENTS {
        return Err(ProtocolError::QuotaExceeded("activation events"));
    }
    if params.activation_events.is_empty() {
        return Err(protocol_error("activation events must not be empty"));
    }
    let mut events = BTreeSet::new();
    for event in &params.activation_events {
        validate_short_text(event, MAX_IDENTIFIER_BYTES, "activation event")?;
        if !events.insert(event) {
            return Err(protocol_error("activation events must be unique"));
        }
    }
    if params.capabilities.is_empty() {
        return Err(protocol_error("capabilities must not be empty"));
    }
    if params.capabilities.len() > 16 {
        return Err(ProtocolError::QuotaExceeded("capabilities"));
    }
    if params
        .capabilities
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .len()
        != params.capabilities.len()
    {
        return Err(protocol_error("capabilities must be unique"));
    }
    Ok(())
}

pub(super) fn validate_registrations(
    registrations: &[RegistrationDescriptor],
    maximum: usize,
    capabilities: &[ExtensionCapability],
) -> Result<(), ProtocolError> {
    if registrations.len() > maximum {
        return Err(ProtocolError::QuotaExceeded("registrations"));
    }
    let mut ids = BTreeSet::new();
    let mut commands = BTreeSet::new();
    let mut debugger_types = BTreeSet::new();
    let mut task_types = BTreeSet::new();
    let mut test_profile_providers = BTreeSet::new();
    for registration in registrations {
        validate_identifier(&registration.registration_id)?;
        if !ids.insert(&registration.registration_id) {
            return Err(protocol_error("registration IDs must be unique"));
        }
        let required = match &registration.kind {
            RegistrationKind::ExternalUriOpener { schemes, label } => {
                if schemes.is_empty()
                    || schemes.len() > 2
                    || schemes.iter().copied().collect::<BTreeSet<_>>().len() != schemes.len()
                {
                    return Err(protocol_error(
                        "external URI opener schemes must be non-empty and unique",
                    ));
                }
                validate_display_text(label, "external URI opener label")?;
                ExtensionCapability::ExternalUriOpener
            }
            RegistrationKind::DataChannel { channel_id } => {
                validate_selector(channel_id, "data channel ID")?;
                ExtensionCapability::DataChannel
            }
            RegistrationKind::LinkPresentationProvider {
                uri_pattern,
                presentation_kind,
            } => {
                validate_short_text(uri_pattern, 2048, "link URI pattern")?;
                if !matches!(
                    presentation_kind.as_str(),
                    "resource"
                        | "issue"
                        | "pullRequest"
                        | "commit"
                        | "file"
                        | "folder"
                        | "session"
                        | "chat"
                        | "repository"
                        | "branch"
                ) {
                    return Err(protocol_error("link presentation kind is invalid"));
                }
                ExtensionCapability::LinkPresentationProvider
            }
            RegistrationKind::Command { command, title } => {
                validate_selector(command, "command")?;
                validate_display_text(title, "command title")?;
                require_unique(&mut commands, command, "commands")?;
                ExtensionCapability::Command
            }
            RegistrationKind::LanguageProvider {
                language_ids,
                operations,
            } => {
                validate_unique_selectors(language_ids, MAX_LANGUAGE_IDS, "language IDs")?;
                if operations.is_empty() || operations.len() > MAX_PROVIDER_OPERATIONS {
                    return Err(ProtocolError::QuotaExceeded("language provider operations"));
                }
                if operations.iter().copied().collect::<BTreeSet<_>>().len() != operations.len() {
                    return Err(protocol_error(
                        "language provider operations must be unique",
                    ));
                }
                ExtensionCapability::LanguageProvider
            }
            RegistrationKind::DebugAdapter { debugger_type } => {
                validate_selector(debugger_type, "debugger type")?;
                require_unique(&mut debugger_types, debugger_type, "debugger types")?;
                ExtensionCapability::DebugAdapter
            }
            RegistrationKind::TaskProvider { task_type } => {
                validate_selector(task_type, "task type")?;
                require_unique(&mut task_types, task_type, "task types")?;
                ExtensionCapability::TaskProvider
            }
            RegistrationKind::TestProfileProvider { provider_id, label } => {
                validate_selector(provider_id, "test profile provider ID")?;
                validate_display_text(label, "test profile provider label")?;
                require_unique(
                    &mut test_profile_providers,
                    provider_id,
                    "test profile provider IDs",
                )?;
                ExtensionCapability::TestProfileProvider
            }
        };
        if !capabilities.contains(&required) {
            return Err(protocol_error(
                "runtime registration exceeds its declared capability ceiling",
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_response_kind(
    request: &HostRequestKind,
    response: &HostResponseKind,
) -> Result<(), ProtocolError> {
    match response {
        HostResponseKind::Failure(failure) => {
            validate_short_text(&failure.message, MAX_DISPLAY_TEXT_BYTES, "failure message")?;
            return Ok(());
        }
        HostResponseKind::Success(_) => {}
    }
    let HostResponseKind::Success(success) = response else {
        unreachable!();
    };
    let matches = matches!(
        (request, success),
        (HostRequestKind::Initialize(_), HostSuccess::Initialized(_))
            | (HostRequestKind::Activate(_), HostSuccess::Activated(_))
            | (HostRequestKind::Deactivate, HostSuccess::Deactivated)
            | (HostRequestKind::Invoke(_), HostSuccess::Invoked(_))
            | (HostRequestKind::Cancel(_), HostSuccess::Cancelled)
            | (HostRequestKind::Ping, HostSuccess::Pong)
            | (HostRequestKind::Shutdown, HostSuccess::Shutdown)
    );
    if !matches {
        return Err(protocol_error(
            "response kind does not match request method",
        ));
    }
    Ok(())
}

pub(super) fn validate_identifier(value: &str) -> Result<(), ProtocolError> {
    validate_short_text(value, MAX_IDENTIFIER_BYTES, "identifier")?;
    if value.chars().any(char::is_whitespace) {
        return Err(protocol_error("identifier must not contain whitespace"));
    }
    Ok(())
}

pub(super) fn validate_short_text(
    value: &str,
    maximum_bytes: usize,
    label: &'static str,
) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control) {
        return Err(protocol_error(format!("{label} is invalid")));
    }
    Ok(())
}

pub(super) fn validate_encoded_size<T: Serialize>(
    value: &T,
    maximum_bytes: usize,
) -> Result<(), ProtocolError> {
    let size = serde_json::to_vec(value)
        .map_err(|error| protocol_error(error.to_string()))?
        .len();
    if size > maximum_bytes {
        return Err(ProtocolError::QuotaExceeded("protocol frame bytes"));
    }
    Ok(())
}

fn validate_unique_selectors(
    values: &[String],
    maximum: usize,
    label: &'static str,
) -> Result<(), ProtocolError> {
    if values.is_empty() || values.len() > maximum {
        return Err(ProtocolError::QuotaExceeded(label));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_selector(value, label)?;
        if !unique.insert(value) {
            return Err(protocol_error(format!("{label} must be unique")));
        }
    }
    Ok(())
}

fn validate_selector(value: &str, label: &'static str) -> Result<(), ProtocolError> {
    validate_short_text(value, MAX_IDENTIFIER_BYTES, label)?;
    if value.chars().any(char::is_whitespace) {
        return Err(protocol_error(format!(
            "{label} must not contain whitespace"
        )));
    }
    Ok(())
}

fn validate_display_text(value: &str, label: &'static str) -> Result<(), ProtocolError> {
    if value.trim().is_empty()
        || value.len() > MAX_DISPLAY_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(protocol_error(format!("{label} is invalid")));
    }
    Ok(())
}

fn require_unique<'a>(
    values: &mut BTreeSet<&'a String>,
    value: &'a String,
    label: &'static str,
) -> Result<(), ProtocolError> {
    if !values.insert(value) {
        return Err(protocol_error(format!("{label} must be unique")));
    }
    Ok(())
}

fn validate_digest(digest: &str) -> Result<(), ProtocolError> {
    let Some(hex) = digest.strip_prefix("sha256:") else {
        return Err(protocol_error("package digest must use SHA-256"));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(protocol_error("package digest is invalid"));
    }
    Ok(())
}

fn validate_relative_entrypoint(path: &str) -> Result<(), ProtocolError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.split('/').any(|component| {
            component.is_empty() || component == "." || component == ".." || component.contains(':')
        })
    {
        return Err(protocol_error(
            "entrypoint must be a normalized package-relative path",
        ));
    }
    Ok(())
}

pub(super) fn protocol_error(message: impl Into<String>) -> ProtocolError {
    ProtocolError::InvalidProtocol(message.into())
}
