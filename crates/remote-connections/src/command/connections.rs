use crate::RemoteConnectionCatalog;
use crate::RemoteConnectionEntry;
use crate::RemoteConnectionName;
use crate::RemoteConnectionSaveMode;
use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use serde::Serialize;

const LIST_USAGE: &str = "usage: ash-server remote connections list";
const GET_USAGE: &str = "usage: ash-server remote connections get --name <name>";
const SAVE_USAGE: &str = concat!(
    "usage: ash-server remote connections save --name <name> --host <ssh-host> ",
    "--dir <absolute-remote-path> [--mode create|replace]"
);
const UPDATE_USAGE: &str = concat!(
    "usage: ash-server remote connections update --name <existing-name> ",
    "--new-name <name> --host <ssh-host> --dir <absolute-remote-path>"
);
const REMOVE_USAGE: &str = "usage: ash-server remote connections remove --name <name>";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RemoteConnectionsCommand {
    List,
    Get(RemoteConnectionName),
    Save {
        entry: RemoteConnectionEntry,
        mode: RemoteConnectionSaveMode,
    },
    Update {
        original_name: RemoteConnectionName,
        entry: RemoteConnectionEntry,
    },
    Remove(RemoteConnectionName),
}

pub(super) fn parse(arguments: &[String]) -> Result<RemoteConnectionsCommand, String> {
    let Some((command, arguments)) = arguments.split_first() else {
        return Err(usage());
    };
    match command.as_str() {
        "list" => {
            if !arguments.is_empty() {
                return Err(format!(
                    "remote connections list accepts no options\n\n{LIST_USAGE}"
                ));
            }
            Ok(RemoteConnectionsCommand::List)
        }
        "get" => parse_get(arguments),
        "save" => parse_save(arguments),
        "update" => parse_update(arguments),
        "remove" => parse_remove(arguments),
        _ => Err(format!(
            "unknown remote connections command: {command}\n\n{}",
            usage()
        )),
    }
}

pub(super) fn run(command: RemoteConnectionsCommand) -> Result<(), String> {
    let catalog = RemoteConnectionCatalog::from_profile_root(
        ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
    );
    match command {
        RemoteConnectionsCommand::List => {
            let connections = catalog.connections().map_err(|error| error.to_string())?;
            print_json(
                &connections
                    .iter()
                    .map(ConnectionOutput::from)
                    .collect::<Vec<_>>(),
            )
        }
        RemoteConnectionsCommand::Get(name) => {
            let connection = catalog
                .connection(&name)
                .map_err(|error| error.to_string())?;
            print_json(&connection.as_ref().map(ConnectionOutput::from))
        }
        RemoteConnectionsCommand::Save { entry, mode } => {
            let saved = catalog
                .save(entry, mode)
                .map_err(|error| error.to_string())?;
            print_json(&ConnectionOutput::from(&saved))
        }
        RemoteConnectionsCommand::Update {
            original_name,
            entry,
        } => {
            let updated = catalog
                .update(&original_name, entry)
                .map_err(|error| error.to_string())?;
            print_json(&ConnectionOutput::from(&updated))
        }
        RemoteConnectionsCommand::Remove(name) => {
            let removed = catalog.remove(&name).map_err(|error| error.to_string())?;
            print_json(&removed.as_ref().map(ConnectionOutput::from))
        }
    }
}

pub(super) fn usage() -> String {
    format!("{LIST_USAGE}\n{GET_USAGE}\n{SAVE_USAGE}\n{UPDATE_USAGE}\n{REMOVE_USAGE}")
}

fn parse_get(arguments: &[String]) -> Result<RemoteConnectionsCommand, String> {
    parse_named_command(arguments, GET_USAGE, "get").map(RemoteConnectionsCommand::Get)
}

