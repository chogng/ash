//! Durable Team membership, task membership snapshots, and Team discussion.

use ash_protocol::{
    AgentId, AgentMessageId, AgentRoleSelection, CommandId, SessionId, TeamId, TeamRunId, ThreadId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TeamStatus {
    Active,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub agent_id: AgentId,
    pub name: String,
    pub responsibility: String,
    pub role: AgentRoleSelection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub team_id: TeamId,
    pub revision: u64,
    pub status: TeamStatus,
    pub name: String,
    pub description: String,
    pub coordinator_id: AgentId,
    pub members: BTreeMap<AgentId, TeamMember>,
}

impl Team {
    pub fn validate(&self) -> Result<(), TeamError> {
        if self.revision == 0 || self.name.trim().is_empty() || self.members.is_empty() {
            return Err(TeamError::InvalidInput(
                "Team needs a name, revision, and members".into(),
            ));
        }
        if !self.members.contains_key(&self.coordinator_id) {
            return Err(TeamError::InvalidInput(
                "Team coordinator must be a member".into(),
            ));
        }
        for (agent_id, member) in &self.members {
            if agent_id != &member.agent_id
                || member.name.trim().is_empty()
                || member.responsibility.trim().is_empty()
            {
                return Err(TeamError::InvalidInput(
                    "Team member needs a matching identity, name, and responsibility".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TeamCommand {
    Create {
        name: String,
        description: String,
        coordinator_id: AgentId,
        members: Vec<TeamMember>,
    },
    UpdateDetails {
        name: String,
        description: String,
    },
    AddMember {
        member: TeamMember,
    },
    UpdateMember {
        member: TeamMember,
    },
    RemoveMember {
        agent_id: AgentId,
    },
    SetCoordinator {
        agent_id: AgentId,
    },
    Archive,
    Restore,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamCommandRequest {
    pub command_id: CommandId,
    pub team_id: TeamId,
    pub expected_revision: u64,
    pub command: TeamCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRun {
    pub run_id: TeamRunId,
    pub team_id: TeamId,
    pub team_revision: u64,
    pub members: BTreeMap<AgentId, TeamMember>,
    pub coordinator_id: AgentId,
    pub session_id: SessionId,
    pub coordinator_thread_id: ThreadId,
    pub objective: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunRequest {
    pub command_id: CommandId,
    pub run_id: TeamRunId,
    pub team_id: TeamId,
    pub expected_team_revision: u64,
    pub session_id: SessionId,
    pub coordinator_thread_id: ThreadId,
    pub objective: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessage {
    pub message_id: AgentMessageId,
    pub team_id: TeamId,
    pub run_id: Option<TeamRunId>,
    pub sender_id: AgentId,
    pub receiver_id: Option<AgentId>,
    pub text: String,
    pub created_at_unix_ms: u64,
}

pub trait TeamStore: Send + Sync {
    fn list(&self) -> Result<Vec<Team>, TeamError>;
    fn read(&self, id: &TeamId) -> Result<Team, TeamError>;
    fn read_command(&self, id: &CommandId)
    -> Result<Option<(TeamCommandRequest, Team)>, TeamError>;
    fn apply(&self, request: &TeamCommandRequest, result: &Team)
    -> Result<(Team, bool), TeamError>;
    fn read_run_command(
        &self,
        id: &CommandId,
    ) -> Result<Option<(TeamRunRequest, TeamRun)>, TeamError>;
    fn start_run(
        &self,
        request: &TeamRunRequest,
        run: &TeamRun,
    ) -> Result<(TeamRun, bool), TeamError>;
    fn read_run(&self, id: &TeamRunId) -> Result<TeamRun, TeamError>;
    fn list_runs(&self, id: &TeamId) -> Result<Vec<TeamRun>, TeamError>;
    fn team_for_thread(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Option<TeamId>, TeamError>;
    fn member_for_spawn(
        &self,
        run_id: &TeamRunId,
        session_id: &SessionId,
        parent_thread_id: &ThreadId,
        agent_id: &AgentId,
    ) -> Result<TeamMember, TeamError>;
    fn bind_thread(
        &self,
        run_id: &TeamRunId,
        thread_id: &ThreadId,
        agent_id: &AgentId,
    ) -> Result<(), TeamError>;
    fn post_message(&self, message: &TeamMessage) -> Result<TeamMessage, TeamError>;
    fn list_messages(
        &self,
        team_id: &TeamId,
        reader_id: &AgentId,
    ) -> Result<Vec<TeamMessage>, TeamError>;
}

pub struct TeamCoordinator {
    store: Arc<dyn TeamStore>,
}

impl TeamCoordinator {
    pub fn new(store: Arc<dyn TeamStore>) -> Self {
        Self { store }
    }
    pub fn list(&self) -> Result<Vec<Team>, TeamError> {
        self.store.list()
    }
    pub fn read(&self, id: &TeamId) -> Result<Team, TeamError> {
        self.store.read(id)
    }
    pub fn read_run(&self, id: &TeamRunId) -> Result<TeamRun, TeamError> {
        self.store.read_run(id)
    }
    pub fn list_runs(&self, id: &TeamId) -> Result<Vec<TeamRun>, TeamError> {
        self.store.list_runs(id)
    }
    pub fn team_for_thread(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Option<TeamId>, TeamError> {
        self.store.team_for_thread(session_id, thread_id)
    }
    pub fn read_run_command(
        &self,
        id: &CommandId,
    ) -> Result<Option<(TeamRunRequest, TeamRun)>, TeamError> {
        self.store.read_run_command(id)
    }
    pub fn member_for_spawn(
        &self,
        run_id: &TeamRunId,
        session_id: &SessionId,
        parent_thread_id: &ThreadId,
        agent_id: &AgentId,
    ) -> Result<TeamMember, TeamError> {
        self.store
            .member_for_spawn(run_id, session_id, parent_thread_id, agent_id)
    }
    pub fn bind_thread(
        &self,
        run_id: &TeamRunId,
        thread_id: &ThreadId,
        agent_id: &AgentId,
    ) -> Result<(), TeamError> {
        self.store.bind_thread(run_id, thread_id, agent_id)
    }
    pub fn post_message(&self, message: &TeamMessage) -> Result<TeamMessage, TeamError> {
        self.store.post_message(message)
    }
    pub fn list_messages(
        &self,
        team_id: &TeamId,
        reader_id: &AgentId,
    ) -> Result<Vec<TeamMessage>, TeamError> {
        self.store.list_messages(team_id, reader_id)
    }

    pub fn apply(&self, request: &TeamCommandRequest) -> Result<(Team, bool), TeamError> {
        if let Some((existing, result)) = self.store.read_command(&request.command_id)? {
            return if existing == *request {
                Ok((result, true))
            } else {
                Err(TeamError::CommandConflict)
            };
        }
        // The store checks the command receipt again inside its write transaction.
        let current = match self.store.read(&request.team_id) {
            Ok(team) => Some(team),
            Err(TeamError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };
        let mut team = match (&request.command, current) {
            (
                TeamCommand::Create {
                    name,
                    description,
                    coordinator_id,
                    members,
                },
                None,
            ) => Team {
                team_id: request.team_id.clone(),
                revision: 1,
                status: TeamStatus::Active,
                name: name.clone(),
                description: description.clone(),
                coordinator_id: coordinator_id.clone(),
                members: {
                    let collected: BTreeMap<_, _> = members
                        .iter()
                        .map(|member| (member.agent_id.clone(), member.clone()))
                        .collect();
                    if collected.len() != members.len() {
                        return Err(TeamError::InvalidInput(
                            "Team members must have distinct Agent IDs".into(),
                        ));
                    }
                    collected
                },
            },
            (TeamCommand::Create { .. }, Some(_)) => {
                return Err(TeamError::AlreadyExists(request.team_id.to_string()));
            }
            (_, None) => return Err(TeamError::NotFound(request.team_id.to_string())),
            (_, Some(team)) => team,
        };
        if request.expected_revision
            != team
                .revision
                .saturating_sub(matches!(request.command, TeamCommand::Create { .. }) as u64)
        {
            return Err(TeamError::RevisionConflict);
        }
        if !matches!(request.command, TeamCommand::Create { .. }) {
            if team.status == TeamStatus::Archived
                && !matches!(request.command, TeamCommand::Restore)
            {
                return Err(TeamError::InvalidInput(
                    "Archived Team must be restored before editing".into(),
                ));
            }
            match &request.command {
                TeamCommand::UpdateDetails { name, description } => {
                    team.name = name.clone();
                    team.description = description.clone();
                }
                TeamCommand::AddMember { member } => {
                    if team.members.contains_key(&member.agent_id) {
                        return Err(TeamError::AlreadyExists(member.agent_id.to_string()));
                    }
                    team.members.insert(member.agent_id.clone(), member.clone());
                }
                TeamCommand::UpdateMember { member } => {
                    if !team.members.contains_key(&member.agent_id) {
                        return Err(TeamError::NotFound(member.agent_id.to_string()));
                    }
                    team.members.insert(member.agent_id.clone(), member.clone());
                }
                TeamCommand::RemoveMember { agent_id } => {
                    team.members
                        .remove(agent_id)
                        .ok_or_else(|| TeamError::NotFound(agent_id.to_string()))?;
                }
                TeamCommand::SetCoordinator { agent_id } => team.coordinator_id = agent_id.clone(),
                TeamCommand::Archive => team.status = TeamStatus::Archived,
                TeamCommand::Restore => team.status = TeamStatus::Active,
                TeamCommand::Create { .. } => unreachable!(),
            }
            team.revision += 1;
        }
        team.validate()?;
        self.store.apply(request, &team)
    }

    pub fn start_run(&self, request: &TeamRunRequest) -> Result<(TeamRun, bool), TeamError> {
        if let Some((existing, result)) = self.store.read_run_command(&request.command_id)? {
            return if existing == *request {
                Ok((result, true))
            } else {
                Err(TeamError::CommandConflict)
            };
        }
        if request.objective.trim().is_empty() {
            return Err(TeamError::InvalidInput(
                "Team task objective must not be empty".into(),
            ));
        }
        let team = self.store.read(&request.team_id)?;
        if team.status != TeamStatus::Active {
            return Err(TeamError::InvalidInput(
                "Archived Team cannot start tasks".into(),
            ));
        }
        if team.revision != request.expected_team_revision {
            return Err(TeamError::RevisionConflict);
        }
        let run = TeamRun {
            run_id: request.run_id.clone(),
            team_id: team.team_id,
            team_revision: team.revision,
            members: team.members,
            coordinator_id: team.coordinator_id,
            session_id: request.session_id.clone(),
            coordinator_thread_id: request.coordinator_thread_id.clone(),
            objective: request.objective.clone(),
        };
        self.store.start_run(request, &run)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TeamError {
    #[error("Team item not found: {0}")]
    NotFound(String),
    #[error("Team item already exists: {0}")]
    AlreadyExists(String),
    #[error("Team command ID conflicts with an earlier request")]
    CommandConflict,
    #[error("Team revision conflict")]
    RevisionConflict,
    #[error("Team member is not authorized for this task")]
    MemberUnauthorized,
    #[error("Invalid Team input: {0}")]
    InvalidInput(String),
    #[error("Team storage failed: {0}")]
    Storage(String),
}
