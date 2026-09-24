use crate::client::new_command_id;
use crate::dirs;
use crate::dirs::DirChoices;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::environment::DirPermissionsReadParams;
use ash_app_server_protocol::protocol::environment::SessionDirAddParams;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirListResult;
use ash_app_server_protocol::protocol::projects::ProjectCreateParams;
use ash_app_server_protocol::protocol::projects::ProjectDto;
use ash_app_server_protocol::protocol::projects::ProjectReadParams;
use ash_app_server_protocol::protocol::projects::ProjectRootAddParams;
use ash_app_server_protocol::protocol::projects::ProjectSessionMutationParams;
use ash_app_server_protocol::protocol::projects::ProjectStatusDto;
use ash_protocol::ProjectId;
use ash_protocol::SessionId;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

pub(crate) type RootChoices = ListSelectionSpec<RootSelectionAction>;

pub(crate) enum Event {
    RootsOpened(RootChoices),
    AddRootOpened(DirChoices),
    AddRootFinished {
        request_id: u64,
        result: Result<dirs::AddedDir, String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenRoots,
    OpenAddRoot,
    AddRoot { request_id: u64, path: PathBuf },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenRoots => "ash-tui-list-project-roots",
            Self::OpenAddRoot => "ash-tui-open-project-root-editor",
            Self::AddRoot { .. } => "ash-tui-add-project-root",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RootSelectionAction {
    Switch { path: PathBuf, current: bool },
    Add,
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    workspace: &Path,
    session_id: Option<&SessionId>,
    command: Command,
) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::OpenRoots => {
            let session_id =
                session_id.ok_or("Start or resume a session before viewing Project folders")?;
            let project = match current_project(client, workspace, Some(session_id))? {
                Some(project) => project,
                None => create_project(client, workspace, session_id)?,
            };
            Ok(Event::RootsOpened(root_choices(&project, workspace)))
        }
        Command::OpenAddRoot => {
            let session_id =
                session_id.ok_or("Start or resume a session before adding a Project folder")?;
            let result = client
                .list_session_dirs(SessionDirListParams {
                    session_id: session_id.clone(),
                })
                .map_err(|error| error.to_string())?;
            Ok(Event::AddRootOpened(dirs::project_choices(
                session_id, result,
            )))
        }
        Command::AddRoot { request_id, path } => {
            let result = session_id
                .ok_or_else(|| {
                    "Start or resume a session before adding a Project folder".to_owned()
                })
                .and_then(|session_id| add_root(client, workspace, session_id, path));
            Ok(Event::AddRootFinished { request_id, result })
        }
    }
}

fn current_project<T>(
    client: &mut AppServerClient<T>,
    workspace: &Path,
    session_id: Option<&SessionId>,
) -> Result<Option<ProjectDto>, String>
where
    T: JsonRpcTransport,
{
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let summaries = client.list_projects().map_err(|error| error.to_string())?;
    let mut matches = Vec::new();
    for summary in summaries.projects {
        if summary.status != ProjectStatusDto::Active {
            continue;
        }
        let project = client
            .read_project(ProjectReadParams {
                project_id: summary.project_id,
            })
            .map_err(|error| error.to_string())?
            .project;
        if project.roots.iter().any(|root| {
            root.path
                .to_host_path()
                .is_ok_and(|path| path.as_path() == workspace)
        }) {
            matches.push(project);
        }
    }
    if matches.len() <= 1 {
        return Ok(matches.pop());
    }
    if let Some(session_id) = session_id {
        let mut linked = matches
            .iter()
            .filter(|project| project.session_ids.contains(session_id));
        if let Some(project) = linked.next()
            && linked.next().is_none()
        {
            return Ok(Some(project.clone()));
        }
    }
    Err("This workspace belongs to multiple Projects; choose one from Dashboard first".into())
}

fn add_root<T>(
    client: &mut AppServerClient<T>,
    workspace: &Path,
    session_id: &SessionId,
    path: PathBuf,
) -> Result<dirs::AddedDir, String>
where
    T: JsonRpcTransport,
{
    let target = client
        .add_session_dir(SessionDirAddParams {
            session_id: session_id.clone(),
            path,
            permissions: Vec::new(),
        })
        .map_err(|error| error.to_string())?;
    let target_id = dir_id(client, &target.path)?;
    let canonical_path = target.path.clone();
    let mut project = match current_project(client, workspace, Some(session_id))? {
        Some(project) => project,
        None => create_project(client, workspace, session_id)?,
    };
    if !project.session_ids.contains(session_id) {
        project = client
            .link_project_session(ProjectSessionMutationParams {
                command_id: new_command_id("project-session-link"),
                project_id: project.project_id.clone(),
                expected_revision: project.revision,
                session_id: session_id.clone(),
            })
            .map_err(|error| error.to_string())?
            .project;
    }
    let root_present = project.roots.iter().any(|root| root.dir_id == target_id);
    if !root_present {
        client
            .add_project_root(ProjectRootAddParams {
                command_id: new_command_id("project-root-add"),
                project_id: project.project_id,
                expected_revision: project.revision,
                session_id: session_id.clone(),
                dir_id: target_id,
                name: path_name(&canonical_path),
                purpose: "Project folder".into(),
            })
            .map_err(|error| error.to_string())?;
    }
    let choices = dirs::project_choices(
        session_id,
        SessionDirListResult {
            revision: target.revision,
            dirs: target.dirs,
        },
    );
    Ok(dirs::AddedDir {
        path: canonical_path,
        already_present: root_present,
        choices,
    })
}

