use crate::JsonSchema;
use crate::TS;
use crate::protocol::common::ClientCapabilities;
use crate::protocol::common::ClientInfo;
use crate::protocol::common::SchemaHash;
use crate::protocol::common::ServerInfo;
use crate::protocol::slash_commands::SlashCommandDefinition;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;

pub const APP_SERVER_PROTOCOL_MAJOR: u32 = 7;
// Same-product clients bind to the generated schema fingerprint, not a shared
// counter for unrelated capability domains.
pub const REQUIRED_SESSION_CAPABILITIES: &[CapabilityRequirement] = &[
    CapabilityRequirement::Enabled("sessions"),
    CapabilityRequirement::Enabled("threads"),
    CapabilityRequirement::Enabled("turns"),
];

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub server_info: ServerInfo,
    pub protocol_version: ProtocolVersion,
    pub schema_hash: SchemaHash,
    pub capabilities: ServerCapabilities,
    pub slash_commands: Vec<SlashCommandDefinition>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolVersion {
    pub major: u32,
}

impl ProtocolVersion {
    pub const fn current() -> Self {
        Self {
            major: APP_SERVER_PROTOCOL_MAJOR,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityContract {
    pub version: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityRequirement {
    Enabled(&'static str),
    Contract {
        name: &'static str,
        min_version: u32,
        max_version: u32,
    },
}

impl CapabilityRequirement {
    pub const fn exact(name: &'static str, version: u32) -> Self {
        Self::Contract {
            name,
            min_version: version,
            max_version: version,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolCompatibilityError {
    MajorVersion {
        expected: u32,
        received: u32,
    },
    SchemaHash {
        expected: String,
        received: String,
    },
    MissingCapability {
        name: &'static str,
    },
    CapabilityVersion {
        name: &'static str,
        min_version: u32,
        max_version: u32,
        received: u32,
    },
}

impl fmt::Display for ProtocolCompatibilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MajorVersion { expected, received } => write!(
                formatter,
                "protocol major mismatch: client requires {expected}, server advertised {received}"
            ),
            Self::SchemaHash { expected, received } => write!(
                formatter,
                "protocol schema mismatch: client requires {expected}, server advertised {received}"
            ),
            Self::MissingCapability { name } => write!(
                formatter,
                "required App Server capability {name} is missing"
            ),
            Self::CapabilityVersion {
                name,
                min_version,
                max_version,
                received,
            } => write!(
                formatter,
                "App Server capability {name} version is incompatible: client supports {min_version}..={max_version}, server advertised {received}"
            ),
        }
    }
}

impl std::error::Error for ProtocolCompatibilityError {}

pub fn ensure_protocol_compatible(
    initialized: &InitializeResult,
    requirements: &[CapabilityRequirement],
) -> Result<(), ProtocolCompatibilityError> {
    if initialized.protocol_version.major != APP_SERVER_PROTOCOL_MAJOR {
        return Err(ProtocolCompatibilityError::MajorVersion {
            expected: APP_SERVER_PROTOCOL_MAJOR,
            received: initialized.protocol_version.major,
        });
    }
    // The product ships one generated contract. Check it before permitting requests so
    // an older backend cannot silently ignore fields such as permission or model choices.
    let expected = crate::schema_hash();
    if initialized.schema_hash.0 != expected {
        return Err(ProtocolCompatibilityError::SchemaHash {
            expected,
            received: initialized.schema_hash.0.clone(),
        });
    }
    for requirement in requirements {
        match *requirement {
            CapabilityRequirement::Enabled(name) => {
                if initialized.capabilities.is_enabled(name) != Some(true) {
                    return Err(ProtocolCompatibilityError::MissingCapability { name });
                }
            }
            CapabilityRequirement::Contract {
                name,
                min_version,
                max_version,
            } => {
                if initialized.capabilities.is_enabled(name) == Some(false) {
                    return Err(ProtocolCompatibilityError::MissingCapability { name });
                }
                let Some(contract) = initialized.capabilities.contracts.get(name) else {
                    return Err(ProtocolCompatibilityError::MissingCapability { name });
                };
                if contract.version < min_version || contract.version > max_version {
                    return Err(ProtocolCompatibilityError::CapabilityVersion {
                        name,
                        min_version,
                        max_version,
                        received: contract.version,
                    });
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub agent_interactions: bool,
    pub document_collaboration: bool,
    pub sessions: bool,
    pub threads: bool,
    pub turns: bool,
    pub projects: bool,
    pub memories: bool,
    pub approval_environment: bool,
    pub resources: bool,
    pub attachments: bool,
    pub file_system: bool,
    pub git: bool,
    pub github: bool,
    pub content_search: bool,
    pub codebase: bool,
    pub cloud_codebase: bool,
    pub terminal: bool,
    pub debug_adapter: bool,
    pub typst: bool,
    pub update_replay: bool,
    pub extensions: bool,
    pub extension_host: bool,
    pub connectors: bool,
    pub plugins: bool,
    pub marketplace: bool,
    pub mcp: bool,
    #[serde(rename = "mcpOAuth")]
    #[ts(rename = "mcpOAuth")]
    pub mcp_oauth: bool,
    pub contracts: BTreeMap<String, CapabilityContract>,
}

impl ServerCapabilities {
    fn is_enabled(&self, name: &str) -> Option<bool> {
        match name {
            "agentInteractions" => Some(self.agent_interactions),
            "documentCollaboration" => Some(self.document_collaboration),
            "sessions" => Some(self.sessions),
            "threads" => Some(self.threads),
            "turns" => Some(self.turns),
            "projects" => Some(self.projects),
            "memories" => Some(self.memories),
            "approvalEnvironment" => Some(self.approval_environment),
            "resources" => Some(self.resources),
            "attachments" => Some(self.attachments),
            "fileSystem" => Some(self.file_system),
            "git" => Some(self.git),
            "github" => Some(self.github),
            "contentSearch" => Some(self.content_search),
            "codebase" => Some(self.codebase),
            "cloudCodebase" => Some(self.cloud_codebase),
            "terminal" => Some(self.terminal),
            "debugAdapter" => Some(self.debug_adapter),
            "typst" => Some(self.typst),
            "updateReplay" => Some(self.update_replay),
            "extensions" => Some(self.extensions),
            "extensionHost" => Some(self.extension_host),
            "connectors" => Some(self.connectors),
            "plugins" => Some(self.plugins),
            "marketplace" => Some(self.marketplace),
            "mcp" => Some(self.mcp),
            "mcpOAuth" => Some(self.mcp_oauth),
            _ => None,
        }
    }

    pub fn advertise_contracts(&mut self) {
        // Only independently versioned optional contracts need entries here. Shared
        // protocol identity and boolean availability cover the other capabilities.
        if self.github {
            self.contracts
                .insert("github".into(), CapabilityContract { version: 1 });
        }
        if self.marketplace {
            self.contracts.insert(
                "marketplaceSearch".into(),
                CapabilityContract { version: 1 },
            );
        }
    }
}
