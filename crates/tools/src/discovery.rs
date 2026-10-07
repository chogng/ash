use std::fmt;

const MAX_DISCOVERY_TEXT_BYTES: usize = 4 * 1024;

/// Stable opaque identity for one catalog-only discovery candidate.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CapabilityDiscoveryId(String);

impl CapabilityDiscoveryId {
    pub fn new(value: impl Into<String>) -> Result<Self, DiscoveryValueError> {
        let value = value.into();
        validate_text("capability discovery ID", &value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Side effect that an authority may offer for a discoverable candidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscoveryAction {
    Install,
    Enable,
    Connect,
}

/// Indicates which contribution families a discovery projection advertises.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiscoverableContributionKinds {
    pub skills: bool,
    pub tools: bool,
    pub connectors: bool,
}

/// Catalog projection for a Plugin that is not currently executable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoverablePluginInfo {
    pub id: CapabilityDiscoveryId,
    pub display_name: String,
    pub description: String,
    pub contributions: DiscoverableContributionKinds,
    pub action: DiscoveryAction,
}

/// Catalog projection for a Connector account or remote integration that is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoverableConnectorInfo {
    pub id: CapabilityDiscoveryId,
    pub display_name: String,
    pub description: String,
    pub action: DiscoveryAction,
}

/// A discovery candidate that deliberately cannot be converted into `ToolDefinition`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiscoverableCapability {
    Plugin(DiscoverablePluginInfo),
    Connector(DiscoverableConnectorInfo),
}

impl DiscoverableCapability {
    pub fn id(&self) -> &CapabilityDiscoveryId {
        match self {
            Self::Plugin(info) => &info.id,
            Self::Connector(info) => &info.id,
        }
    }

    pub fn action(&self) -> DiscoveryAction {
        match self {
            Self::Plugin(info) => info.action,
            Self::Connector(info) => info.action,
        }
    }

    pub fn validate(&self) -> Result<(), DiscoveryValueError> {
        match self {
            Self::Plugin(info) => {
                validate_text("Plugin display name", &info.display_name)?;
                validate_text("Plugin description", &info.description)
            }
            Self::Connector(info) => {
                validate_text("Connector display name", &info.display_name)?;
                validate_text("Connector description", &info.description)
            }
        }
    }
}

/// Client support used to filter discovery actions without matching product names.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiscoveryClientCapabilities {
    pub install_plugins: bool,
    pub enable_plugins: bool,
    pub connect_accounts: bool,
}

impl DiscoveryClientCapabilities {
    pub fn supports(self, action: DiscoveryAction) -> bool {
        match action {
            DiscoveryAction::Install => self.install_plugins,
            DiscoveryAction::Enable => self.enable_plugins,
            DiscoveryAction::Connect => self.connect_accounts,
        }
    }
}

/// Immutable, generation-bound read model supplied by the Plugin/Connector authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityDiscoverySnapshot {
    generation: u64,
    candidates: Vec<DiscoverableCapability>,
}

impl CapabilityDiscoverySnapshot {
    pub fn new(
        generation: u64,
        mut candidates: Vec<DiscoverableCapability>,
    ) -> Result<Self, DiscoveryValueError> {
        for candidate in &candidates {
            candidate.validate()?;
        }
        candidates.sort_by(|left, right| left.id().cmp(right.id()));
        if candidates
            .windows(2)
            .any(|window| window[0].id() == window[1].id())
        {
            return Err(DiscoveryValueError(
                "discovery snapshot contains a duplicate candidate ID".into(),
            ));
        }
        Ok(Self {
            generation,
            candidates,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn candidates(&self) -> &[DiscoverableCapability] {
        &self.candidates
    }

    pub fn visible_to(
        &self,
        capabilities: DiscoveryClientCapabilities,
    ) -> impl Iterator<Item = &DiscoverableCapability> {
        self.candidates
            .iter()
            .filter(move |candidate| capabilities.supports(candidate.action()))
    }

    pub fn request(
        &self,
        id: &CapabilityDiscoveryId,
    ) -> Result<CapabilityDiscoveryRequest, DiscoveryValueError> {
        let candidate = self
            .candidates
            .iter()
            .find(|candidate| candidate.id() == id)
            .ok_or_else(|| DiscoveryValueError("discovery candidate is unavailable".into()))?;
        Ok(CapabilityDiscoveryRequest {
            snapshot_generation: self.generation,
            candidate_id: id.clone(),
            action: candidate.action(),
        })
    }
}

/// Typed intent that an authority must revalidate before installation, enablement, or connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityDiscoveryRequest {
    pub snapshot_generation: u64,
    pub candidate_id: CapabilityDiscoveryId,
    pub action: DiscoveryAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryValueError(String);

impl fmt::Display for DiscoveryValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DiscoveryValueError {}

fn validate_text(kind: &str, value: &str) -> Result<(), DiscoveryValueError> {
    if value.trim().is_empty() {
        return Err(DiscoveryValueError(format!("{kind} must not be empty")));
    }
    if value.len() > MAX_DISCOVERY_TEXT_BYTES {
        return Err(DiscoveryValueError(format!(
            "{kind} exceeds {MAX_DISCOVERY_TEXT_BYTES} bytes"
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