fn create_project<T>(
    client: &mut AppServerClient<T>,
    workspace: &Path,
    session_id: &SessionId,
) -> Result<ProjectDto, String>
where
    T: JsonRpcTransport,
{
    let workspace_dir = client
        .add_session_dir(SessionDirAddParams {
            session_id: session_id.clone(),
            path: workspace.to_path_buf(),
            permissions: Vec::new(),
        })
        .map_err(|error| error.to_string())?;
    let workspace_dir_id = dir_id(client, &workspace_dir.path)?;
    let project_id = ProjectId::new(format!(
        "project-{}",
        workspace_dir_id
            .as_str()
            .strip_prefix("sha256:")
            .expect("DirId always has the sha256 prefix")
    ))
    .map_err(|error| error.to_string())?;
    let existing = client
        .list_projects()
        .map_err(|error| error.to_string())?
        .projects
        .into_iter()
        .any(|summary| summary.project_id == project_id);
    let mut project = if existing {
        client
            .read_project(ProjectReadParams { project_id })
            .map_err(|error| error.to_string())?
            .project
    } else {
        client
            .create_project(ProjectCreateParams {
                command_id: new_command_id("project-create"),
                project_id,
                name: path_name(workspace),
                description: String::new(),
            })
            .map_err(|error| error.to_string())?
            .project
    };
    if !project
        .roots
        .iter()
        .any(|root| root.dir_id == workspace_dir_id)
    {
        project = client
            .add_project_root(ProjectRootAddParams {
                command_id: new_command_id("project-root-add"),
                project_id: project.project_id.clone(),
                expected_revision: project.revision,
                session_id: session_id.clone(),
                dir_id: workspace_dir_id,
                name: path_name(workspace),
                purpose: "Primary workspace".into(),
            })
            .map_err(|error| error.to_string())?
            .project;
    }
    Ok(project)
}

fn dir_id<T>(client: &mut AppServerClient<T>, path: &Path) -> Result<ash_file_access::DirId, String>
where
    T: JsonRpcTransport,
{
    client
        .read_dir_permissions(DirPermissionsReadParams {
            path: path.to_path_buf(),
        })
        .map(|result| result.dir)
        .map_err(|error| error.to_string())
}

fn path_name(path: &Path) -> String {
    path.file_name()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

pub(crate) fn root_choices(project: &ProjectDto, workspace: &Path) -> RootChoices {
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let current_environment = project
        .roots
        .iter()
        .find(|root| {
            root.path
                .to_host_path()
                .is_ok_and(|path| path.as_path() == workspace)
        })
        .map(|root| root.environment_id.clone())
        .expect("Project root choices require the current workspace root");
    let mut actions = BTreeMap::new();
    let mut current = 0;
    let mut items: Vec<ListSelectionItem> = project
        .roots
        .iter()
        .filter(|root| root.environment_id == current_environment)
        .enumerate()
        .map(|(index, root)| {
            let path = root
                .path
                .to_host_path()
                .expect("Project roots in the current environment must be on this host");
            let is_current = path.as_path() == workspace;
            if is_current {
                current = index;
            }
            let id = ListSelectionItemId::new(format!("project-root:{}", root.dir_id));
            actions.insert(
                id.clone(),
                RootSelectionAction::Switch {
                    path: path.as_path().to_path_buf(),
                    current: is_current,
                },
            );
            ListSelectionItem::new(&root.name)
                .with_id(id)
                .with_description(path.as_path().display().to_string())
        })
        .collect();
    let add_id = ListSelectionItemId::new("project-root:add");
    actions.insert(add_id.clone(), RootSelectionAction::Add);
    items.push(
        ListSelectionItem::new("+ Add folder to project…")
            .with_id(add_id)
            .with_description("Add a directory to this project"),
    );
    RootChoices {
        model: ListSelectionModel::new(
            "Switch project folder",
            vec![ListSelectionGroup::new(&project.name, items)],
        )
        .with_search(SearchBoxModel::new("Search project folders"))
        .with_initial_selected(current)
        .without_tab_bar()
        .with_empty_message("No matching project folders"),
        actions,
    }
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
