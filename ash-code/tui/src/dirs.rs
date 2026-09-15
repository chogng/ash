mod panel;
pub(crate) use panel::DirPanel;

use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::environment::EnvCwdSetParams;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirAddParams;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirListResult;
use ash_app_server_protocol::protocol::environment::SessionDirMutationDto;
use ash_app_server_protocol::protocol::environment::SessionDirPermissionsSetParams;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A completed directory operation delivered to the TUI state owner.
pub(crate) enum Event {
    PickerOpened(DirChoices),
    AddCompleted {
        request_id: u64,
        result: Result<AddedDir, String>,
    },
    Removed {
        path: std::path::PathBuf,
        choices: DirChoices,
    },
    PermissionsUpdated(DirChoices),
    Moved {
        path: std::path::PathBuf,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Add { request_id: u64, path: PathBuf },
    Remove { path: std::path::PathBuf },
    SetPermissions(SessionDirPermissionsSetParams),
    MoveSession { path: PathBuf },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::Add { .. } => "ash-tui-add-directory",
            Self::Remove { .. } => "ash-tui-remove-directory",
            Self::SetPermissions(_) => "ash-tui-set-directory-permissions",
            Self::MoveSession { .. } => "ash-tui-move-session",
        }
    }
}
use ash_app_server_protocol::protocol::environment::SessionDirRemoveParams;
use ash_protocol::SessionId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DirSelectionAction {
    Add {
        request_id: u64,
        path: PathBuf,
        target: DirAddTarget,
    },
    Remove {
        path: PathBuf,
    },
    SetPermissions(SessionDirPermissionsSetParams),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DirAddTarget {
    Session,
    Project,
}

pub(crate) type DirChoices = ListSelectionSpec<DirSelectionAction>;

#[derive(Debug)]
pub(crate) struct AddedDir {
    pub(crate) path: PathBuf,
    pub(crate) already_present: bool,
    pub(crate) choices: DirChoices,
}

pub(crate) fn load_selection<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
) -> Result<DirChoices, ClientError>
where
    T: JsonRpcTransport,
{
    client
        .list_session_dirs(SessionDirListParams {
            session_id: session_id.clone(),
        })
        .map(|result| choices(session_id, result))
}

pub(crate) fn add<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    path: PathBuf,
) -> Result<AddedDir, String>
where
    T: JsonRpcTransport,
{
    let result = client
        .add_session_dir(SessionDirAddParams {
            session_id: session_id.clone(),
            path,
            permissions: Vec::new(),
        })
        .map_err(|error| error.to_string())?;
    let already_present = match result.mutation {
        SessionDirMutationDto::Added => false,
        SessionDirMutationDto::AlreadyPresent => true,
        SessionDirMutationDto::Updated
        | SessionDirMutationDto::Removed
        | SessionDirMutationDto::NotPresent => {
            return Err("add-dir returned an invalid mutation result".into());
        }
    };
    Ok(AddedDir {
        path: result.path,
        already_present,
        choices: choices(
            session_id,
            SessionDirListResult {
                revision: result.revision,
                dirs: result.dirs,
            },
        ),
    })
}

pub(crate) fn remove<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    path: PathBuf,
) -> Result<DirChoices, ClientError>
where
    T: JsonRpcTransport,
{
    client
        .remove_session_dir(SessionDirRemoveParams {
            session_id: session_id.clone(),
            path,
        })
        .map(|result| {
            choices(
                session_id,
                SessionDirListResult {
                    revision: result.revision,
                    dirs: result.dirs,
                },
            )
        })
}

pub(crate) fn set_permissions<T>(
    client: &mut AppServerClient<T>,
    params: SessionDirPermissionsSetParams,
) -> Result<DirChoices, ClientError>
where
    T: JsonRpcTransport,
{
    let session_id = params.session_id.clone();
    client.set_session_dir_permissions(params).map(|result| {
        choices(
            &session_id,
            SessionDirListResult {
                revision: result.revision,
                dirs: result.dirs,
            },
        )
    })
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    command: Command,
) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::Add { request_id, path } => {
            let result = add(client, session_id, path);
            return Ok(Event::AddCompleted { request_id, result });
        }
        Command::Remove { path } => {
            let event_path = path.clone();
            remove(client, session_id, path).map(|choices| Event::Removed {
                path: event_path,
                choices,
            })
        }
        Command::SetPermissions(params) => {
            set_permissions(client, params).map(Event::PermissionsUpdated)
        }
        Command::MoveSession { path } => {
            move_session(client, session_id, path).map(|path| Event::Moved { path })
        }
    }
    .map_err(|error| error.to_string())
}

