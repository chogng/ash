use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::config::McpCredentialBindingDto;
use ash_app_server_protocol::protocol::config::McpServerConfigDto;
use ash_app_server_protocol::protocol::config::McpServerEnablementDto;
use ash_app_server_protocol::protocol::config::McpServerRemoveParams;
use ash_app_server_protocol::protocol::config::McpServerSetEnablementParams;
use ash_app_server_protocol::protocol::config::McpServerUpsertParams;
use ash_app_server_protocol::protocol::config::McpTransportDto;
use ash_app_server_protocol::protocol::plugins::PluginPackageCommandParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use clap::Subcommand;

use crate::CliError;
use crate::print_json;

#[derive(Subcommand)]
pub(super) enum McpCommand {
    /// List configured servers as JSON.
    List,
    /// Show one server declaration as JSON.
    Get { id: String },
    /// Add a server. Use --url URL or -- COMMAND [ARGS] for its transport.
    Add {
        /// Full user server ID, for example user:mcp:docs.
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, conflicts_with = "command", required_unless_present = "command")]
        url: Option<String>,
        /// Store the declaration without starting the server.
        #[arg(long)]
        disabled: bool,
        #[arg(last = true, num_args = 1.., required_unless_present = "url")]
        command: Vec<String>,
    },
    /// Remove a standalone server declaration.
    Remove { id: String },
    /// Enable a configured server.
    Enable { id: String },
    /// Disable a configured server.
    Disable { id: String },
}

#[derive(Subcommand)]
pub(super) enum PluginCommand {
    /// List exact installed package versions and permission states as JSON.
    List,
    /// Enable an installed package without changing its permission grant.
    Enable(PackageArgs),
    /// Disable an installed package.
    Disable(PackageArgs),
    /// Grant the installed package's declared permissions.
    Grant(PackageArgs),
    /// Revoke the installed package's permission grant.
    Revoke(PackageArgs),
    /// Uninstall the selected package version.
    Uninstall(PackageArgs),
}

#[derive(clap::Args)]
pub(super) struct PackageArgs {
    /// Exact plugin ID, as printed by `ash plugin list`.
    id: String,
    /// Select an installed version when multiple versions have the same ID.
    #[arg(long)]
    version: Option<String>,
}

pub(super) fn connect() -> Result<AppServerSession, CliError> {
    let executable = std::env::current_exe().map_err(CliError::failure)?;
    let command = StdioAppServerCommand::new(executable)
        .with_argument("app-server")
        .with_argument("connect")
        .with_environment_variable("ASH_HOME", crate::profile_root()?.into_os_string())
        .without_environment_variable("ASH_WORKSPACE_ROOT");
    AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-cli-management".into(),
            version: build_info::VERSION.into(),
        },
        ClientCapabilities::default(),
    )
    .map_err(CliError::failure)
}

pub(super) fn with_client(
    run: impl FnOnce(&mut AppServerRequestHandle) -> Result<(), CliError>,
) -> Result<(), CliError> {
    let session = connect()?;
    let outcome = run(&mut session.client());
    let shutdown = session.shutdown().map_err(CliError::failure);
    outcome.and(shutdown)
}

fn command_id() -> CommandId {
    CommandId::new(format!("cli-{:032x}", rand::random::<u128>()))
        .expect("generated command ID is non-empty")
}

pub(super) fn mcp(command: McpCommand) -> Result<(), CliError> {
    with_client(|client| run_mcp(client, command))
}

