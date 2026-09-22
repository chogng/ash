use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePackageRefDto {
    /// Source-qualified plugin identity: `<name>@<marketplace>`.
    pub id: String,
    pub version: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceArtifactHandleDto {
    pub id: String,
    pub package: MarketplacePackageRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCapabilityRefDto {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceResourceRefDto {
    pub id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarketplaceCapabilityKindDto {
    Skill,
    Mcp,
    Connector,
    Theme,
    Language,
    Localization,
    Executable,
    Asset,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCapabilityDescriptorDto {
    pub reference: MarketplaceCapabilityRefDto,
    pub kind: MarketplaceCapabilityKindDto,
    pub id: String,
    pub contract_version: String,
    pub permissions: Vec<String>,
    pub authentication_provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAvailableCapabilityDto {
    pub kind: MarketplaceCapabilityKindDto,
    pub id: String,
    pub contract_version: String,
    pub permissions: Vec<String>,
    pub authentication_provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePackageSummaryDto {
    /// Source-qualified plugin identity returned unchanged to lifecycle requests.
    pub id: String,
    pub version: String,
    pub package_type: String,
    pub display_name: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSearchParams {
    pub query: String,
    pub package_type: Option<String>,
    pub capability_kind: Option<MarketplaceCapabilityKindDto>,
    /// Requires a signed language-server route, excluding static-only language resources.
    pub language_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSearchResult {
    pub packages: Vec<MarketplacePackageSummaryDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceGetParams {
    /// Exact `<name>@<marketplace>` returned by search; unqualified names are rejected.
    pub package_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePackageDetailsDto {
    pub package: MarketplacePackageRefDto,
    pub package_type: String,
    pub display_name: String,
    pub description: String,
    pub license: String,
    pub source: MarketplacePackageSourceDto,
    pub upstream: Option<MarketplaceUpstreamReferenceDto>,
    pub capabilities: Vec<MarketplaceAvailableCapabilityDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarketplacePackageSourceDto {
    Official,
    ThirdParty,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarketplaceUpstreamRegistryDto {
    OfficialMcp,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceUpstreamReferenceDto {
    pub registry: MarketplaceUpstreamRegistryDto,
    pub name: String,
    pub version: String,
    pub record_url: String,
    pub repository_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDownloadParams {
    /// Exact `<name>@<marketplace>` returned by search; unqualified names are rejected.
    pub package_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceInstallParams {
    /// Exact `<name>@<marketplace>` returned by search; unqualified names are rejected.
    pub package_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceUpdateParams {
    pub installation_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarketplaceInstallationStateDto {
    Installed,
    PendingRemoval,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceInstalledPackageDto {
    pub installation_id: String,
    pub package: MarketplacePackageRefDto,
    pub state: MarketplaceInstallationStateDto,
    pub capabilities: Vec<MarketplaceCapabilityDescriptorDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceListInstalledResult {
    pub instance_id: String,
    #[ts(type = "number")]
    pub generation: u64,
    pub packages: Vec<MarketplaceInstalledPackageDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceChanged {
    pub instance_id: String,
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarketplaceUninstallModeDto {
    IfUnused,
    WhenUnused,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceUninstallParams {
    pub installation_id: String,
    pub mode: MarketplaceUninstallModeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAcquireCapabilityParams {
    pub capability: MarketplaceCapabilityRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCapabilityLeaseDto {
    pub id: String,
    pub capability: MarketplaceCapabilityRefDto,
    pub installation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MarketplaceActivationSpecDto {
    Skill(MarketplaceSkillActivationSpecDto),
    Mcp(MarketplaceMcpActivationSpecDto),
    Connector(MarketplaceConnectorActivationSpecDto),
    Theme(MarketplaceThemeActivationSpecDto),
    Language(MarketplaceLanguageActivationSpecDto),
    Localization(MarketplaceLocalizationActivationSpecDto),
    Executable(MarketplaceExecutableActivationSpecDto),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkillActivationSpecDto {
    pub contract_version: String,
    pub resource: MarketplaceResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceMcpActivationSpecDto {
    pub contract_version: String,
    pub transport: MarketplaceMcpTransportDto,
    pub network_hosts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MarketplaceMcpTransportDto {
    Stdio {
        executable: MarketplaceResourceRefDto,
        args: Vec<String>,
    },
    StreamableHttp {
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceConnectorActivationSpecDto {
    pub contract_version: String,
    pub authentication_provider: Option<String>,
    pub mcp: Option<MarketplaceCapabilityRefDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceThemeActivationSpecDto {
    pub contract_version: String,
    pub manifest: MarketplaceResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLanguageActivationSpecDto {
    pub contract_version: String,
    pub manifest: MarketplaceResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLocalizationActivationSpecDto {
    pub contract_version: String,
    pub catalog: MarketplaceResourceRefDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarketplaceExecutableRuntimeDto {
    Direct,
    Node,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceExecutableActivationSpecDto {
    pub contract_version: String,
    pub runtime: MarketplaceExecutableRuntimeDto,
    pub entrypoint: MarketplaceResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAcquiredCapabilityDto {
    pub lease: MarketplaceCapabilityLeaseDto,
    pub spec: MarketplaceActivationSpecDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceReleaseCapabilityParams {
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceOpenResourceParams {
    pub lease_id: String,
    pub resource: MarketplaceResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceResourceContentDto {
    pub media_type: String,
    pub data_base64: String,
}
