use crate::ActivationSpec;
use crate::CapabilityDescriptor;
use crate::CapabilityKind;
use crate::ConnectorActivationSpec;
use crate::ExecutableActivationSpec;
use crate::ExecutableRuntime;
use crate::LanguageActivationSpec;
use crate::LocalizationActivationSpec;
use crate::McpActivationSpec;
use crate::McpTransportSpec;
use crate::PackageRef;
use crate::ResourceContent;
use crate::ResourceRef;
use crate::SkillActivationSpec;
use crate::ThemeActivationSpec;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use url::Url;

use crate::MarketplaceClientError;
use crate::manager::CapabilityRecord;
use crate::manager::InstallationRecord;
use crate::marketplace_store::Store;
use crate::marketplace_store::opaque_id;

pub(crate) fn descriptor(
    store: &Store,
    package: &PackageRef,
    record: &CapabilityRecord,
) -> Result<CapabilityDescriptor, MarketplaceClientError> {
    let (permissions, authentication_provider) = match record.descriptor.kind {
        CapabilityKind::Mcp => {
            let definition = parse_mcp(store, package, &record.path)?;
            let host = match definition {
                McpDefinition::Http {
                    schema_version,
                    url,
                } if schema_version == 1 && url.starts_with("https://") => Url::parse(&url)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                    .into_iter()
                    .collect(),
                McpDefinition::Stdio {
                    schema_version: 1, ..
                } => Vec::new(),
                _ => return Err(unsupported()),
            };
            (host, None)
        }
        CapabilityKind::Connector => {
            let connector = parse_connector(store, package, &record.path)?;
            let provider = (connector.authentication.as_deref() == Some("oauth")).then(|| {
                connector
                    .provider
                    .unwrap_or_else(|| record.descriptor.id.clone())
            });
            (Vec::new(), provider)
        }
        _ => (Vec::new(), None),
    };
    let mut descriptor = record.descriptor.clone();
    descriptor.permissions = permissions;
    descriptor.authentication_provider = authentication_provider;
    Ok(descriptor)
}

pub(crate) fn acquire_spec(
    store: &Store,
    installation: &InstallationRecord,
    capability: &CapabilityRecord,
) -> Result<ActivationSpec, MarketplaceClientError> {
    match capability.descriptor.kind {
        CapabilityKind::Skill => Ok(ActivationSpec::Skill(SkillActivationSpec {
            contract_version: "1".into(),
            resource: resource_ref(&capability.descriptor.reference.id),
        })),
        CapabilityKind::Mcp => {
            let definition = parse_mcp(store, &installation.package, &capability.path)?;
            let (transport, network_hosts) = match definition {
                McpDefinition::Stdio {
                    schema_version: 1,
                    command,
                    args,
                } => {
                    validate_mcp_command(&command, &args)?;
                    store.read_package_file(&installation.package, &command)?;
                    (
                        McpTransportSpec::Stdio {
                            executable: mcp_executable_resource(
                                &capability.descriptor.reference.id,
                            ),
                            args,
                        },
                        Vec::new(),
                    )
                }
                McpDefinition::Http {
                    schema_version: 1,
                    url,
                } => {
                    if !url.starts_with("https://") {
                        return Err(unsupported());
                    }
                    let endpoint = Url::parse(&url).map_err(|_| unsupported())?;
                    let host = endpoint.host_str().ok_or_else(unsupported)?.to_owned();
                    (McpTransportSpec::StreamableHttp { url }, vec![host])
                }
                _ => return Err(unsupported()),
            };
            Ok(ActivationSpec::Mcp(McpActivationSpec {
                contract_version: "1".into(),
                transport,
                network_hosts,
            }))
        }
        CapabilityKind::Connector => {
            let connector = parse_connector(store, &installation.package, &capability.path)?;
            let authentication_provider = (connector.authentication.as_deref() == Some("oauth"))
                .then(|| {
                    connector
                        .provider
                        .unwrap_or_else(|| capability.descriptor.id.clone())
                });
            let mcp = connector.mcp_server.and_then(|mcp_id| {
                installation
                    .capabilities
                    .iter()
                    .find(|candidate| {
                        candidate.descriptor.kind == CapabilityKind::Mcp
                            && candidate.descriptor.id == mcp_id
                    })
                    .map(|candidate| candidate.descriptor.reference.clone())
            });
            Ok(ActivationSpec::Connector(ConnectorActivationSpec {
                contract_version: "1".into(),
                authentication_provider,
                mcp,
            }))
        }
        CapabilityKind::Theme => Ok(ActivationSpec::Theme(ThemeActivationSpec {
            contract_version: "1".into(),
            manifest: resource_ref(&capability.descriptor.reference.id),
        })),
        CapabilityKind::Language => Ok(ActivationSpec::Language(LanguageActivationSpec {
            contract_version: "1".into(),
            manifest: resource_ref(&capability.descriptor.reference.id),
        })),
        CapabilityKind::Localization => {
            Ok(ActivationSpec::Localization(LocalizationActivationSpec {
                contract_version: "1".into(),
                catalog: resource_ref(&capability.descriptor.reference.id),
            }))
        }
        CapabilityKind::Executable => {
            let runtime = match capability.runtime.as_deref() {
                Some("direct") => ExecutableRuntime::Direct,
                Some("node") | None => ExecutableRuntime::Node,
                Some(_) => return Err(unsupported()),
            };
            Ok(ActivationSpec::Executable(ExecutableActivationSpec {
                contract_version: "1".into(),
                runtime,
                entrypoint: resource_ref(&capability.descriptor.reference.id),
            }))
        }
        // Editor packages are consumed by the catalog; installation never grants script execution.
        CapabilityKind::EditorExtension | CapabilityKind::Asset => Err(unsupported()),
    }
}

