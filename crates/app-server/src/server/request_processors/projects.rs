use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::project_projection;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::projects::ProjectAppearanceFieldDto;
use ash_app_server_protocol::protocol::projects::ProjectAppearanceUpdateParams;
use ash_app_server_protocol::protocol::projects::ProjectBotRemoveParams;
use ash_app_server_protocol::protocol::projects::ProjectChanged;
use ash_app_server_protocol::protocol::projects::ProjectCommandDispositionDto;
use ash_app_server_protocol::protocol::projects::ProjectConversationMembership;
use ash_app_server_protocol::protocol::projects::ProjectConversationMembershipParams;
use ash_app_server_protocol::protocol::projects::ProjectCreateParams;
use ash_app_server_protocol::protocol::projects::ProjectDetailsUpdateParams;
use ash_app_server_protocol::protocol::projects::ProjectLifecycleParams;
use ash_app_server_protocol::protocol::projects::ProjectListParams;
use ash_app_server_protocol::protocol::projects::ProjectListResult;
use ash_app_server_protocol::protocol::projects::ProjectMaterialDto;
use ash_app_server_protocol::protocol::projects::ProjectMutationResult;
use ash_app_server_protocol::protocol::projects::ProjectReadParams;
use ash_app_server_protocol::protocol::projects::ProjectReadResult;
use ash_app_server_protocol::protocol::projects::ProjectRootAddParams;
use ash_app_server_protocol::protocol::projects::ProjectRootRemoveParams;
use ash_app_server_protocol::protocol::projects::ProjectRootUpdateParams;
use ash_app_server_protocol::protocol::projects::ProjectScopeDto;
use ash_app_server_protocol::protocol::projects::ProjectSessionMutationParams;
use ash_app_server_protocol::protocol::projects::ProjectTeamEnsureParams;
use ash_projects::ProjectCommand;
use ash_projects::ProjectCommandDisposition;
use ash_projects::ProjectCommandRequest;
use ash_projects::ProjectCommandResult;
use ash_projects::ProjectCoordinator;
use ash_projects::ProjectError;
use ash_projects::ProjectMaterial;
use ash_projects::ProjectRoot;
use ash_projects::ProjectScope;
use ash_protocol::AgentId;
use ash_protocol::AgentRoleSelection;
use ash_protocol::AgentRoleSource;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use ash_protocol::TeamId;
use ash_teams::Team;
use ash_teams::TeamCommand;
use ash_teams::TeamCommandRequest;
use ash_teams::TeamCoordinator;
use ash_teams::TeamError;
use ash_teams::TeamMember;
use ash_teams::TeamStatus;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::path::PathBuf;

/// Borrows only the projects domain services for one request.
/// Composition retains their lifetimes; this adapter cannot access other server state.
pub(super) struct ProjectRequestProcessor<'a> {
    env_runtime: &'a super::Arc<super::RwLock<super::EnvRuntime>>,
    projects: &'a Option<super::Arc<ash_projects::ProjectCoordinator>>,
    teams: &'a Option<super::Arc<TeamCoordinator>>,
    threads: &'a super::Arc<super::ThreadController>,
    updates: &'a super::Arc<super::UpdateBroker>,
}

impl<'a> ProjectRequestProcessor<'a> {
    pub(super) fn new(
        env_runtime: &'a super::Arc<super::RwLock<super::EnvRuntime>>,
        projects: &'a Option<super::Arc<ash_projects::ProjectCoordinator>>,
        teams: &'a Option<super::Arc<TeamCoordinator>>,
        threads: &'a super::Arc<super::ThreadController>,
        updates: &'a super::Arc<super::UpdateBroker>,
    ) -> Self {
        Self {
            env_runtime,
            projects,
            teams,
            threads,
            updates,
        }
    }
}