fn parse_save(arguments: &[String]) -> Result<RemoteConnectionsCommand, String> {
    let mut name = None;
    let mut host = None;
    let mut dir = None;
    let mut mode = None;
    super::parse_options(arguments, |option, value| match option {
        "--name" => super::assign_once(
            &mut name,
            RemoteConnectionName::parse(value).map_err(super::string_error)?,
            option,
        ),
        "--host" => super::assign_once(
            &mut host,
            SshHost::parse(value).map_err(super::string_error)?,
            option,
        ),
        "--dir" => super::assign_once(
            &mut dir,
            RemoteDirPath::parse(value).map_err(super::string_error)?,
            option,
        ),
        "--mode" => super::assign_once(
            &mut mode,
            match value {
                "create" => RemoteConnectionSaveMode::Create,
                "replace" => RemoteConnectionSaveMode::Replace,
                _ => return Err("--mode supports only `create` or `replace`".into()),
            },
            option,
        ),
        _ => Err(format!(
            "unknown remote connections save option: {option}\n\n{SAVE_USAGE}"
        )),
    })?;
    let target = SshTarget::new(
        host.ok_or_else(|| required("--host", SAVE_USAGE))?,
        dir.ok_or_else(|| required("--dir", SAVE_USAGE))?,
    );
    Ok(RemoteConnectionsCommand::Save {
        entry: RemoteConnectionEntry::new(
            name.ok_or_else(|| required("--name", SAVE_USAGE))?,
            target,
        ),
        mode: mode.unwrap_or(RemoteConnectionSaveMode::Create),
    })
}

fn parse_update(arguments: &[String]) -> Result<RemoteConnectionsCommand, String> {
    let mut original_name = None;
    let mut name = None;
    let mut host = None;
    let mut dir = None;
    super::parse_options(arguments, |option, value| match option {
        "--name" => super::assign_once(
            &mut original_name,
            RemoteConnectionName::parse(value).map_err(super::string_error)?,
            option,
        ),
        "--new-name" => super::assign_once(
            &mut name,
            RemoteConnectionName::parse(value).map_err(super::string_error)?,
            option,
        ),
        "--host" => super::assign_once(
            &mut host,
            SshHost::parse(value).map_err(super::string_error)?,
            option,
        ),
        "--dir" => super::assign_once(
            &mut dir,
            RemoteDirPath::parse(value).map_err(super::string_error)?,
            option,
        ),
        _ => Err(format!(
            "unknown remote connections update option: {option}\n\n{UPDATE_USAGE}"
        )),
    })?;
    let target = SshTarget::new(
        host.ok_or_else(|| required("--host", UPDATE_USAGE))?,
        dir.ok_or_else(|| required("--dir", UPDATE_USAGE))?,
    );
    Ok(RemoteConnectionsCommand::Update {
        original_name: original_name.ok_or_else(|| required("--name", UPDATE_USAGE))?,
        entry: RemoteConnectionEntry::new(
            name.ok_or_else(|| required("--new-name", UPDATE_USAGE))?,
            target,
        ),
    })
}

fn parse_remove(arguments: &[String]) -> Result<RemoteConnectionsCommand, String> {
    parse_named_command(arguments, REMOVE_USAGE, "remove").map(RemoteConnectionsCommand::Remove)
}

fn parse_named_command(
    arguments: &[String],
    usage: &'static str,
    command: &'static str,
) -> Result<RemoteConnectionName, String> {
    let mut name = None;
    super::parse_options(arguments, |option, value| match option {
        "--name" => super::assign_once(
            &mut name,
            RemoteConnectionName::parse(value).map_err(super::string_error)?,
            option,
        ),
        _ => Err(format!(
            "unknown remote connections {command} option: {option}\n\n{usage}"
        )),
    })?;
    name.ok_or_else(|| required("--name", usage))
}

fn required(name: &str, usage: &str) -> String {
    format!("{name} is required\n\n{usage}")
}

fn print_json(value: &impl Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionOutput {
    name: String,
    host: String,
    dir: String,
}

impl From<&RemoteConnectionEntry> for ConnectionOutput {
    fn from(entry: &RemoteConnectionEntry) -> Self {
        Self {
            name: entry.name().as_str().into(),
            host: entry.target().host().as_str().into(),
            dir: entry.target().dir().as_str().into(),
        }
    }
}
