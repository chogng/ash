use std::fmt;
use std::io;
use std::io::Write;

use ash_remote::RemoteAddressError;
use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_connections::RemoteConnectionCatalog;
use ash_remote_connections::RemoteConnectionEntry;
use ash_remote_connections::RemoteConnectionName;
use ash_remote_connections::RemoteConnectionNameError;
use ash_remote_connections::RemoteConnectionSaveMode;

use crate::launch::AppLaunch;
use crate::launch::LaunchParseError;
use crate::remote_connection_tunnel::RemoteTunnelCommand;

/// One complete command-line invocation before the desktop event loop starts.
pub(crate) enum AppInvocation {
    Launch(AppLaunch),
    RemoteConnection(RemoteConnectionCommand),
}

impl AppInvocation {
    pub(crate) fn parse(
        arguments: impl IntoIterator<Item = String>,
    ) -> Result<Self, AppInvocationParseError> {
        let mut arguments = arguments.into_iter().collect::<Vec<_>>();
        if arguments
            .first()
            .is_some_and(|argument| argument == "remote")
        {
            arguments.remove(0);
            return RemoteConnectionCommand::parse(arguments)
                .map(Self::RemoteConnection)
                .map_err(AppInvocationParseError::Remote);
        }
        AppLaunch::parse(arguments)
            .map(Self::Launch)
            .map_err(AppInvocationParseError::Launch)
    }

    /// Executes a management command or returns the launch selected for the desktop application.
    pub(crate) fn resolve(self) -> Result<Option<AppLaunch>, String> {
        let catalog = RemoteConnectionCatalog::from_profile_root(
            ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
        );
        let stdout = io::stdout();
        let mut output = stdout.lock();
        self.resolve_with_catalog(&catalog, &mut output)
    }

    pub(crate) fn resolve_with_catalog(
        self,
        catalog: &RemoteConnectionCatalog,
        output: &mut dyn Write,
    ) -> Result<Option<AppLaunch>, String> {
        match self {
            Self::Launch(launch) => Ok(Some(launch)),
            Self::RemoteConnection(command) => command.execute(catalog, output),
        }
    }
}

pub(crate) enum RemoteConnectionCommand {
    Save {
        entry: RemoteConnectionEntry,
        mode: RemoteConnectionSaveMode,
    },
    List,
    Remove(RemoteConnectionName),
    Connect {
        name: RemoteConnectionName,
        launch_options: Vec<String>,
    },
    Tunnel(RemoteTunnelCommand),
}

impl RemoteConnectionCommand {
    fn parse(arguments: Vec<String>) -> Result<Self, RemoteConnectionCommandParseError> {
        let mut arguments = arguments.into_iter();
        let Some(command) = arguments.next() else {
            return Err(RemoteConnectionCommandParseError::HelpRequested);
        };
        if matches!(command.as_str(), "--help" | "-h") {
            return Err(RemoteConnectionCommandParseError::HelpRequested);
        }
        match command.as_str() {
            "save" => Self::parse_save(arguments),
            "list" => {
                reject_remaining(arguments)?;
                Ok(Self::List)
            }
            "remove" => {
                let name = parse_name("remove", &mut arguments)?;
                reject_remaining(arguments)?;
                Ok(Self::Remove(name))
            }
            "connect" => {
                let name = parse_name("connect", &mut arguments)?;
                let launch_options = arguments.collect::<Vec<_>>();
                if launch_options
                    .iter()
                    .any(|option| matches!(option.as_str(), "--remote" | "--dir"))
                {
                    return Err(RemoteConnectionCommandParseError::NamedTargetConflict);
                }
                if launch_options
                    .iter()
                    .any(|option| matches!(option.as_str(), "--help" | "-h"))
                {
                    return Err(RemoteConnectionCommandParseError::HelpRequested);
                }
                Ok(Self::Connect {
                    name,
                    launch_options,
                })
            }
            "tunnel" => {
                let name = parse_name("tunnel", &mut arguments)?;
                RemoteTunnelCommand::parse(name, arguments).map(Self::Tunnel)
            }
            _ => Err(RemoteConnectionCommandParseError::UnknownCommand(command)),
        }
    }