impl<'a> ProjectRequestProcessor<'a> {
    pub(super) fn project_team_ensure(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectTeamEnsureParams = decode(params)?;
        let project = self
            .project_coordinator(connection)?
            .read(&params.project_id)
            .map_err(project_error)?;
        if !connection.allows_team_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        if !project.is_active() || project.scope() != ProjectScope::Code {
            return Err(project_error(ProjectError::InvalidTransition(
                "an active Code Project is required".into(),
            )));
        }
        if project.default_team_id.is_some() {
            return result(&ProjectMutationResult {
                disposition: ProjectCommandDispositionDto::Replayed,
                project: project_projection::project(&project),
            });
        }
        let teams = self
            .teams
            .as_deref()
            .ok_or_else(|| RpcError::new(-32100, AppServerErrorName::TeamsUnavailable))?;
        // A stable creation identity recovers a Team committed before the Project link.
        let digest = project_team_digest(&params.project_id);
        let team_id = TeamId::new(format!("project-team:{digest}")).expect("valid Project Team ID");
        match teams.read(&team_id) {
            Ok(_) => {}
            Err(TeamError::NotFound(_)) => {
                let ash = project_ash_member(&digest, params.coordinator_responsibility);
                teams
                    .apply(&TeamCommandRequest {
                        command_id: CommandId::new(format!("project-team-create:{digest}"))
                            .expect("valid command ID"),
                        team_id: team_id.clone(),
                        expected_revision: 0,
                        command: TeamCommand::Create {
                            name: project.name,
                            description: String::new(),
                            coordinator_id: ash.agent_id.clone(),
                            members: vec![ash],
                        },
                    })
                    .map_err(super::team_operations::team_error)?;
            }
            Err(error) => return Err(super::team_operations::team_error(error)),
        }
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: CommandId::new(format!("project-team-link:{digest}"))
                    .expect("valid command ID"),
                project_id: params.project_id,
                expected_revision: project.revision,
                command: ProjectCommand::SetDefaultTeam { team_id },
            },
        )
    }

    pub(super) fn project_bot_remove(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectBotRemoveParams = decode(params)?;
        let project = self
            .project_coordinator(connection)?
            .read(&params.project_id)
            .map_err(project_error)?;
        if !connection.allows_team_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        if !project.is_active() || project.scope() != ProjectScope::Code {
            return Err(invalid_project_reference());
        }
        let Some(team_id) = project.default_team_id else {
            return result(&());
        };
        let teams = self.teams.as_deref().ok_or_else(teams_unavailable)?;
        let team = teams
            .read(&team_id)
            .map_err(super::team_operations::team_error)?;
        if team.revision != params.expected_team_revision {
            return Err(super::team_operations::team_error(
                TeamError::RevisionConflict,
            ));
        }
        let Some(member) = team.members.get(&params.member_id) else {
            return result(&());
        };
        if team.status != TeamStatus::Active || member.role == AgentRoleSelection::Default {
            return Err(invalid_project_reference());
        }
        remove_project_bots(
            teams,
            team,
            vec![params.member_id],
            params.command_id,
            &project_team_digest(&params.project_id),
            &params.coordinator_responsibility,
        )?;
        result(&())
    }

    /// Removes a definition from every Project roster before its profile file is deleted.
    pub(super) fn remove_user_bot_from_projects(
        &self,
        name: &str,
        coordinator_responsibility: &str,
    ) -> Result<(), RpcError> {
        let Some(projects) = self.projects.as_deref() else {
            return Ok(());
        };
        let role = AgentRoleSelection::Exact {
            source: AgentRoleSource::User,
            name: name.to_owned(),
        };
        for project in projects.list().map_err(project_error)? {
            let Some(team_id) = project.default_team_id.as_ref() else {
                continue;
            };
            let teams = self.teams.as_deref().ok_or_else(teams_unavailable)?;
            let team = match teams.read(team_id) {
                Ok(team) => team,
                Err(TeamError::NotFound(_)) => continue,
                Err(error) => return Err(super::team_operations::team_error(error)),
            };
            let member_ids = team
                .members
                .values()
                .filter(|member| member.role == role)
                .map(|member| member.agent_id.clone())
                .collect::<Vec<_>>();
            if member_ids.is_empty() {
                continue;
            }
            let digest = project_team_digest(&project.project_id);
            let command_id =
                CommandId::new(format!("project-bot-delete:{digest}:{}", team.revision))
                    .expect("valid project roster cleanup command ID");
            remove_project_bots(
                teams,
                team,
                member_ids,
                command_id,
                &digest,
                coordinator_responsibility,
            )?;
        }
        Ok(())
    }

    pub(super) fn project_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectListParams = decode(params)?;
        let scope = params.scope.map(project_scope);
        let projects = self
            .project_coordinator(connection)?
            .list()
            .map_err(project_error)?
            .iter()
            .filter(|project| scope.is_none_or(|scope| scope == project.scope()))
            .map(project_projection::summary)
            .collect();
        result(&ProjectListResult { projects })
    }

    pub(super) fn project_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectReadParams = decode(params)?;
        let project = self
            .project_coordinator(connection)?
            .read(&params.project_id)
            .map_err(project_error)?;
        if params
            .scope
            .is_some_and(|scope| project_scope(scope) != project.scope())
        {
            return Err(project_error(ProjectError::NotFound(
                params.project_id.to_string(),
            )));
        }
        result(&ProjectReadResult {
            project: project_projection::project(&project),
        })
    }

    pub(super) fn project_create(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectCreateParams = decode(params)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: 0,
                command: ProjectCommand::Create {
                    name: params.name,
                    description: params.description,
                    scope: params.scope.map(project_scope),
                    icon: params.icon,
                    color: params.color,
                    materials: params
                        .materials
                        .into_iter()
                        .map(material_from_dto)
                        .collect::<Result<_, _>>()?,
                },
            },
        )
    }

    pub(super) fn project_details_update(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectDetailsUpdateParams = decode(params)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command: ProjectCommand::UpdateDetails {
                    name: params.name,
                    description: params.description,
                    materials: params
                        .materials
                        .map(|materials| {
                            materials
                                .into_iter()
                                .map(material_from_dto)
                                .collect::<Result<_, _>>()
                        })
                        .transpose()?,
                },
            },
        )
    }

    pub(super) fn project_appearance_update(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectAppearanceUpdateParams = decode(params)?;
        let command = match params.field {
            ProjectAppearanceFieldDto::Icon => ProjectCommand::SetIcon { icon: params.value },
            ProjectAppearanceFieldDto::Color => ProjectCommand::SetColor {
                color: params.value,
            },
        };
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command,
            },
        )
    }

    pub(super) fn project_root_add(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectRootAddParams = decode(params)?;
        let dir = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .dir_grants
            .list(&params.session_id)
            .into_iter()
            .find(|entry| entry.dir().id() == params.dir_id)
            .map(|entry| entry.dir().clone())
            .ok_or_else(invalid_project_reference)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command: ProjectCommand::AddRoot {
                    root: ProjectRoot {
                        environment_id: dir.env().clone(),
                        dir_id: dir.id(),
                        path: dir.canonical_path().to_path_buf(),
                        name: params.name,
                        purpose: params.purpose,
                    },
                },
            },
        )
    }

    pub(super) fn project_root_update(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectRootUpdateParams = decode(params)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command: ProjectCommand::UpdateRootDetails {
                    dir_id: params.dir_id,
                    name: params.name,
                    purpose: params.purpose,
                },
            },
        )
    }

    pub(super) fn project_root_remove(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectRootRemoveParams = decode(params)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command: ProjectCommand::RemoveRoot {
                    dir_id: params.dir_id,
                },
            },
        )
    }

    pub(super) fn project_session_link(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectSessionMutationParams = decode(params)?;
        if self
            .threads
            .list_session_threads(&params.session_id)
            .map_err(|_| invalid_project_reference())?
            .is_empty()
        {
            return Err(invalid_project_reference());
        }
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command: ProjectCommand::LinkSession {
                    session_id: params.session_id,
                },
            },
        )
    }

    pub(super) fn project_session_unlink(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectSessionMutationParams = decode(params)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command: ProjectCommand::UnlinkSession {
                    session_id: params.session_id,
                },
            },
        )
    }

    pub(super) fn project_conversation_membership(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ProjectConversationMembershipParams = decode(params)?;
        let conversation_id = params.conversation_id;
        let command = match params.membership {
            ProjectConversationMembership::Link => {
                ProjectCommand::LinkExternalConversation { conversation_id }
            }
            ProjectConversationMembership::Unlink => {
                ProjectCommand::UnlinkExternalConversation { conversation_id }
            }
        };
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command,
            },
        )
    }

    pub(super) fn project_archive(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        self.apply_project_lifecycle(connection, params, ProjectCommand::Archive)
    }

    pub(super) fn project_restore(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        self.apply_project_lifecycle(connection, params, ProjectCommand::Restore)
    }

    pub(super) fn project_delete(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        self.apply_project_lifecycle(connection, params, ProjectCommand::Delete)
    }

    fn apply_project_lifecycle(
        &self,
        connection: &ConnectionState,
        params: &Value,
        command: ProjectCommand,
    ) -> Result<Value, RpcError> {
        let params: ProjectLifecycleParams = decode(params)?;
        self.apply_project(
            connection,
            ProjectCommandRequest {
                command_id: params.command_id,
                project_id: params.project_id,
                expected_revision: params.expected_revision,
                command,
            },
        )
    }

    fn apply_project(
        &self,
        connection: &ConnectionState,
        request: ProjectCommandRequest,
    ) -> Result<Value, RpcError> {
        let command = self
            .project_coordinator(connection)?
            .apply(request)
            .map_err(project_error)?;
        let response = mutation_result(&command);
        if command.disposition == ProjectCommandDisposition::Committed {
            self.updates.publish_project_changed(ProjectChanged {
                project: response.project.clone(),
            });
        }
        result(&response)
    }

    fn project_coordinator(
        &self,
        connection: &ConnectionState,
    ) -> Result<&'a ProjectCoordinator, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        self.projects.as_deref().ok_or_else(projects_unavailable)
    }
}