pub(crate) fn open_resource(
    store: &Store,
    installation: &InstallationRecord,
    capability: &CapabilityRecord,
    requested: &ResourceRef,
) -> Result<ResourceContent, MarketplaceClientError> {
    let (path, media_type) = match capability.descriptor.kind {
        CapabilityKind::Skill
            if &resource_ref(&capability.descriptor.reference.id) == requested =>
        {
            (
                format!("{}/SKILL.md", capability.path),
                "text/markdown; charset=utf-8",
            )
        }
        CapabilityKind::Theme | CapabilityKind::Language
            if &resource_ref(&capability.descriptor.reference.id) == requested =>
        {
            (
                format!("{}/package.json", capability.path),
                "application/json; charset=utf-8",
            )
        }
        CapabilityKind::Localization
            if &resource_ref(&capability.descriptor.reference.id) == requested =>
        {
            (
                format!("{}/package.json", capability.path),
                "application/json; charset=utf-8",
            )
        }
        CapabilityKind::Executable
            if &resource_ref(&capability.descriptor.reference.id) == requested =>
        {
            (capability.path.clone(), "application/octet-stream")
        }
        CapabilityKind::Mcp
            if &mcp_executable_resource(&capability.descriptor.reference.id) == requested =>
        {
            let McpDefinition::Stdio {
                schema_version: 1,
                command,
                args,
            } = parse_mcp(store, &installation.package, &capability.path)?
            else {
                return Err(resource_not_found());
            };
            validate_mcp_command(&command, &args)?;
            (command, "application/octet-stream")
        }
        _ => return Err(resource_not_found()),
    };
    let bytes = store.read_package_file(&installation.package, &path)?;
    Ok(ResourceContent {
        media_type: media_type.into(),
        data_base64: STANDARD.encode(bytes),
    })
}

fn resource_ref(capability_id: &str) -> ResourceRef {
    ResourceRef {
        id: opaque_id("res", &[capability_id]),
    }
}

fn mcp_executable_resource(capability_id: &str) -> ResourceRef {
    ResourceRef {
        id: opaque_id("res", &[capability_id, "executable"]),
    }
}

fn resource_not_found() -> MarketplaceClientError {
    MarketplaceClientError::business(
        crate::MarketplaceErrorCode::ResourceNotFound,
        "Marketplace resource was not found",
        false,
    )
}

fn validate_mcp_command(command: &str, args: &[String]) -> Result<(), MarketplaceClientError> {
    if command.trim().is_empty()
        || command != command.trim()
        || args.len() > 128
        || args.iter().map(String::len).sum::<usize>() > 16 * 1024
        || args
            .iter()
            .any(|argument| argument.contains('\0') || argument.contains(['\r', '\n']))
    {
        return Err(unsupported());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase", deny_unknown_fields)]
enum McpDefinition {
    Stdio {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "command")]
        command: String,
        #[serde(default, rename = "args")]
        args: Vec<String>,
    },
    Http {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        url: String,
    },
}

fn parse_mcp(
    store: &Store,
    package: &PackageRef,
    path: &str,
) -> Result<McpDefinition, MarketplaceClientError> {
    let bytes = store.read_package_file(package, path)?;
    serde_json::from_slice(&bytes).map_err(|_| unsupported())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorDefinition {
    schema_version: u32,
    id: String,
    display_name: String,
    #[serde(default)]
    authentication: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    mcp_server: Option<String>,
}

fn parse_connector(
    store: &Store,
    package: &PackageRef,
    path: &str,
) -> Result<ConnectorDefinition, MarketplaceClientError> {
    let bytes = store.read_package_file(package, path)?;
    let definition: ConnectorDefinition =
        serde_json::from_slice(&bytes).map_err(|_| unsupported())?;
    if definition.schema_version != 1
        || definition.id.is_empty()
        || definition.display_name.is_empty()
    {
        return Err(unsupported());
    }
    Ok(definition)
}

fn unsupported() -> MarketplaceClientError {
    MarketplaceClientError::business(
        crate::MarketplaceErrorCode::CapabilityUnsupported,
        "Marketplace capability contract is unsupported",
        false,
    )
}