    fn parse_save(
        mut arguments: std::vec::IntoIter<String>,
    ) -> Result<Self, RemoteConnectionCommandParseError> {
        let name = parse_name("save", &mut arguments)?;
        let mut host = None;
        let mut dir = None;
        let mut mode = RemoteConnectionSaveMode::Create;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--host" => {
                    set_unique_value(
                        &mut host,
                        "--host",
                        arguments.next().ok_or(
                            RemoteConnectionCommandParseError::MissingValue { flag: "--host" },
                        )?,
                    )?
                }
                "--dir" => set_unique_value(
                    &mut dir,
                    "--dir",
                    arguments
                        .next()
                        .ok_or(RemoteConnectionCommandParseError::MissingValue { flag: "--dir" })?,
                )?,
                "--replace" if mode == RemoteConnectionSaveMode::Create => {
                    mode = RemoteConnectionSaveMode::Replace;
                }
                "--replace" => {
                    return Err(RemoteConnectionCommandParseError::DuplicateOption(
                        "--replace",
                    ));
                }
                "--help" | "-h" => {
                    return Err(RemoteConnectionCommandParseError::HelpRequested);
                }
                _ => {
                    return Err(RemoteConnectionCommandParseError::UnknownArgument(argument));
                }
            }
        }
        let host = host.ok_or(RemoteConnectionCommandParseError::RequiredOption {
            command: "save",
            flag: "--host",
        })?;
        let dir = dir.ok_or(RemoteConnectionCommandParseError::RequiredOption {
            command: "save",
            flag: "--dir",
        })?;
        let host = SshHost::parse(host).map_err(RemoteConnectionCommandParseError::Address)?;
        let dir = RemoteDirPath::parse(dir).map_err(RemoteConnectionCommandParseError::Address)?;
        Ok(Self::Save {
            entry: RemoteConnectionEntry::new(name, SshTarget::new(host, dir)),
            mode,
        })
    }

    fn execute(
        self,
        catalog: &RemoteConnectionCatalog,
        output: &mut dyn Write,
    ) -> Result<Option<AppLaunch>, String> {
        match self {
            Self::Save { entry, mode } => {
                let entry = catalog.save(entry, mode).map_err(|error| {
                    format!(
                        "could not save Remote connections at `{}`: {error}",
                        catalog.path().display()
                    )
                })?;
                writeln!(
                    output,
                    "saved\t{}\t{}\t{}",
                    entry.name().as_str(),
                    entry.target().host().as_str(),
                    entry.target().dir().as_str()
                )
                .map_err(output_error)?;
                Ok(None)
            }
            Self::List => {
                let entries = catalog.connections().map_err(|error| {
                    format!(
                        "could not list Remote connections at `{}`: {error}",
                        catalog.path().display()
                    )
                })?;
                for entry in entries {
                    writeln!(
                        output,
                        "{}\t{}\t{}",
                        entry.name().as_str(),
                        entry.target().host().as_str(),
                        entry.target().dir().as_str()
                    )
                    .map_err(output_error)?;
                }
                Ok(None)
            }
            Self::Remove(name) => {
                let removed = catalog.remove(&name).map_err(|error| {
                    format!(
                        "could not remove Remote connection from `{}`: {error}",
                        catalog.path().display()
                    )
                })?;
                let Some(removed) = removed else {
                    return Err(format!(
                        "Remote connection `{}` does not exist",
                        name.as_str()
                    ));
                };
                writeln!(output, "removed\t{}", removed.name().as_str()).map_err(output_error)?;
                Ok(None)
            }
            Self::Connect {
                name,
                launch_options,
            } => {
                let entry = load_connection(catalog, &name)?;
                let mut arguments = vec![
                    "--remote".to_owned(),
                    entry.target().host().as_str().to_owned(),
                    "--dir".to_owned(),
                    entry.target().dir().as_str().to_owned(),
                ];
                arguments.extend(launch_options);
                AppLaunch::parse(arguments)
                    .map(Some)
                    .map_err(|error| error.to_string())
            }
            Self::Tunnel(command) => {
                command.execute(catalog, output)?;
                Ok(None)
            }
        }
    }
}

fn parse_name(
    command: &'static str,
    arguments: &mut std::vec::IntoIter<String>,
) -> Result<RemoteConnectionName, RemoteConnectionCommandParseError> {
    let value = arguments
        .next()
        .ok_or(RemoteConnectionCommandParseError::MissingName { command })?;
    RemoteConnectionName::parse(value).map_err(RemoteConnectionCommandParseError::Name)
}

fn set_unique_value(
    slot: &mut Option<String>,
    flag: &'static str,
    value: String,
) -> Result<(), RemoteConnectionCommandParseError> {
    if slot.replace(value).is_some() {
        return Err(RemoteConnectionCommandParseError::DuplicateOption(flag));
    }
    Ok(())
}

