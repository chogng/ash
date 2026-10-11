use super::Command;
use super::Event;
use super::Page;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsGetParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsInstallParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUninstallModeDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUninstallParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUpdateParams;

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    command: Command,
) -> Result<Event, String> {
    run(client, command)
        .map(Event)
        .map_err(|error| error.to_string())
}

fn run<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    command: Command,
) -> Result<Page, ClientError> {
    let selected = match command {
        Command::Plugins => return client.list_plugins().map(Page::Plugins),
        Command::SetPluginEnablement { revision, package } => {
            let params = ash_app_server_protocol::protocol::plugins::PluginPackageCommandParams {
                command_id: crate::client::new_command_id("plugin-enablement").to_string(),
                expected_revision: revision,
                id: package.id,
                version: package.version,
                digest: package.digest,
            };
            if package.enabled {
                client.disable_plugin(params)?;
            } else {
                client.enable_plugin(params)?;
            }
            return client.list_plugins().map(Page::Plugins);
        }
        Command::Browse(params) => {
            let installed = client.list_installed_extension_packages();
            let installed = match installed {
                Ok(result) => result.packages,
                Err(error) => {
                    return Ok(Page::Catalog {
                        params,
                        packages: Vec::new(),
                        installed: Vec::new(),
                        error: Some(error.to_string()),
                    });
                }
            };
            let result = (|| {
                if (params.capability_kind.is_some() || params.language_id.is_some())
                    && !client
                        .initialization()
                        .map_err(|error| error.to_string())?
                        .capabilities
                        .contracts
                        .get("extensionsSearch")
                        .is_some_and(|contract| contract.version == 1)
                {
                    return Err(
                        "This App Server does not support capability and language filters"
                            .to_owned(),
                    );
                }
                client
                    .search_extension_packages(params.clone())
                    .map_err(|error| error.to_string())
            })();
            return Ok(match result {
                Ok(result) => Page::Catalog {
                    params,
                    packages: result.packages,
                    installed,
                    error: None,
                },
                Err(error) => Page::Catalog {
                    params,
                    packages: Vec::new(),
                    installed,
                    error: Some(error),
                },
            });
        }
        Command::Review {
            package_id,
            version,
            installation_id,
        } => {
            return client
                .get_extension_package(ExtensionsGetParams {
                    package_id,
                    version,
                })
                .map(|details| Page::Review {
                    details,
                    installation_id,
                });
        }
        Command::Install {
            package_id,
            version,
        } => Some(
            client
                .install_extension_package(ExtensionsInstallParams {
                    package_id,
                    version: Some(version),
                })?
                .installation_id,
        ),
        Command::Update {
            installation_id,
            version,
        } => Some(
            client
                .update_extension_package(ExtensionsUpdateParams {
                    installation_id,
                    version: Some(version),
                })?
                .installation_id,
        ),
        Command::Uninstall { installation_id } => {
            client.uninstall_extension_package(ExtensionsUninstallParams {
                installation_id,
                mode: ExtensionsUninstallModeDto::WhenUnused,
            })?;
            None
        }
        Command::Installed => None,
    };
    client
        .list_installed_extension_packages()
        .map(|result| Page::Installed {
            packages: result.packages,
            selected,
        })
}
