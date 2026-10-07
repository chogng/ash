use std::fmt;
use std::fmt::Write;

use sha2::Digest;
use sha2::Sha256;

use crate::ConnectorError;
use crate::ConnectorErrorKind;
use crate::ConnectorId;

const MAX_DISPLAY_TEXT_BYTES: usize = 4 * 1024;
const MAX_RUNTIME_ID_BYTES: usize = 1024;
const MAX_AUTHORIZATION_REVISION_BYTES: usize = 1024;
const DEFINITION_DIGEST_DOMAIN: &[u8] = b"ash-connector-definition-v1\0";

/// Stable digest of the fields that determine one Connector's authorization and runtime binding.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorDefinitionDigest(String);

impl ConnectorDefinitionDigest {
    pub fn new(value: impl Into<String>) -> Result<Self, ConnectorError> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(invalid_definition_digest());
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid_definition_digest());
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn invalid_definition_digest() -> ConnectorError {
    ConnectorError::new(
        ConnectorErrorKind::InvalidDefinition,
        "connector definition digest must use 'sha256:' followed by 64 lowercase hex digits",
    )
}

impl fmt::Display for ConnectorDefinitionDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Runtime declaration selected for a Connector independently from its account state.
///
/// Consumers materialize this declaration only after the Connector is connected. The binding
/// contains no live MCP session, transport, credential bytes, or execution authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectorRuntimeBinding {
    McpServer { server_id: String },
}

impl ConnectorRuntimeBinding {
    pub fn mcp_server(server_id: impl Into<String>) -> Result<Self, ConnectorError> {
        let server_id = server_id.into();
        validate_text("MCP server ID", &server_id, MAX_RUNTIME_ID_BYTES)?;
        Ok(Self::McpServer { server_id })
    }

    pub fn mcp_server_id(&self) -> &str {
        match self {
            Self::McpServer { server_id } => server_id,
        }
    }
}

/// Runtime-free definition of one connectable external product surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorDefinition {
    id: ConnectorId,
    display_name: String,
    description: String,
    runtime_binding: ConnectorRuntimeBinding,
    authorization_revision: String,
}

impl ConnectorDefinition {
    pub fn new(
        id: ConnectorId,
        display_name: impl Into<String>,
        description: impl Into<String>,
        runtime_binding: ConnectorRuntimeBinding,
    ) -> Result<Self, ConnectorError> {
        let display_name = display_name.into();
        let description = description.into();
        validate_text(
            "connector display name",
            &display_name,
            MAX_DISPLAY_TEXT_BYTES,
        )?;
        validate_text(
            "connector description",
            &description,
            MAX_DISPLAY_TEXT_BYTES,
        )?;
        let authorization_revision = format!("binding:{}", runtime_binding.mcp_server_id());
        Ok(Self {
            id,
            display_name,
            description,
            runtime_binding,
            authorization_revision,
        })
    }

    /// Replaces the compatibility revision that invalidates existing account authorization.
    ///
    /// Plugin adapters should use the exact package/declaration digest that covers runtime
    /// endpoint, permissions, and credential requirements. Display-only metadata is intentionally
    /// excluded so copy changes do not force reauthorization.
    pub fn with_authorization_revision(
        mut self,
        revision: impl Into<String>,
    ) -> Result<Self, ConnectorError> {
        let revision = revision.into();
        validate_text(
            "connector authorization revision",
            &revision,
            MAX_AUTHORIZATION_REVISION_BYTES,
        )?;
        self.authorization_revision = revision;
        Ok(self)
    }

    pub fn id(&self) -> &ConnectorId {
        &self.id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn runtime_binding(&self) -> &ConnectorRuntimeBinding {
        &self.runtime_binding
    }

    pub fn authorization_revision(&self) -> &str {
        &self.authorization_revision
    }

    /// Returns the exact authorization/runtime compatibility identity of this definition.
    pub fn digest(&self) -> ConnectorDefinitionDigest {
        let mut digest = Sha256::new();
        digest.update(DEFINITION_DIGEST_DOMAIN);
        update_digest_field(&mut digest, self.id.as_str());
        update_digest_field(&mut digest, &self.authorization_revision);
        match &self.runtime_binding {
            ConnectorRuntimeBinding::McpServer { server_id } => {
                update_digest_field(&mut digest, "mcp-server");
                update_digest_field(&mut digest, server_id);
            }
        }
        let mut value = String::with_capacity("sha256:".len() + 64);
        value.push_str("sha256:");
        for byte in digest.finalize() {
            write!(value, "{byte:02x}").expect("writing to a String cannot fail");
        }
        ConnectorDefinitionDigest(value)
    }
}

fn update_digest_field(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

pub(crate) fn validate_text(
    label: &str,
    value: &str,
    maximum_bytes: usize,
) -> Result<(), ConnectorError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.chars().any(char::is_control)
    {
        return Err(ConnectorError::new(
            ConnectorErrorKind::InvalidDefinition,
            format!("{label} must be bounded non-empty plain text without surrounding whitespace"),
        ));
    }
    Ok(())
}
