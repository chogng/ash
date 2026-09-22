use super::Command;
use super::Event;
use super::Page;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::marketplace::MarketplaceGetParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstallParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUninstallModeDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUninstallParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUpdateParams;

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
        Command::Browse(params) => {
            let result = (|| {
                if (params.capability_kind.is_some() || params.language_id.is_some())
                    && !client
                        .initialization()
                        .map_err(|error| error.to_string())?
                        .capabilities
                        .contracts
                        .get("marketplaceSearch")
                        .is_some_and(|contract| contract.version == 1)
                {
                    return Err(
                        "This App Server does not support capability and language filters"
                            .to_owned(),
                    );
                }
                client
                    .search_marketplace(params.clone())
                    .map_err(|error| error.to_string())
            })();
            return Ok(match result {
                Ok(result) => Page::Catalog {
                    params,
                    packages: result.packages,
                    error: None,
                },
                Err(error) => Page::Catalog {
                    params,
                    packages: Vec::new(),
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
                .get_marketplace_package(MarketplaceGetParams {
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
                .install_marketplace_package(MarketplaceInstallParams {
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
                .update_marketplace_package(MarketplaceUpdateParams {
                    installation_id,
                    version: Some(version),
                })?
                .installation_id,
        ),
        Command::Uninstall { installation_id } => {
            client.uninstall_marketplace_package(MarketplaceUninstallParams {
                installation_id,
                mode: MarketplaceUninstallModeDto::WhenUnused,
            })?;
            None
        }
        Command::Installed => None,
    };
    client
        .list_installed_marketplace_packages()
        .map(|result| Page::Installed {
            packages: result.packages,
            selected,
        })
}
