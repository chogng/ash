use super::operations::{
    ThreadMutation, TurnInstructionSelection, TurnModelSelection, TurnToolModeSelection,
};
use super::{AppServer, ConnectionState, RpcError, core_error, decode, result};
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::teams::*;
use ash_protocol::CommandId;
use ash_teams::{
    Team, TeamCommand, TeamCommandRequest, TeamCoordinator, TeamError, TeamMember, TeamMessage,
    TeamRun, TeamRunRequest, TeamStatus,
};
use core_api::{AgentRuntime, StartThreadRequest};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

impl AppServer {
    pub(super) fn team_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let _: TeamListParams = decode(params)?;
        let teams = self
            .team_coordinator(connection)?
            .list()
            .map_err(team_error)?
            .iter()
            .map(team_dto)
            .collect();
        result(&TeamListResult { teams })
    }

    pub(super) fn team_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamReadParams = decode(params)?;
        let team = self
            .team_coordinator(connection)?
            .read(&params.team_id)
            .map_err(team_error)?;
        result(&TeamReadResult {
            team: team_dto(&team),
        })
    }

    pub(super) fn team_command(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamCommandParams = decode(params)?;
        let request = TeamCommandRequest {
            command_id: params.command_id,
            team_id: params.team_id,
            expected_revision: params.expected_revision,
            command: match params.command {
                TeamCommandDto::Create {
                    name,
                    description,
                    coordinator_id,
                    members,
                } => TeamCommand::Create {
                    name,
                    description,
                    coordinator_id,
                    members: members.into_iter().map(team_member).collect(),
                },
                TeamCommandDto::UpdateDetails { name, description } => {
                    TeamCommand::UpdateDetails { name, description }
                }
                TeamCommandDto::AddMember { member } => TeamCommand::AddMember {
                    member: team_member(member),
                },
                TeamCommandDto::UpdateMember { member } => TeamCommand::UpdateMember {
                    member: team_member(member),
                },
                TeamCommandDto::RemoveMember { agent_id } => TeamCommand::RemoveMember { agent_id },
                TeamCommandDto::SetCoordinator { agent_id } => {
                    TeamCommand::SetCoordinator { agent_id }
                }
                TeamCommandDto::Archive => TeamCommand::Archive,
                TeamCommandDto::Restore => TeamCommand::Restore,
            },
        };
        let (team, replayed) = self
            .team_coordinator(connection)?
            .apply(&request)
            .map_err(team_error)?;
        result(&TeamCommandResult {
            team: team_dto(&team),
            replayed,
        })
    }

    pub(super) fn team_run_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamRunStartParams = decode(params)?;
        let teams = self.team_coordinator(connection)?;
        if let Some((prior, run)) = teams
            .read_run_command(&params.command_id)
            .map_err(team_error)?
        {
            if prior.run_id != params.run_id
                || prior.team_id != params.team_id
                || prior.expected_team_revision != params.expected_team_revision
                || prior.objective != params.objective
            {
                return Err(team_error(TeamError::CommandConflict));
            }
            self.bind_session_runtime(&run.session_id)
                .map_err(core_error)?;
            self.ensure_team_turn(connection, &run)?;
            return result(&TeamRunStartResult {
                run: run_dto(&run),
                replayed: true,
            });
        }
        match teams.read_run(&params.run_id) {
            Ok(_) => return Err(team_error(TeamError::CommandConflict)),
            Err(TeamError::NotFound(_)) => {}
            Err(error) => return Err(team_error(error)),
        }
        let team = teams.read(&params.team_id).map_err(team_error)?;
        if team.status != TeamStatus::Active
            || team.revision != params.expected_team_revision
            || params.objective.trim().is_empty()
        {
            return Err(team_error(TeamError::RevisionConflict));
        }
        let coordinator = team
            .members
            .get(&team.coordinator_id)
            .ok_or_else(|| team_error(TeamError::MemberUnauthorized))?;
        let thread_command_id = CommandId::new(format!("team-run:{}:thread", params.run_id))
            .map_err(|error| team_error(TeamError::InvalidInput(error.to_string())))?;
        let title = format!("{}: {}", team.name, params.objective);
        let existing = self
            .agent_runtime()
            .read_started_thread(&thread_command_id)
            .map_err(core_error)?;
        let thread = match existing {
            Some(thread) => {
                if thread.agent_id != team.coordinator_id || thread.title != title {
                    return Err(team_error(TeamError::CommandConflict));
                }
                thread
            }
            None => {
                let agent = self
                    .resolve_root_agent(&coordinator.role)
                    .map_err(core_error)?;
                self.agent_runtime()
                    .start_thread(StartThreadRequest {
                        agent_id: Some(team.coordinator_id.clone()),
                        command_id: thread_command_id,
                        title,
                        agent,
                        branch_name: None,
                        execution_target: self.dir_services.as_ref().map(|dirs| {
                            ash_protocol::SessionExecutionTarget::Local {
                                root: dirs.root.clone(),
                            }
                        }),
                    })
                    .map_err(core_error)?
            }
        };
        let request = TeamRunRequest {
            command_id: params.command_id,
            run_id: params.run_id,
            team_id: params.team_id,
            expected_team_revision: params.expected_team_revision,
            session_id: thread.session_id.clone(),
            coordinator_thread_id: thread.thread_id.clone(),
            objective: params.objective,
        };
        let (run, replayed) = teams.start_run(&request).map_err(team_error)?;
        self.bind_session_runtime(&run.session_id)
            .map_err(core_error)?;
        self.updates.publish_session_changed(&run.session_id);
        self.ensure_team_turn(connection, &run)?;
        result(&TeamRunStartResult {
            run: run_dto(&run),
            replayed,
        })
    }

    pub(super) fn team_run_attach(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamRunAttachParams = decode(params)?;
        let request = TeamRunRequest {
            command_id: params.command_id,
            run_id: params.run_id,
            team_id: params.team_id,
            expected_team_revision: params.expected_team_revision,
            session_id: params.session_id,
            coordinator_thread_id: params.coordinator_thread_id,
            objective: params.objective,
        };
        let (run, replayed) = self
            .team_coordinator(connection)?
            .start_run(&request)
            .map_err(team_error)?;
        self.bind_session_runtime(&run.session_id)
            .map_err(core_error)?;
        result(&TeamRunStartResult {
            run: run_dto(&run),
            replayed,
        })
    }

    fn ensure_team_turn(
        &self,
        connection: &ConnectionState,
        run: &TeamRun,
    ) -> Result<(), RpcError> {
        let thread = self
            .threads
            .read_thread(&run.coordinator_thread_id)
            .map_err(core_error)?;
        // The run is committed before its first Turn; replay resumes this step after a crash.
        if !thread.turns.is_empty() {
            return Ok(());
        }
        let members = run
            .members
            .values()
            .map(|member| {
                format!(
                    "- {} (member_id: {}): {}",
                    member.name, member.agent_id, member.responsibility
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "Team task (team_run_id: {}): {}\n\nTeam members:\n{}\n\nCoordinate the work. Delegate to a listed member with spawn_agent, passing team_run_id and member_id. Use team_read_messages for earlier decisions and team_post_message to preserve decisions for later tasks.",
            run.run_id, run.objective, members,
        );
        let turn_command = CommandId::new(format!("team-run:{}:turn", run.run_id))
            .map_err(|error| team_error(TeamError::InvalidInput(error.to_string())))?;
        self.start_agent_turn_request(
            ThreadMutation {
                connection_id: Some(connection.connection_id),
                command_id: turn_command,
                session_id: run.session_id.clone(),
                expected_sequence: thread.sequence,
            },
            run.coordinator_thread_id.clone(),
            ash_protocol::ApprovalMode::default(),
            TurnToolModeSelection::ConfiguredDefault,
            vec![ash_protocol::UserInput::Text { text: prompt }],
            ash_protocol::TurnKind::Coding,
            TurnInstructionSelection::Agent,
            TurnModelSelection::Current,
            None,
        )?;
        Ok(())
    }

    pub(super) fn team_run_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamRunReadParams = decode(params)?;
        let run = self
            .team_coordinator(connection)?
            .read_run(&params.run_id)
            .map_err(team_error)?;
        result(&TeamRunReadResult { run: run_dto(&run) })
    }

    pub(super) fn team_run_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamRunListParams = decode(params)?;
        let runs = self
            .team_coordinator(connection)?
            .list_runs(&params.team_id)
            .map_err(team_error)?
            .iter()
            .map(run_dto)
            .collect();
        result(&TeamRunListResult { runs })
    }

    pub(super) fn team_message_post(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamMessagePostParams = decode(params)?;
        let created_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| team_error(TeamError::Storage(error.to_string())))?
            .as_millis() as u64;
        let message = TeamMessage {
            message_id: params.message_id,
            team_id: params.team_id,
            run_id: params.run_id,
            sender_id: params.sender_id,
            receiver_id: params.receiver_id,
            text: params.text,
            created_at_unix_ms,
        };
        let message = self
            .team_coordinator(connection)?
            .post_message(&message)
            .map_err(team_error)?;
        result(&TeamMessagePostResult {
            message: message_dto(&message),
        })
    }

    pub(super) fn team_message_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TeamMessageListParams = decode(params)?;
        let messages = self
            .team_coordinator(connection)?
            .list_messages(&params.team_id, &params.reader_id)
            .map_err(team_error)?
            .iter()
            .map(message_dto)
            .collect();
        result(&TeamMessageListResult { messages })
    }

    fn team_coordinator(&self, connection: &ConnectionState) -> Result<&TeamCoordinator, RpcError> {
        if !connection.allows_team_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        self.teams
            .as_deref()
            .ok_or_else(|| RpcError::new(-32100, AppServerErrorName::TeamsUnavailable))
    }
}