fn mutation_result(command: &ProjectCommandResult) -> ProjectMutationResult {
    ProjectMutationResult {
        disposition: match command.disposition {
            ProjectCommandDisposition::Committed => ProjectCommandDispositionDto::Committed,
            ProjectCommandDisposition::Replayed => ProjectCommandDispositionDto::Replayed,
        },
        project: project_projection::project(&command.project),
    }
}

fn projects_unavailable() -> RpcError {
    RpcError::new(-32094, AppServerErrorName::ProjectsUnavailable)
}

fn teams_unavailable() -> RpcError {
    RpcError::new(-32100, AppServerErrorName::TeamsUnavailable)
}

fn project_team_digest(project_id: &ProjectId) -> String {
    format!("{:x}", Sha256::digest(project_id.as_str()))
}

fn project_ash_member(digest: &str, responsibility: String) -> TeamMember {
    TeamMember {
        agent_id: AgentId::new(format!("project-coordinator:{digest}"))
            .expect("valid Project coordinator ID"),
        name: "Ash".into(),
        responsibility,
        role: AgentRoleSelection::Default,
    }
}

fn remove_project_bots(
    teams: &TeamCoordinator,
    team: Team,
    agent_ids: Vec<AgentId>,
    command_id: CommandId,
    project_digest: &str,
    coordinator_responsibility: &str,
) -> Result<(), RpcError> {
    let ash = project_ash_member(project_digest, coordinator_responsibility.to_owned());
    let fallback = team
        .members
        .get(&ash.agent_id)
        .filter(|member| member.role == AgentRoleSelection::Default)
        .cloned()
        .unwrap_or(ash);
    teams
        .apply(&TeamCommandRequest {
            command_id,
            team_id: team.team_id,
            expected_revision: team.revision,
            command: TeamCommand::RemoveMembersWithFallback {
                agent_ids,
                fallback,
            },
        })
        .map_err(super::team_operations::team_error)?;
    Ok(())
}