fn run_mcp(client: &mut AppServerRequestHandle, command: McpCommand) -> Result<(), CliError> {
    let config = client.read_config()?;
    let result = match command {
        McpCommand::List => return print_json(&config.mcp_servers),
        McpCommand::Get { id } => {
            let server = config
                .mcp_servers
                .get(&id)
                .ok_or_else(|| CliError::usage(format!("MCP server not found: {id}")))?;
            return print_json(server);
        }
        McpCommand::Add {
            id,
            name,
            url,
            disabled,
            command,
        } => {
            if config.mcp_servers.contains_key(&id) {
                return Err(CliError::usage(format!("MCP server already exists: {id}")));
            }
            let transport = match url {
                Some(url) => McpTransportDto::StreamableHttp { url },
                None => {
                    let mut command = command.into_iter();
                    McpTransportDto::Stdio {
                        command: command.next().expect("Clap requires the command"),
                        args: command.collect(),
                    }
                }
            };
            client.upsert_mcp_server(McpServerUpsertParams {
                command_id: command_id(),
                expected_revision: config.revision,
                server: McpServerConfigDto {
                    display_name: name.unwrap_or_else(|| id.clone()),
                    id,
                    transport,
                    credential: McpCredentialBindingDto::Unauthenticated,
                    enablement: if disabled {
                        McpServerEnablementDto::Disabled
                    } else {
                        McpServerEnablementDto::Enabled
                    },
                },
            })?
        }
        McpCommand::Remove { id } => client.remove_mcp_server(McpServerRemoveParams {
            command_id: command_id(),
            expected_revision: config.revision,
            server_id: id,
        })?,
        McpCommand::Enable { id } => {
            client.set_mcp_server_enablement(McpServerSetEnablementParams {
                command_id: command_id(),
                expected_revision: config.revision,
                server_id: id,
                enablement: McpServerEnablementDto::Enabled,
            })?
        }
        McpCommand::Disable { id } => {
            client.set_mcp_server_enablement(McpServerSetEnablementParams {
                command_id: command_id(),
                expected_revision: config.revision,
                server_id: id,
                enablement: McpServerEnablementDto::Disabled,
            })?
        }
    };
    print_json(&result)
}

pub(super) fn plugin(command: PluginCommand) -> Result<(), CliError> {
    with_client(|client| {
        let plugins = client.list_plugins()?;
        let args = match &command {
            PluginCommand::List => return print_json(&plugins),
            PluginCommand::Enable(args)
            | PluginCommand::Disable(args)
            | PluginCommand::Grant(args)
            | PluginCommand::Revoke(args)
            | PluginCommand::Uninstall(args) => args,
        };
        let mut matches = plugins.packages.iter().filter(|package| {
            package.id == args.id
                && args
                    .version
                    .as_ref()
                    .is_none_or(|version| package.version == *version)
        });
        let package = matches
            .next()
            .ok_or_else(|| CliError::usage(format!("installed plugin not found: {}", args.id)))?;
        if matches.next().is_some() {
            return Err(CliError::usage(
                "multiple installed versions match; select one with --version",
            ));
        }
        let params = PluginPackageCommandParams {
            command_id: command_id().to_string(),
            expected_revision: plugins.revision,
            id: package.id.clone(),
            version: package.version.clone(),
            digest: package.digest.clone(),
        };
        let result = match command {
            PluginCommand::Enable(_) => client.enable_plugin(params)?,
            PluginCommand::Disable(_) => client.disable_plugin(params)?,
            PluginCommand::Grant(_) => client.grant_plugin(params)?,
            PluginCommand::Revoke(_) => client.revoke_plugin_grant(params)?,
            PluginCommand::Uninstall(_) => client.uninstall_plugin(params)?,
            PluginCommand::List => unreachable!("list returned before resolving a package"),
        };
        print_json(&result)
    })
}

pub(super) fn fork(session_id: String, thread_id: String, title: String) -> Result<(), CliError> {
    let request = SessionRequest::ForkSession {
        parent_thread_id: ThreadId::new(thread_id).map_err(CliError::usage)?,
        title,
    };
    session_request(session_id, request)
}

pub(super) fn session_request(session_id: String, request: SessionRequest) -> Result<(), CliError> {
    let session_id = SessionId::new(session_id).map_err(CliError::usage)?;
    with_client(|client| {
        print_json(&client.request_session(SessionRequestParams {
            command_id: command_id(),
            session_id,
            request,
        })?)
    })
}