pub(crate) fn move_session<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    path: PathBuf,
) -> Result<PathBuf, ClientError>
where
    T: JsonRpcTransport,
{
    let target = client.add_session_dir(SessionDirAddParams {
        session_id: session_id.clone(),
        path,
        permissions: Vec::new(),
    })?;
    client.set_env_cwd(EnvCwdSetParams {
        cwd: target.path.clone(),
    })?;
    Ok(target.path)
}

pub(crate) fn choices(session_id: &SessionId, result: SessionDirListResult) -> DirChoices {
    choices_with_title(session_id, result, "Directories")
}

pub(crate) fn project_choices(session_id: &SessionId, result: SessionDirListResult) -> DirChoices {
    choices_with_title(session_id, result, "Add project folder")
}

fn choices_with_title(
    session_id: &SessionId,
    result: SessionDirListResult,
    title: &str,
) -> DirChoices {
    let mut actions = BTreeMap::new();
    let mut groups = result
        .dirs
        .into_iter()
        .enumerate()
        .map(|(index, dir)| {
            let remove_id = ListSelectionItemId::new(format!("dir-{index}-remove"));
            actions.insert(
                remove_id.clone(),
                DirSelectionAction::Remove {
                    path: dir.path.clone(),
                },
            );
            let mut items = vec![
                ListSelectionItem::new("Remove directory")
                    .with_id(remove_id)
                    .with_description(dir.path.display().to_string()),
            ];
            for permission in all_permissions() {
                let item_id = ListSelectionItemId::new(format!(
                    "dir-{index}-permission-{}",
                    permission_id(permission)
                ));
                let enabled = dir.permissions.contains(permission);
                actions.insert(
                    item_id.clone(),
                    DirSelectionAction::SetPermissions(SessionDirPermissionsSetParams {
                        session_id: session_id.clone(),
                        path: dir.path.clone(),
                        expected_revision: result.revision,
                        permissions: toggled_permissions(&dir.permissions, *permission),
                    }),
                );
                items.push(
                    ListSelectionItem::new(permission_title(permission))
                        .with_id(item_id)
                        .with_columns(
                            permission_title(permission),
                            permission_description(permission, &dir),
                            checkbox(enabled),
                        ),
                );
            }
            ListSelectionGroup::new(dir.path.display().to_string(), items)
        })
        .collect::<Vec<_>>();
    if groups.is_empty() {
        groups.push(ListSelectionGroup::new("Directories", Vec::new()));
    }
    let show_tabs = groups.len() > 1;
    let model = ListSelectionModel::new(title, groups)
        .with_activation(bindings::DIR_CHANGE)
        .with_input(SearchBoxModel::new("Enter directory path"))
        .with_empty_message("No directories");
    DirChoices {
        model: if show_tabs {
            model
        } else {
            model.without_tab_bar()
        },
        actions,
    }
}

fn all_permissions() -> &'static [PermissionDto] {
    use PermissionDto as Permission;
    &[
        Permission::ReadFiles,
        Permission::WriteFiles,
        Permission::ExecuteCommands,
        Permission::WatchFiles,
        Permission::BrowseFiles,
        Permission::SearchFiles,
        Permission::LoadInstructions,
        Permission::LoadConfig,
        Permission::DiscoverSkills,
        Permission::DiscoverMcp,
        Permission::UseLanguageServices,
        Permission::DiscoverHooks,
        Permission::DiscoverPlugins,
        Permission::InspectRepository,
        Permission::MutateRepository,
    ]
}

