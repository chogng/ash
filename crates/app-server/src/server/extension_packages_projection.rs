use ash_app_server_protocol::protocol::extension_packages::ExtensionsAcquiredCapabilityDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsArtifactHandleDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsAvailableCapabilityDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsCapabilityDescriptorDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsCapabilityKindDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsCapabilityLeaseDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsCapabilityRefDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsConnectorActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsExecutableActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsExecutableRuntimeDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsInstallationStateDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsInstalledPackageDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsLanguageActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsLocalizationActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsMcpActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsMcpTransportDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsPackageDetailsDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsPackageRefDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsPackageSourceDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsPackageSummaryDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsResourceContentDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsResourceRefDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsSearchResult;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsSkillActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsThemeActivationSpecDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUpstreamReferenceDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUpstreamRegistryDto;
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

pub(super) fn search_result(value: SearchPackagesResult) -> ExtensionsSearchResult {
    ExtensionsSearchResult {
        unavailable_sources: value.unavailable_sources,
        packages: value.packages.into_iter().map(package_summary).collect(),
    }
}

pub(super) fn package_details(value: PackageDetails) -> ExtensionsPackageDetailsDto {
    ExtensionsPackageDetailsDto {
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

fn package_source(value: PackageSource) -> ExtensionsPackageSourceDto {
    match value {
        PackageSource::Official => ExtensionsPackageSourceDto::Official,
        PackageSource::ThirdParty => ExtensionsPackageSourceDto::ThirdParty,
    }
}

fn upstream_reference(value: UpstreamReference) -> ExtensionsUpstreamReferenceDto {
    ExtensionsUpstreamReferenceDto {
        registry: match value.registry {
            UpstreamRegistry::OfficialMcp => ExtensionsUpstreamRegistryDto::OfficialMcp,
        },
        name: value.name,
        version: value.version,
        record_url: value.record_url,
        repository_url: value.repository_url,
    }
}

pub(super) fn artifact_handle(value: ArtifactHandle) -> ExtensionsArtifactHandleDto {
    ExtensionsArtifactHandleDto {
        id: value.id,
        package: package_ref(value.package),
    }
}

pub(super) fn installed_package(value: InstalledPackage) -> ExtensionsInstalledPackageDto {
    ExtensionsInstalledPackageDto {
        installation_id: value.installation_id,
        package: package_ref(value.package),
        state: match value.state {
            InstallationState::Installed => ExtensionsInstallationStateDto::Installed,
            InstallationState::PendingRemoval => ExtensionsInstallationStateDto::PendingRemoval,
        },
        capabilities: value
            .capabilities
            .into_iter()
            .map(capability_descriptor)
            .collect(),
    }
}

pub(super) fn acquired_capability(value: AcquiredCapability) -> ExtensionsAcquiredCapabilityDto {
    ExtensionsAcquiredCapabilityDto {
        lease: capability_lease(value.lease),
        spec: activation_spec(value.spec),
    }
}

pub(super) fn resource_content(value: ResourceContent) -> ExtensionsResourceContentDto {
    ExtensionsResourceContentDto {
        media_type: value.media_type,
        data_base64: value.data_base64,
    }
}

pub(super) fn package_summary(value: PackageSummary) -> ExtensionsPackageSummaryDto {
    ExtensionsPackageSummaryDto {
        id: value.id,
        version: value.version,
        package_type: value.package_type,
        display_name: value.display_name,
        description: value.description,
    }
}

pub(super) fn package_ref(value: PackageRef) -> ExtensionsPackageRefDto {
    ExtensionsPackageRefDto {
        id: value.id,
        version: value.version,
        digest: value.digest,
    }
}

fn capability_ref(value: CapabilityRef) -> ExtensionsCapabilityRefDto {
    ExtensionsCapabilityRefDto { id: value.id }
}

fn resource_ref(value: ResourceRef) -> ExtensionsResourceRefDto {
    ExtensionsResourceRefDto { id: value.id }
}

fn capability_kind(value: CapabilityKind) -> ExtensionsCapabilityKindDto {
    match value {
        CapabilityKind::Skill => ExtensionsCapabilityKindDto::Skill,
        CapabilityKind::Mcp => ExtensionsCapabilityKindDto::Mcp,
        CapabilityKind::Connector => ExtensionsCapabilityKindDto::Connector,
        CapabilityKind::Theme => ExtensionsCapabilityKindDto::Theme,
        CapabilityKind::Language => ExtensionsCapabilityKindDto::Language,
        CapabilityKind::Localization => ExtensionsCapabilityKindDto::Localization,
        CapabilityKind::Executable => ExtensionsCapabilityKindDto::Executable,
        CapabilityKind::EditorExtension => ExtensionsCapabilityKindDto::EditorExtension,
        CapabilityKind::Asset => ExtensionsCapabilityKindDto::Asset,
    }
}

pub(super) fn domain_capability_kind(value: ExtensionsCapabilityKindDto) -> CapabilityKind {
    match value {
        ExtensionsCapabilityKindDto::Skill => CapabilityKind::Skill,
        ExtensionsCapabilityKindDto::Mcp => CapabilityKind::Mcp,
        ExtensionsCapabilityKindDto::Connector => CapabilityKind::Connector,
        ExtensionsCapabilityKindDto::Theme => CapabilityKind::Theme,
        ExtensionsCapabilityKindDto::Language => CapabilityKind::Language,
        ExtensionsCapabilityKindDto::Localization => CapabilityKind::Localization,
        ExtensionsCapabilityKindDto::Executable => CapabilityKind::Executable,
        ExtensionsCapabilityKindDto::EditorExtension => CapabilityKind::EditorExtension,
        ExtensionsCapabilityKindDto::Asset => CapabilityKind::Asset,
    }
}

fn capability_descriptor(value: CapabilityDescriptor) -> ExtensionsCapabilityDescriptorDto {
    ExtensionsCapabilityDescriptorDto {
        reference: capability_ref(value.reference),
        kind: capability_kind(value.kind),
        id: value.id,
        contract_version: value.contract_version,
        permissions: value.permissions,
        authentication_provider: value.authentication_provider,
    }
}

fn available_capability(value: AvailableCapability) -> ExtensionsAvailableCapabilityDto {
    ExtensionsAvailableCapabilityDto {
        kind: capability_kind(value.kind),
        id: value.id,
        contract_version: value.contract_version,
        permissions: value.permissions,
        authentication_provider: value.authentication_provider,
    }
}

fn capability_lease(value: CapabilityLease) -> ExtensionsCapabilityLeaseDto {
    ExtensionsCapabilityLeaseDto {
        id: value.id,
        capability: capability_ref(value.capability),
        installation_id: value.installation_id,
    }
}

fn activation_spec(value: ActivationSpec) -> ExtensionsActivationSpecDto {
    match value {
        ActivationSpec::Skill(value) => ExtensionsActivationSpecDto::Skill(skill_activation(value)),
        ActivationSpec::Mcp(value) => ExtensionsActivationSpecDto::Mcp(mcp_activation(value)),
        ActivationSpec::Connector(value) => {
            ExtensionsActivationSpecDto::Connector(connector_activation(value))
        }
        ActivationSpec::Theme(value) => ExtensionsActivationSpecDto::Theme(theme_activation(value)),
        ActivationSpec::Language(value) => {
            ExtensionsActivationSpecDto::Language(language_activation(value))
        }
        ActivationSpec::Localization(value) => {
            ExtensionsActivationSpecDto::Localization(localization_activation(value))
        }
        ActivationSpec::Executable(value) => {
            ExtensionsActivationSpecDto::Executable(executable_activation(value))
        }
    }
}

fn skill_activation(value: SkillActivationSpec) -> ExtensionsSkillActivationSpecDto {
    ExtensionsSkillActivationSpecDto {
        contract_version: value.contract_version,
        resource: resource_ref(value.resource),
    }
}

fn mcp_activation(value: McpActivationSpec) -> ExtensionsMcpActivationSpecDto {
    ExtensionsMcpActivationSpecDto {
        contract_version: value.contract_version,
        transport: match value.transport {
            McpTransportSpec::Stdio { executable, args } => ExtensionsMcpTransportDto::Stdio {
                executable: resource_ref(executable),
                args,
            },
            McpTransportSpec::StreamableHttp { url } => {
                ExtensionsMcpTransportDto::StreamableHttp { url }
            }
        },
        network_hosts: value.network_hosts,
    }
}

fn connector_activation(value: ConnectorActivationSpec) -> ExtensionsConnectorActivationSpecDto {
    ExtensionsConnectorActivationSpecDto {
        contract_version: value.contract_version,
        authentication_provider: value.authentication_provider,
        mcp: value.mcp.map(capability_ref),
    }
}

fn theme_activation(value: ThemeActivationSpec) -> ExtensionsThemeActivationSpecDto {
    ExtensionsThemeActivationSpecDto {
        contract_version: value.contract_version,
        manifest: resource_ref(value.manifest),
    }
}

fn language_activation(value: LanguageActivationSpec) -> ExtensionsLanguageActivationSpecDto {
    ExtensionsLanguageActivationSpecDto {
        contract_version: value.contract_version,
        manifest: resource_ref(value.manifest),
    }
}

fn localization_activation(
    value: LocalizationActivationSpec,
) -> ExtensionsLocalizationActivationSpecDto {
    ExtensionsLocalizationActivationSpecDto {
        contract_version: value.contract_version,
        catalog: resource_ref(value.catalog),
    }
}

fn executable_activation(value: ExecutableActivationSpec) -> ExtensionsExecutableActivationSpecDto {
    ExtensionsExecutableActivationSpecDto {
        contract_version: value.contract_version,
        runtime: match value.runtime {
            ExecutableRuntime::Direct => ExtensionsExecutableRuntimeDto::Direct,
            ExecutableRuntime::Node => ExtensionsExecutableRuntimeDto::Node,
        },
        entrypoint: resource_ref(value.entrypoint),
    }
}
