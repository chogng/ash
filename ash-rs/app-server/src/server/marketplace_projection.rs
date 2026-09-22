use ash_app_server_protocol::protocol::marketplace::MarketplaceAcquiredCapabilityDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceArtifactHandleDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceAvailableCapabilityDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityDescriptorDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityKindDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityLeaseDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityRefDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceConnectorActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceExecutableActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceExecutableRuntimeDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstallationStateDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstalledPackageDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceLanguageActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceLocalizationActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceMcpActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceMcpTransportDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageDetailsDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageRefDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageSourceDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageSummaryDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceResourceContentDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceResourceRefDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchResult;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSkillActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceThemeActivationSpecDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUpstreamReferenceDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUpstreamRegistryDto;
use ash_core_plugins::AcquiredCapability;
use ash_core_plugins::ActivationSpec;
use ash_core_plugins::ArtifactHandle;
use ash_core_plugins::AvailableCapability;
use ash_core_plugins::CapabilityDescriptor;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::CapabilityLease;
use ash_core_plugins::CapabilityRef;
use ash_core_plugins::ConnectorActivationSpec;
use ash_core_plugins::ExecutableActivationSpec;
use ash_core_plugins::ExecutableRuntime;
use ash_core_plugins::InstallationState;
use ash_core_plugins::InstalledPackage;
use ash_core_plugins::LanguageActivationSpec;
use ash_core_plugins::LocalizationActivationSpec;
use ash_core_plugins::McpActivationSpec;
use ash_core_plugins::McpTransportSpec;
use ash_core_plugins::PackageDetails;
use ash_core_plugins::PackageRef;
use ash_core_plugins::PackageSource;
use ash_core_plugins::PackageSummary;
use ash_core_plugins::ResourceContent;
use ash_core_plugins::ResourceRef;
use ash_core_plugins::SearchPackagesResult;
use ash_core_plugins::SkillActivationSpec;
use ash_core_plugins::ThemeActivationSpec;
use ash_core_plugins::UpstreamReference;
use ash_core_plugins::UpstreamRegistry;

pub(super) fn search_result(value: SearchPackagesResult) -> MarketplaceSearchResult {
    MarketplaceSearchResult {
        packages: value.packages.into_iter().map(package_summary).collect(),
    }
}

pub(super) fn package_details(value: PackageDetails) -> MarketplacePackageDetailsDto {
    MarketplacePackageDetailsDto {
        package: package_ref(value.package),
        package_type: value.package_type,
        display_name: value.display_name,
        description: value.description,
        license: value.license,
        source: package_source(value.source),
        upstream: value.upstream.map(upstream_reference),
        capabilities: value
            .capabilities
            .into_iter()
            .map(available_capability)
            .collect(),
    }
}

fn package_source(value: PackageSource) -> MarketplacePackageSourceDto {
    match value {
        PackageSource::Official => MarketplacePackageSourceDto::Official,
        PackageSource::ThirdParty => MarketplacePackageSourceDto::ThirdParty,
    }
}

fn upstream_reference(value: UpstreamReference) -> MarketplaceUpstreamReferenceDto {
    MarketplaceUpstreamReferenceDto {
        registry: match value.registry {
            UpstreamRegistry::OfficialMcp => MarketplaceUpstreamRegistryDto::OfficialMcp,
        },
        name: value.name,
        version: value.version,
        record_url: value.record_url,
        repository_url: value.repository_url,
    }
}

pub(super) fn artifact_handle(value: ArtifactHandle) -> MarketplaceArtifactHandleDto {
    MarketplaceArtifactHandleDto {
        id: value.id,
        package: package_ref(value.package),
    }
}

pub(super) fn installed_package(value: InstalledPackage) -> MarketplaceInstalledPackageDto {
    MarketplaceInstalledPackageDto {
        installation_id: value.installation_id,
        package: package_ref(value.package),
        state: match value.state {
            InstallationState::Installed => MarketplaceInstallationStateDto::Installed,
            InstallationState::PendingRemoval => MarketplaceInstallationStateDto::PendingRemoval,
        },
        capabilities: value
            .capabilities
            .into_iter()
            .map(capability_descriptor)
            .collect(),
    }
}

pub(super) fn acquired_capability(value: AcquiredCapability) -> MarketplaceAcquiredCapabilityDto {
    MarketplaceAcquiredCapabilityDto {
        lease: capability_lease(value.lease),
        spec: activation_spec(value.spec),
    }
}

pub(super) fn resource_content(value: ResourceContent) -> MarketplaceResourceContentDto {
    MarketplaceResourceContentDto {
        media_type: value.media_type,
        data_base64: value.data_base64,
    }
}

fn package_summary(value: PackageSummary) -> MarketplacePackageSummaryDto {
    MarketplacePackageSummaryDto {
        id: value.id,
        version: value.version,
        package_type: value.package_type,
        display_name: value.display_name,
        description: value.description,
    }
}

fn package_ref(value: PackageRef) -> MarketplacePackageRefDto {
    MarketplacePackageRefDto {
        id: value.id,
        version: value.version,
        digest: value.digest,
    }
}

fn capability_ref(value: CapabilityRef) -> MarketplaceCapabilityRefDto {
    MarketplaceCapabilityRefDto { id: value.id }
}

fn resource_ref(value: ResourceRef) -> MarketplaceResourceRefDto {
    MarketplaceResourceRefDto { id: value.id }
}