fn toggled_permissions(current: &[PermissionDto], permission: PermissionDto) -> Vec<PermissionDto> {
    let mut permissions = current
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if !permissions.remove(&permission) {
        permissions.insert(permission);
    }
    permissions.into_iter().collect()
}

fn permission_id(permission: &PermissionDto) -> &'static str {
    match permission {
        PermissionDto::ReadFiles => "read-files",
        PermissionDto::WriteFiles => "write-files",
        PermissionDto::ExecuteCommands => "execute-commands",
        PermissionDto::WatchFiles => "watch-files",
        PermissionDto::BrowseFiles => "browse-files",
        PermissionDto::SearchFiles => "search-files",
        PermissionDto::LoadInstructions => "load-instructions",
        PermissionDto::LoadConfig => "load-config",
        PermissionDto::DiscoverSkills => "skills",
        PermissionDto::DiscoverMcp => "mcp",
        PermissionDto::UseLanguageServices => "lsp",
        PermissionDto::DiscoverHooks => "hooks",
        PermissionDto::DiscoverPlugins => "plugins",
        PermissionDto::InspectRepository => "inspect-repository",
        PermissionDto::MutateRepository => "mutate-repository",
    }
}

fn permission_title(permission: &PermissionDto) -> &'static str {
    match permission {
        PermissionDto::ReadFiles => "Read files",
        PermissionDto::WriteFiles => "Modify files",
        PermissionDto::ExecuteCommands => "Run commands",
        PermissionDto::WatchFiles => "Watch file changes",
        PermissionDto::BrowseFiles => "Browse files",
        PermissionDto::SearchFiles => "Search files",
        PermissionDto::LoadInstructions => "Load instructions",
        PermissionDto::LoadConfig => "Load config",
        PermissionDto::DiscoverSkills => "Skills",
        PermissionDto::DiscoverMcp => "MCP",
        PermissionDto::UseLanguageServices => "LSP",
        PermissionDto::DiscoverHooks => "Hooks",
        PermissionDto::DiscoverPlugins => "Plugins",
        PermissionDto::InspectRepository => "Inspect repository",
        PermissionDto::MutateRepository => "Mutate repository",
    }
}

fn permission_description(
    permission: &PermissionDto,
    directory: &ash_app_server_protocol::protocol::environment::SessionDirDto,
) -> String {
    match permission {
        PermissionDto::ReadFiles => "Allow read_file, grep and glob".into(),
        PermissionDto::WriteFiles => "Allow file-writing tools and apply_patch".into(),
        PermissionDto::ExecuteCommands => "Allow shell-command and Session terminals".into(),
        PermissionDto::WatchFiles => "Watch this directory for file changes".into(),
        PermissionDto::BrowseFiles => "Show this directory in file browsing surfaces".into(),
        PermissionDto::SearchFiles => "Search file contents in this directory".into(),
        PermissionDto::LoadInstructions => "Load .ash/instructions and .ash/agents".into(),
        PermissionDto::LoadConfig => "Load configuration supplied by this directory".into(),
        PermissionDto::DiscoverSkills => format!(
            "Discover Skills from this directory ({} found); requires Read files",
            directory.contributions.skills.len()
        ),
        PermissionDto::DiscoverMcp => format!(
            "Authorize MCP declarations ({} found); connect them separately",
            directory.contributions.mcp_servers.len()
        ),
        PermissionDto::UseLanguageServices => {
            "Use language servers for this directory; starting them also requires Run commands"
                .into()
        }
        PermissionDto::DiscoverHooks => format!(
            "Discover Hooks ({} found); running them also requires Run commands",
            directory.contributions.hooks.len()
        ),
        PermissionDto::DiscoverPlugins => format!(
            "Authorize Plugin requests ({} found); installation stays separate",
            directory.contributions.plugins.len()
        ),
        PermissionDto::InspectRepository => "Read repository metadata and status".into(),
        PermissionDto::MutateRepository => "Change repository state".into(),
    }
}

const fn checkbox(checked: bool) -> &'static str {
    if checked { "[ ✔ ]" } else { "[   ]" }
}

#[cfg(test)]
#[path = "dirs_tests.rs"]
mod tests;