fn team_member(member: TeamMemberDto) -> TeamMember {
    TeamMember {
        agent_id: member.agent_id,
        name: member.name,
        responsibility: member.responsibility,
        role: member.role,
    }
}

fn member_dto(member: &TeamMember) -> TeamMemberDto {
    TeamMemberDto {
        agent_id: member.agent_id.clone(),
        name: member.name.clone(),
        responsibility: member.responsibility.clone(),
        role: member.role.clone(),
    }
}

fn team_dto(team: &Team) -> TeamDto {
    TeamDto {
        team_id: team.team_id.clone(),
        revision: team.revision,
        status: match team.status {
            TeamStatus::Active => TeamStatusDto::Active,
            TeamStatus::Archived => TeamStatusDto::Archived,
        },
        name: team.name.clone(),
        description: team.description.clone(),
        coordinator_id: team.coordinator_id.clone(),
        members: team.members.values().map(member_dto).collect(),
    }
}

fn run_dto(run: &TeamRun) -> TeamRunDto {
    TeamRunDto {
        run_id: run.run_id.clone(),
        team_id: run.team_id.clone(),
        team_revision: run.team_revision,
        members: run.members.values().map(member_dto).collect(),
        coordinator_id: run.coordinator_id.clone(),
        session_id: run.session_id.clone(),
        coordinator_thread_id: run.coordinator_thread_id.clone(),
        objective: run.objective.clone(),
    }
}

fn message_dto(message: &TeamMessage) -> TeamMessageDto {
    TeamMessageDto {
        message_id: message.message_id.clone(),
        team_id: message.team_id.clone(),
        run_id: message.run_id.clone(),
        sender_id: message.sender_id.clone(),
        receiver_id: message.receiver_id.clone(),
        text: message.text.clone(),
        created_at_unix_ms: message.created_at_unix_ms,
    }
}

fn team_error(error: TeamError) -> RpcError {
    let (code, name) = match error {
        TeamError::NotFound(_) => (-32101, AppServerErrorName::TeamNotFound),
        TeamError::RevisionConflict => (-32102, AppServerErrorName::TeamRevisionConflict),
        TeamError::MemberUnauthorized => (-32103, AppServerErrorName::TeamMemberUnauthorized),
        TeamError::CommandConflict => (-32012, AppServerErrorName::CommandConflict),
        TeamError::AlreadyExists(_) | TeamError::InvalidInput(_) => {
            (-32602, AppServerErrorName::InvalidParams)
        }
        TeamError::Storage(_) => (-32104, AppServerErrorName::TeamOperationFailed),
    };
    RpcError::new(code, name)
}
