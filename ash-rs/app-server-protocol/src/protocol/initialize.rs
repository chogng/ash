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
pub const APP_SERVER_PROTOCOL_REVISION: u32 = 3;
// Version 7 includes the Advisor enabled switch while retaining its saved model.
pub const APP_SERVER_CAPABILITY_VERSION: u32 = 7;

pub const REQUIRED_SESSION_CAPABILITIES: &[CapabilityRequirement] = &[
    CapabilityRequirement::exact("sessions", APP_SERVER_CAPABILITY_VERSION),
    CapabilityRequirement::exact("threads", APP_SERVER_CAPABILITY_VERSION),
    CapabilityRequirement::exact("turns", APP_SERVER_CAPABILITY_VERSION),
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
    pub revision: u32,
}

impl ProtocolVersion {
    pub const fn current() -> Self {
        Self {
            major: APP_SERVER_PROTOCOL_MAJOR,
            revision: APP_SERVER_PROTOCOL_REVISION,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityContract {
    pub version: u32,
}

impl CapabilityContract {
    pub const fn current() -> Self {
        Self {
            version: APP_SERVER_CAPABILITY_VERSION,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityRequirement {
    pub name: &'static str,
    pub min_version: u32,
    pub max_version: u32,
}

impl CapabilityRequirement {
    pub const fn exact(name: &'static str, version: u32) -> Self {
        Self {
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
    MissingCapability {
        name: &'static str,
        min_version: u32,
        max_version: u32,
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
            Self::MissingCapability {
                name,
                min_version,
                max_version,
            } => write!(
                formatter,
                "required App Server capability {name} is missing; client supports versions {min_version}..={max_version}"
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
    for requirement in requirements {
        if matches!(
            initialized.capabilities.is_enabled(requirement.name),
            Some(false)
        ) {
            return Err(ProtocolCompatibilityError::MissingCapability {
                name: requirement.name,
                min_version: requirement.min_version,
                max_version: requirement.max_version,
            });
        }
        let Some(contract) = initialized.capabilities.contracts.get(requirement.name) else {
            return Err(ProtocolCompatibilityError::MissingCapability {
                name: requirement.name,
                min_version: requirement.min_version,
                max_version: requirement.max_version,
            });
        };
        if contract.version < requirement.min_version || contract.version > requirement.max_version
        {
            return Err(ProtocolCompatibilityError::CapabilityVersion {
                name: requirement.name,
                min_version: requirement.min_version,
                max_version: requirement.max_version,
                received: contract.version,
            });
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
    pub resources: bool,
    pub attachments: bool,
    pub file_system: bool,
    pub git: bool,
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
            "resources" => Some(self.resources),
            "attachments" => Some(self.attachments),
            "fileSystem" => Some(self.file_system),
            "git" => Some(self.git),
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
        let capabilities = [
            ("agentInteractions", self.agent_interactions),
            ("documentCollaboration", self.document_collaboration),
            ("sessions", self.sessions),
            ("threads", self.threads),
            ("turns", self.turns),
            ("projects", self.projects),
            ("memories", self.memories),
            ("resources", self.resources),
            ("attachments", self.attachments),
            ("fileSystem", self.file_system),
            ("git", self.git),
            ("contentSearch", self.content_search),
            ("codebase", self.codebase),
            ("cloudCodebase", self.cloud_codebase),
            ("terminal", self.terminal),
            ("debugAdapter", self.debug_adapter),
            ("typst", self.typst),
            ("updateReplay", self.update_replay),
            ("extensions", self.extensions),
            ("extensionHost", self.extension_host),
            ("connectors", self.connectors),
            ("plugins", self.plugins),
            ("marketplace", self.marketplace),
            ("mcp", self.mcp),
            ("mcpOAuth", self.mcp_oauth),
        ];
        self.contracts = capabilities
            .into_iter()
            .filter(|(_, available)| *available)
            .map(|(name, _)| (name.into(), CapabilityContract::current()))
            .collect();
        if self.marketplace {
            self.contracts.insert(
                "marketplaceSearch".into(),
                CapabilityContract { version: 1 },
            );
        }
    }
}