fn capability_kind(value: CapabilityKind) -> MarketplaceCapabilityKindDto {
    match value {
        CapabilityKind::Skill => MarketplaceCapabilityKindDto::Skill,
        CapabilityKind::Mcp => MarketplaceCapabilityKindDto::Mcp,
        CapabilityKind::Connector => MarketplaceCapabilityKindDto::Connector,
        CapabilityKind::Theme => MarketplaceCapabilityKindDto::Theme,
        CapabilityKind::Language => MarketplaceCapabilityKindDto::Language,
        CapabilityKind::Localization => MarketplaceCapabilityKindDto::Localization,
        CapabilityKind::Executable => MarketplaceCapabilityKindDto::Executable,
        CapabilityKind::Asset => MarketplaceCapabilityKindDto::Asset,
    }
}

pub(super) fn domain_capability_kind(value: MarketplaceCapabilityKindDto) -> CapabilityKind {
    match value {
        MarketplaceCapabilityKindDto::Skill => CapabilityKind::Skill,
        MarketplaceCapabilityKindDto::Mcp => CapabilityKind::Mcp,
        MarketplaceCapabilityKindDto::Connector => CapabilityKind::Connector,
        MarketplaceCapabilityKindDto::Theme => CapabilityKind::Theme,
        MarketplaceCapabilityKindDto::Language => CapabilityKind::Language,
        MarketplaceCapabilityKindDto::Localization => CapabilityKind::Localization,
        MarketplaceCapabilityKindDto::Executable => CapabilityKind::Executable,
        MarketplaceCapabilityKindDto::Asset => CapabilityKind::Asset,
    }
}

fn capability_descriptor(value: CapabilityDescriptor) -> MarketplaceCapabilityDescriptorDto {
    MarketplaceCapabilityDescriptorDto {
        reference: capability_ref(value.reference),
        kind: capability_kind(value.kind),
        id: value.id,
        contract_version: value.contract_version,
        permissions: value.permissions,
        authentication_provider: value.authentication_provider,
    }
}

fn available_capability(value: AvailableCapability) -> MarketplaceAvailableCapabilityDto {
    MarketplaceAvailableCapabilityDto {
        kind: capability_kind(value.kind),
        id: value.id,
        contract_version: value.contract_version,
        permissions: value.permissions,
        authentication_provider: value.authentication_provider,
    }
}

fn capability_lease(value: CapabilityLease) -> MarketplaceCapabilityLeaseDto {
    MarketplaceCapabilityLeaseDto {
        id: value.id,
        capability: capability_ref(value.capability),
        installation_id: value.installation_id,
    }
}

fn activation_spec(value: ActivationSpec) -> MarketplaceActivationSpecDto {
    match value {
        ActivationSpec::Skill(value) => {
            MarketplaceActivationSpecDto::Skill(skill_activation(value))
        }
        ActivationSpec::Mcp(value) => MarketplaceActivationSpecDto::Mcp(mcp_activation(value)),
        ActivationSpec::Connector(value) => {
            MarketplaceActivationSpecDto::Connector(connector_activation(value))
        }
        ActivationSpec::Theme(value) => {
            MarketplaceActivationSpecDto::Theme(theme_activation(value))
        }
        ActivationSpec::Language(value) => {
            MarketplaceActivationSpecDto::Language(language_activation(value))
        }
        ActivationSpec::Localization(value) => {
            MarketplaceActivationSpecDto::Localization(localization_activation(value))
        }
        ActivationSpec::Executable(value) => {
            MarketplaceActivationSpecDto::Executable(executable_activation(value))
        }
    }
}

fn skill_activation(value: SkillActivationSpec) -> MarketplaceSkillActivationSpecDto {
    MarketplaceSkillActivationSpecDto {
        contract_version: value.contract_version,
        resource: resource_ref(value.resource),
    }
}

fn mcp_activation(value: McpActivationSpec) -> MarketplaceMcpActivationSpecDto {
    MarketplaceMcpActivationSpecDto {
        contract_version: value.contract_version,
        transport: match value.transport {
            McpTransportSpec::Stdio { executable, args } => MarketplaceMcpTransportDto::Stdio {
                executable: resource_ref(executable),
                args,
            },
            McpTransportSpec::StreamableHttp { url } => {
                MarketplaceMcpTransportDto::StreamableHttp { url }
            }
        },
        network_hosts: value.network_hosts,
    }
}

fn connector_activation(value: ConnectorActivationSpec) -> MarketplaceConnectorActivationSpecDto {
    MarketplaceConnectorActivationSpecDto {
        contract_version: value.contract_version,
        authentication_provider: value.authentication_provider,
        mcp: value.mcp.map(capability_ref),
    }
}

fn theme_activation(value: ThemeActivationSpec) -> MarketplaceThemeActivationSpecDto {
    MarketplaceThemeActivationSpecDto {
        contract_version: value.contract_version,
        manifest: resource_ref(value.manifest),
    }
}

fn language_activation(value: LanguageActivationSpec) -> MarketplaceLanguageActivationSpecDto {
    MarketplaceLanguageActivationSpecDto {
        contract_version: value.contract_version,
        manifest: resource_ref(value.manifest),
    }
}

fn localization_activation(
    value: LocalizationActivationSpec,
) -> MarketplaceLocalizationActivationSpecDto {
    MarketplaceLocalizationActivationSpecDto {
        contract_version: value.contract_version,
        catalog: resource_ref(value.catalog),
    }
}

fn executable_activation(
    value: ExecutableActivationSpec,
) -> MarketplaceExecutableActivationSpecDto {
    MarketplaceExecutableActivationSpecDto {
        contract_version: value.contract_version,
        runtime: match value.runtime {
            ExecutableRuntime::Direct => MarketplaceExecutableRuntimeDto::Direct,
            ExecutableRuntime::Node => MarketplaceExecutableRuntimeDto::Node,
        },
        entrypoint: resource_ref(value.entrypoint),
    }
}
