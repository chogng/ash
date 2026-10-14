//! Exact, temporary grants requested by the Agent and approved through the current Turn owner.
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use ts_rs::TS;

/// Permission kind that can be granted for one directory scope.
#[derive(
    Clone,
    Copy,
    Debug,
    Deserialize,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    schemars::JsonSchema,
    ts_rs::TS,
)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryCapability {
    ReadFiles,
    WriteFiles,
    ExecuteCommands,
    WatchFiles,
    BrowseFiles,
    SearchFiles,
    LoadInstructions,
    LoadConfig,
    DiscoverSkills,
    DiscoverMcp,
    UseLanguageServices,
    DiscoverHooks,
    DiscoverPlugins,
    InspectRepository,
    MutateRepository,
}

impl DirectoryCapability {
    pub const ALL: [Self; 15] = [
        Self::ReadFiles,
        Self::WriteFiles,
        Self::ExecuteCommands,
        Self::WatchFiles,
        Self::BrowseFiles,
        Self::SearchFiles,
        Self::LoadInstructions,
        Self::LoadConfig,
        Self::DiscoverSkills,
        Self::DiscoverMcp,
        Self::UseLanguageServices,
        Self::DiscoverHooks,
        Self::DiscoverPlugins,
        Self::InspectRepository,
        Self::MutateRepository,
    ];
}

impl fmt::Display for DirectoryCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ReadFiles => "read files",
            Self::WriteFiles => "write files",
            Self::ExecuteCommands => "execute commands",
            Self::WatchFiles => "watch files",
            Self::BrowseFiles => "browse files",
            Self::SearchFiles => "search files",
            Self::LoadInstructions => "load instructions",
            Self::LoadConfig => "load configuration",
            Self::DiscoverSkills => "discover skills",
            Self::DiscoverMcp => "discover MCP servers",
            Self::UseLanguageServices => "use language services",
            Self::DiscoverHooks => "discover hooks",
            Self::DiscoverPlugins => "discover plugins",
            Self::InspectRepository => "inspect a repository",
            Self::MutateRepository => "mutate a repository",
        })
    }
}

/// Maximum lifetime of an approved grant. Session grants are not durable across host restarts.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PermissionGrantDuration {
    Turn,
    Session,
}

/// Requested capabilities for one exact directory in the named execution environment.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestedDirectoryGrant {
    pub path: String,
    pub permissions: Vec<DirectoryCapability>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRequest {
    pub environment_id: String,
    pub duration: PermissionGrantDuration,
    pub directories: Vec<RequestedDirectoryGrant>,
    pub network_hosts: Vec<String>,
    pub reason: String,
}

/// The user can approve any subset and shorten the requested lifetime. Empty sets decline.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionResponse {
    pub duration: PermissionGrantDuration,
    pub directories: Vec<RequestedDirectoryGrant>,
    pub network_hosts: Vec<String>,
}

impl PermissionRequest {
    /// Checks persisted or provider-supplied requests before they enter the durable interaction.
    pub fn validate(&self) -> Result<(), String> {
        if self.environment_id.trim().is_empty()
            || self.environment_id.len() > 128
            || self.reason.trim().is_empty()
            || self.reason.len() > 4096
            || self.directories.len() > 16
            || self.network_hosts.len() > 64
            || self.directories.is_empty() && self.network_hosts.is_empty()
        {
            return Err("permission request is empty or exceeds its bounds".into());
        }
        let mut paths = std::collections::BTreeSet::new();
        for entry in &self.directories {
            let absolute = entry.path.starts_with('/')
                || entry.path.starts_with("\\\\")
                || entry.path.as_bytes().get(1) == Some(&b':')
                    && entry
                        .path
                        .as_bytes()
                        .get(2)
                        .is_some_and(|byte| *byte == b'/' || *byte == b'\\');
            if !absolute
                || entry.path.len() > 4096
                || entry.path.contains('\0')
                || !paths.insert(&entry.path)
                || entry.permissions.is_empty()
                || entry.permissions.len() > DirectoryCapability::ALL.len()
                || entry
                    .permissions
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != entry.permissions.len()
            {
                return Err("permission directory is invalid or duplicated".into());
            }
        }
        let mut hosts = std::collections::BTreeSet::new();
        if self.network_hosts.iter().any(|host| {
            host.is_empty()
                || host.len() > 253
                || host.contains(['\0', '/', '*'])
                || host.chars().any(char::is_whitespace)
                || !hosts.insert(host)
        }) {
            return Err("permission network hosts are invalid or duplicated".into());
        }
        Ok(())
    }
    /// Validates untrusted response data against the exact durable request, before any lease is issued.
    pub fn accepts(&self, response: &PermissionResponse) -> bool {
        if self.duration == PermissionGrantDuration::Turn && response.duration != self.duration {
            return false;
        }
        if response.directories.len() > self.directories.len()
            || response.network_hosts.len() > self.network_hosts.len()
        {
            return false;
        }
        let mut paths = std::collections::BTreeSet::new();
        response.directories.iter().all(|approved| {
            paths.insert(&approved.path)
                && self.directories.iter().any(|requested| {
                    requested.path == approved.path
                        && approved.permissions.len() <= requested.permissions.len()
                        && approved
                            .permissions
                            .iter()
                            .collect::<std::collections::BTreeSet<_>>()
                            .len()
                            == approved.permissions.len()
                        && approved
                            .permissions
                            .iter()
                            .all(|permission| requested.permissions.contains(permission))
                })
        }) && response
            .network_hosts
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == response.network_hosts.len()
            && response
                .network_hosts
                .iter()
                .all(|host| self.network_hosts.contains(host))
    }
}
