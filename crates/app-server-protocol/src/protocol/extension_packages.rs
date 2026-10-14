use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsPackageRefDto {
    /// Source-qualified plugin identity: `<name>@<extension_packages>`.
    pub id: String,
    pub version: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsArtifactHandleDto {
    pub id: String,
    pub package: ExtensionsPackageRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsCapabilityRefDto {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsResourceRefDto {
    pub id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsCapabilityKindDto {
    Skill,
    Mcp,
    Connector,
    Theme,
    Language,
    Localization,
    Executable,
    EditorExtension,
    Asset,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsCapabilityDescriptorDto {
    pub reference: ExtensionsCapabilityRefDto,
    pub kind: ExtensionsCapabilityKindDto,
    pub id: String,
    pub contract_version: String,
    pub permissions: Vec<String>,
    pub authentication_provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsAvailableCapabilityDto {
    pub kind: ExtensionsCapabilityKindDto,
    pub id: String,
    pub contract_version: String,
    pub permissions: Vec<String>,
    pub authentication_provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsPackageSummaryDto {
    /// Source-qualified plugin identity returned unchanged to lifecycle requests.
    pub id: String,
    pub version: String,
    pub package_type: String,
    pub display_name: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSearchParams {
    pub query: String,
    pub package_type: Option<String>,
    pub capability_kind: Option<ExtensionsCapabilityKindDto>,
    /// Requires a signed language-server route, excluding static-only language resources.
    pub language_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSearchResult {
    #[serde(default)]
    pub unavailable_sources: Vec<String>,
    pub packages: Vec<ExtensionsPackageSummaryDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSearchPageParams {
    pub source_id: String,
    pub query: String,
    pub package_type: Option<String>,
    pub capability_kind: Option<ExtensionsCapabilityKindDto>,
    pub language_id: Option<String>,
    pub page_size: u32,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSearchPageResult {
    pub packages: Vec<ExtensionsPackageSummaryDto>,
    pub total: u64,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsGetParams {
    /// Exact `<name>@<extension_packages>` returned by search; unqualified names are rejected.
    pub package_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsPackageDetailsDto {
    pub package: ExtensionsPackageRefDto,
    pub package_type: String,
    pub display_name: String,
    pub description: String,
    pub license: String,
    pub source: ExtensionsPackageSourceDto,
    pub upstream: Option<ExtensionsUpstreamReferenceDto>,
    pub capabilities: Vec<ExtensionsAvailableCapabilityDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsPackageSourceDto {
    Official,
    ThirdParty,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsUpstreamRegistryDto {
    OfficialMcp,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsUpstreamReferenceDto {
    pub registry: ExtensionsUpstreamRegistryDto,
    pub name: String,
    pub version: String,
    pub record_url: String,
    pub repository_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsDownloadParams {
    /// Exact `<name>@<extension_packages>` returned by search; unqualified names are rejected.
    pub package_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsInstallParams {
    /// Exact `<name>@<extension_packages>` returned by search; unqualified names are rejected.
    pub package_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsUpdateParams {
    pub installation_id: String,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsInstallationStateDto {
    Installed,
    PendingRemoval,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsInstalledPackageDto {
    pub installation_id: String,
    pub package: ExtensionsPackageRefDto,
    pub state: ExtensionsInstallationStateDto,
    pub capabilities: Vec<ExtensionsCapabilityDescriptorDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsListInstalledResult {
    pub instance_id: String,
    #[ts(type = "number")]
    pub generation: u64,
    pub packages: Vec<ExtensionsInstalledPackageDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsEditorExtensionPolicyActionDto {
    Enable,
    Disable,
    Grant,
    Revoke,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsEditorExtensionPolicyParams {
    pub installation_id: String,
    pub package_digest: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub action: ExtensionsEditorExtensionPolicyActionDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsEditorExtensionPolicyDto {
    pub installation_id: String,
    pub package: ExtensionsPackageRefDto,
    /// Entry selection does not promise API compatibility. Missing entries remain resources-only.
    pub entrypoint: Option<String>,
    pub enabled: bool,
    pub granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsEditorExtensionsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub extensions: Vec<ExtensionsEditorExtensionPolicyDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionsBuiltInProviderEnablementParams {
    pub id: String,
    pub enabled: bool,
    #[ts(type = "number")]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsBuiltInProviderDto {
    pub id: String,
    pub enabled: bool,
    pub running: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsBuiltInProvidersResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub providers: Vec<ExtensionsBuiltInProviderDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsChanged {
    pub instance_id: String,
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsUninstallModeDto {
    IfUnused,
    WhenUnused,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsUninstallParams {
    pub installation_id: String,
    pub mode: ExtensionsUninstallModeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsAcquireCapabilityParams {
    pub capability: ExtensionsCapabilityRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsCapabilityLeaseDto {
    pub id: String,
    pub capability: ExtensionsCapabilityRefDto,
    pub installation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtensionsActivationSpecDto {
    Skill(ExtensionsSkillActivationSpecDto),
    Mcp(ExtensionsMcpActivationSpecDto),
    Connector(ExtensionsConnectorActivationSpecDto),
    Theme(ExtensionsThemeActivationSpecDto),
    Language(ExtensionsLanguageActivationSpecDto),
    Localization(ExtensionsLocalizationActivationSpecDto),
    Executable(ExtensionsExecutableActivationSpecDto),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSkillActivationSpecDto {
    pub contract_version: String,
    pub resource: ExtensionsResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsMcpActivationSpecDto {
    pub contract_version: String,
    pub transport: ExtensionsMcpTransportDto,
    pub network_hosts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExtensionsMcpTransportDto {
    Stdio {
        executable: ExtensionsResourceRefDto,
        args: Vec<String>,
    },
    StreamableHttp {
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsConnectorActivationSpecDto {
    pub contract_version: String,
    pub authentication_provider: Option<String>,
    pub mcp: Option<ExtensionsCapabilityRefDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsThemeActivationSpecDto {
    pub contract_version: String,
    pub manifest: ExtensionsResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsLanguageActivationSpecDto {
    pub contract_version: String,
    pub manifest: ExtensionsResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsLocalizationActivationSpecDto {
    pub contract_version: String,
    pub catalog: ExtensionsResourceRefDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionsExecutableRuntimeDto {
    Direct,
    Node,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsExecutableActivationSpecDto {
    pub contract_version: String,
    pub runtime: ExtensionsExecutableRuntimeDto,
    pub entrypoint: ExtensionsResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsAcquiredCapabilityDto {
    pub lease: ExtensionsCapabilityLeaseDto,
    pub spec: ExtensionsActivationSpecDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsReleaseCapabilityParams {
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsOpenResourceParams {
    pub lease_id: String,
    pub resource: ExtensionsResourceRefDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsResourceContentDto {
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionRegistryKindDto {
    OpenVsx,
    Ash,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSourceDto {
    pub id: String,
    pub kind: ExtensionRegistryKindDto,
    pub enabled: bool,
    pub product_owned: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSourcesResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub sources: Vec<ExtensionsSourceDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionsAddSourceParams {
    pub source_id: String,
    pub metadata_base_url: String,
    pub targets_base_url: String,
    pub trusted_root_json: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionsSetSourceEnabledParams {
    pub source_id: String,
    pub enabled: bool,
    #[ts(type = "number")]
    pub expected_revision: u64,
}