fn invalid_project_reference() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn project_scope(scope: ProjectScopeDto) -> ProjectScope {
    match scope {
        ProjectScopeDto::Chat => ProjectScope::Chat,
        ProjectScopeDto::Code => ProjectScope::Code,
    }
}

fn project_error(error: ProjectError) -> RpcError {
    match error {
        ProjectError::NotFound(_) => RpcError::new(-32095, AppServerErrorName::ProjectNotFound),
        ProjectError::RevisionConflict { .. } => {
            RpcError::new(-32096, AppServerErrorName::ProjectRevisionConflict)
        }
        ProjectError::CommandConflict => RpcError::new(-32012, AppServerErrorName::CommandConflict),
        ProjectError::AlreadyExists(_)
        | ProjectError::InvalidInput(_)
        | ProjectError::InvalidTransition(_)
        | ProjectError::Storage(_) => {
            RpcError::new(-32097, AppServerErrorName::ProjectOperationFailed)
        }
    }
}

fn material_from_dto(material: ProjectMaterialDto) -> Result<ProjectMaterial, RpcError> {
    let host_path = |path: ash_utils_path_uri::PathUri| -> Result<PathBuf, RpcError> {
        Ok(path
            .to_host_path()
            .map_err(|_| invalid_project_reference())?
            .as_path()
            .to_path_buf())
    };
    Ok(match material {
        ProjectMaterialDto::File {
            path,
            name,
            size_bytes,
        } => ProjectMaterial::File {
            path: host_path(path)?,
            name,
            size_bytes,
        },
        ProjectMaterialDto::Folder { path, name } => ProjectMaterial::Folder {
            path: host_path(path)?,
            name,
        },
        ProjectMaterialDto::Text { id, name, content } => {
            ProjectMaterial::Text { id, name, content }
        }
    })
}