fn reject_remaining(
    mut arguments: std::vec::IntoIter<String>,
) -> Result<(), RemoteConnectionCommandParseError> {
    match arguments.next() {
        Some(argument) if matches!(argument.as_str(), "--help" | "-h") => {
            Err(RemoteConnectionCommandParseError::HelpRequested)
        }
        Some(argument) => Err(RemoteConnectionCommandParseError::UnknownArgument(argument)),
        None => Ok(()),
    }
}

fn output_error(error: io::Error) -> String {
    format!("could not write Remote command output: {error}")
}

pub(crate) fn load_connection(
    catalog: &RemoteConnectionCatalog,
    name: &RemoteConnectionName,
) -> Result<RemoteConnectionEntry, String> {
    catalog
        .connection(name)
        .map_err(|error| {
            format!(
                "could not load Remote connections at `{}`: {error}",
                catalog.path().display()
            )
        })?
        .ok_or_else(|| format!("Remote connection `{}` does not exist", name.as_str()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AppInvocationParseError {
    Launch(LaunchParseError),
    Remote(RemoteConnectionCommandParseError),
}

impl AppInvocationParseError {
    pub(crate) const fn is_help_requested(&self) -> bool {
        matches!(
            self,
            Self::Launch(LaunchParseError::HelpRequested)
                | Self::Remote(RemoteConnectionCommandParseError::HelpRequested)
        )
    }
}

impl fmt::Display for AppInvocationParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Launch(error) => error.fmt(formatter),
            Self::Remote(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for AppInvocationParseError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteConnectionCommandParseError {
    HelpRequested,
    UnknownCommand(String),
    MissingName {
        command: &'static str,
    },
    MissingValue {
        flag: &'static str,
    },
    RequiredOption {
        command: &'static str,
        flag: &'static str,
    },
    DuplicateOption(&'static str),
    UnknownArgument(String),
    NamedTargetConflict,
    InvalidPort {
        flag: &'static str,
        value: String,
    },
    Name(RemoteConnectionNameError),
    Address(RemoteAddressError),
}

impl fmt::Display for RemoteConnectionCommandParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HelpRequested => formatter.write_str(remote_usage()),
            Self::UnknownCommand(command) => {
                write!(
                    formatter,
                    "unknown Remote command `{command}`\n\n{}",
                    remote_usage()
                )
            }
            Self::MissingName { command } => write!(
                formatter,
                "app remote {command} requires a connection name\n\n{}",
                remote_usage()
            ),
            Self::MissingValue { flag } => {
                write!(formatter, "{flag} requires a value\n\n{}", remote_usage())
            }
            Self::RequiredOption { command, flag } => write!(
                formatter,
                "app remote {command} requires {flag}\n\n{}",
                remote_usage()
            ),
            Self::DuplicateOption(flag) => write!(
                formatter,
                "{flag} may be specified only once\n\n{}",
                remote_usage()
            ),
            Self::UnknownArgument(argument) => write!(
                formatter,
                "unknown Remote argument `{argument}`\n\n{}",
                remote_usage()
            ),
            Self::NamedTargetConflict => write!(
                formatter,
                "a named Remote connection already selects --remote and --dir\n\n{}",
                remote_usage()
            ),
            Self::InvalidPort { flag, value } => write!(
                formatter,
                "{flag} requires a TCP port from 1 to 65535, got `{value}`\n\n{}",
                remote_usage()
            ),
            Self::Name(error) => write!(formatter, "{error}\n\n{}", remote_usage()),
            Self::Address(error) => write!(formatter, "{error}\n\n{}", remote_usage()),
        }
    }
}

impl std::error::Error for RemoteConnectionCommandParseError {}

pub(crate) const fn remote_usage() -> &'static str {
    "usage:\n\
     app remote save <name> --host <ssh-host> --dir <absolute-remote-path> [--replace]\n\
     app remote list\n\
     app remote remove <name>\n\
     app remote connect <name> [--runtime <remote-runtime>] [--ssh <openssh-path>]\n\
       [--runtime-catalog <local-catalog> --runtime-catalog-sha256 <digest>]\n\
       [--runtime-catalog-url <https-catalog.json> --runtime-catalog-sha256 <digest>]\n\
       [--runtime-cache <absolute-local-path>]\n\
       [--rollback-runtime]\n\
     app remote tunnel <name> --remote-port <port> [--local-port <port>]\n\
       [--ssh <openssh-path>]\n\n\
     Saved connections contain no passwords, private keys, or runtime paths.\n\
     Tunnels bind only to local and Remote loopback interfaces.\n\
     OpenSSH configuration and the local SSH agent own authentication."
}
