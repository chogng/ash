use crate::{SqliteDurability, open_sqlite_database};
use ash_protocol::{AgentId, CommandId, SessionId, TeamId, TeamRunId, ThreadId};
use ash_teams::{
    Team, TeamCommandRequest, TeamError, TeamMember, TeamMessage, TeamRun, TeamRunRequest,
    TeamStatus, TeamStore,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const COMPONENT: &str = "teams";
const SCHEMA_VERSION: u32 = 1;

pub struct SqliteTeamStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SqliteTeamStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, TeamError> {
        let path = path.into();
        let mut connection =
            open_sqlite_database(&path, SqliteDurability::Durable).map_err(TeamError::Storage)?;
        initialize(&mut connection)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, TeamError> {
        self.connection
            .lock()
            .map_err(|_| TeamError::Storage("Team SQLite lock poisoned".into()))
    }
}

impl TeamStore for SqliteTeamStore {
    fn list(&self) -> Result<Vec<Team>, TeamError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT record_json FROM teams ORDER BY team_id")
            .map_err(storage)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|row| decode(&row.map_err(storage)?)).collect()
    }

    fn read(&self, id: &TeamId) -> Result<Team, TeamError> {
        let connection = self.connection()?;
        read_team(&connection, id)
    }

    fn read_command(
        &self,
        id: &CommandId,
    ) -> Result<Option<(TeamCommandRequest, Team)>, TeamError> {
        let connection = self.connection()?;
        read_receipt(&connection, "team_commands", id)
    }

    fn apply(
        &self,
        request: &TeamCommandRequest,
        result: &Team,
    ) -> Result<(Team, bool), TeamError> {
        result.validate()?;
        if result.team_id != request.team_id || result.revision != request.expected_revision + 1 {
            return Err(TeamError::InvalidInput(
                "Team command result does not match its request".into(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some((prior, team)) = read_receipt::<TeamCommandRequest, Team>(
            &transaction,
            "team_commands",
            &request.command_id,
        )? {
            return if prior == *request {
                Ok((team, true))
            } else {
                Err(TeamError::CommandConflict)
            };
        }
        let actual = transaction
            .query_row(
                "SELECT revision FROM teams WHERE team_id = ?1",
                [request.team_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?
            .unwrap_or(0);
        let actual =
            u64::try_from(actual).map_err(|error| TeamError::Storage(error.to_string()))?;
        if actual != request.expected_revision {
            return Err(TeamError::RevisionConflict);
        }
        // Team membership and Agent identities become durable in one transaction.
        let created_at =
            i64::try_from(now_ms()?).map_err(|error| TeamError::Storage(error.to_string()))?;
        for member in result.members.values() {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO agents (agent_id, created_at_unix_ms) VALUES (?1, ?2)",
                    params![member.agent_id.as_str(), created_at],
                )
                .map_err(storage)?;
        }
        if actual == 0 {
            transaction
                .execute(
                    "INSERT INTO teams (team_id, revision, record_json) VALUES (?1, ?2, ?3)",
                    params![
                        request.team_id.as_str(),
                        i64::try_from(result.revision)
                            .map_err(|error| TeamError::Storage(error.to_string()))?,
                        encode(result)?
                    ],
                )
                .map_err(storage)?;
        } else {
            transaction.execute("UPDATE teams SET revision = ?1, record_json = ?2 WHERE team_id = ?3 AND revision = ?4", params![i64::try_from(result.revision).map_err(|error| TeamError::Storage(error.to_string()))?, encode(result)?, request.team_id.as_str(), i64::try_from(actual).map_err(|error| TeamError::Storage(error.to_string()))?]).map_err(storage)?;
        }
        transaction.execute("INSERT INTO team_commands (command_id, request_json, result_json) VALUES (?1, ?2, ?3)", params![request.command_id.as_str(), encode(request)?, encode(result)?]).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok((result.clone(), false))
    }

    fn read_run_command(
        &self,
        id: &CommandId,
    ) -> Result<Option<(TeamRunRequest, TeamRun)>, TeamError> {
        let connection = self.connection()?;
        read_receipt(&connection, "team_run_commands", id)
    }

    fn start_run(
        &self,
        request: &TeamRunRequest,
        run: &TeamRun,
    ) -> Result<(TeamRun, bool), TeamError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some((prior, result)) = read_receipt::<TeamRunRequest, TeamRun>(
            &transaction,
            "team_run_commands",
            &request.command_id,
        )? {
            return if prior == *request {
                Ok((result, true))
            } else {
                Err(TeamError::CommandConflict)
            };
        }
        let team = read_team(&transaction, &request.team_id)?;
        if team.revision != request.expected_team_revision || team.status != TeamStatus::Active {
            return Err(TeamError::RevisionConflict);
        }
        if run.team_id != request.team_id
            || run.team_revision != team.revision
            || run.members != team.members
            || run.coordinator_id != team.coordinator_id
            || run.run_id != request.run_id
            || run.session_id != request.session_id
            || run.coordinator_thread_id != request.coordinator_thread_id
            || run.objective != request.objective
        {
            return Err(TeamError::InvalidInput(
                "Team task snapshot does not match its request".into(),
            ));
        }
        let run_exists = transaction
            .query_row(
                "SELECT 1 FROM team_runs WHERE run_id = ?1",
                [run.run_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        let thread_claimed = transaction
            .query_row(
                "SELECT 1 FROM team_run_threads WHERE thread_id = ?1",
                [run.coordinator_thread_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        if run_exists || thread_claimed {
            return Err(TeamError::CommandConflict);
        }
        require_thread_binding(
            &transaction,
            &run.coordinator_thread_id,
            &run.session_id,
            &run.coordinator_id,
        )?;
        transaction.execute("INSERT INTO team_runs (run_id, team_id, session_id, record_json) VALUES (?1, ?2, ?3, ?4)", params![run.run_id.as_str(), run.team_id.as_str(), run.session_id.as_str(), encode(run)?]).map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO team_run_threads (thread_id, run_id, agent_id) VALUES (?1, ?2, ?3)",
                params![
                    run.coordinator_thread_id.as_str(),
                    run.run_id.as_str(),
                    run.coordinator_id.as_str()
                ],
            )
            .map_err(storage)?;
        transaction.execute("INSERT INTO team_run_commands (command_id, request_json, result_json) VALUES (?1, ?2, ?3)", params![request.command_id.as_str(), encode(request)?, encode(run)?]).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok((run.clone(), false))
    }

    fn read_run(&self, id: &TeamRunId) -> Result<TeamRun, TeamError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT record_json FROM team_runs WHERE run_id = ?1",
                [id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage)?
            .map(|record| decode(&record))
            .transpose()?
            .ok_or_else(|| TeamError::NotFound(id.to_string()))
    }

    fn list_runs(&self, id: &TeamId) -> Result<Vec<TeamRun>, TeamError> {
        let connection = self.connection()?;
        read_team(&connection, id)?;
        let mut statement = connection
            .prepare("SELECT record_json FROM team_runs WHERE team_id = ?1 ORDER BY rowid DESC")
            .map_err(storage)?;
        let rows = statement
            .query_map([id.as_str()], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|row| decode(&row.map_err(storage)?)).collect()
    }

    fn team_for_thread(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Option<TeamId>, TeamError> {
        let connection = self.connection()?;
        let id: Option<String> = connection.query_row(
            "SELECT team_runs.team_id FROM team_run_threads JOIN team_runs ON team_runs.run_id = team_run_threads.run_id WHERE team_run_threads.thread_id = ?1 AND team_runs.session_id = ?2",
            params![thread_id.as_str(), session_id.as_str()],
            |row| row.get(0),
        ).optional().map_err(storage)?;
        id.map(|id| TeamId::new(id).map_err(|error| TeamError::Storage(error.to_string())))
            .transpose()
    }

    fn member_for_spawn(
        &self,
        run_id: &TeamRunId,
        session_id: &SessionId,
        parent_thread_id: &ThreadId,
        agent_id: &AgentId,
    ) -> Result<TeamMember, TeamError> {
        let run = self.read_run(run_id)?;
        if &run.session_id != session_id {
            return Err(TeamError::MemberUnauthorized);
        }
        let member = run
            .members
            .get(agent_id)
            .ok_or(TeamError::MemberUnauthorized)?;
        let connection = self.connection()?;
        let participant = connection
            .query_row(
                "SELECT 1 FROM team_run_threads WHERE run_id = ?1 AND thread_id = ?2",
                params![run_id.as_str(), parent_thread_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        if !participant {
            return Err(TeamError::MemberUnauthorized);
        }
        Ok(member.clone())
    }

    fn bind_thread(
        &self,
        run_id: &TeamRunId,
        thread_id: &ThreadId,
        agent_id: &AgentId,
    ) -> Result<(), TeamError> {
        let run = self.read_run(run_id)?;
        if !run.members.contains_key(agent_id) {
            return Err(TeamError::MemberUnauthorized);
        }
        let connection = self.connection()?;
        require_thread_binding(&connection, thread_id, &run.session_id, agent_id)?;
        connection.execute("INSERT INTO team_run_threads (thread_id, run_id, agent_id) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id) DO NOTHING", params![thread_id.as_str(), run_id.as_str(), agent_id.as_str()]).map_err(storage)?;
        let actual: (String, String) = connection
            .query_row(
                "SELECT run_id, agent_id FROM team_run_threads WHERE thread_id = ?1",
                [thread_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(storage)?;
        if actual != (run_id.to_string(), agent_id.to_string()) {
            return Err(TeamError::MemberUnauthorized);
        }
        Ok(())
    }

    fn post_message(&self, message: &TeamMessage) -> Result<TeamMessage, TeamError> {
        if message.text.trim().is_empty() {
            return Err(TeamError::InvalidInput(
                "Team message must not be empty".into(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let team = read_team(&transaction, &message.team_id)?;
        if !team.members.contains_key(&message.sender_id)
            || message
                .receiver_id
                .as_ref()
                .is_some_and(|id| !team.members.contains_key(id))
        {
            return Err(TeamError::MemberUnauthorized);
        }
        if let Some(run_id) = &message.run_id {
            let run = transaction
                .query_row(
                    "SELECT record_json FROM team_runs WHERE run_id = ?1",
                    [run_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(storage)?
                .ok_or_else(|| TeamError::NotFound(run_id.to_string()))?;
            let run: TeamRun = decode(&run)?;
            if run.team_id != message.team_id || !run.members.contains_key(&message.sender_id) {
                return Err(TeamError::MemberUnauthorized);
            }
        }
        let record = encode(message)?;
        transaction.execute("INSERT INTO team_messages (message_id, team_id, record_json) VALUES (?1, ?2, ?3) ON CONFLICT(message_id) DO NOTHING", params![message.message_id.as_str(), message.team_id.as_str(), record]).map_err(storage)?;
        let existing: String = transaction
            .query_row(
                "SELECT record_json FROM team_messages WHERE message_id = ?1",
                [message.message_id.as_str()],
                |row| row.get(0),
            )
            .map_err(storage)?;
        let existing: TeamMessage = decode(&existing)?;
        if existing.message_id != message.message_id
            || existing.team_id != message.team_id
            || existing.run_id != message.run_id
            || existing.sender_id != message.sender_id
            || existing.receiver_id != message.receiver_id
            || existing.text != message.text
        {
            return Err(TeamError::CommandConflict);
        }
        transaction.commit().map_err(storage)?;
        Ok(existing)
    }

    fn list_messages(
        &self,
        team_id: &TeamId,
        reader_id: &AgentId,
    ) -> Result<Vec<TeamMessage>, TeamError> {
        let connection = self.connection()?;
        let team = read_team(&connection, team_id)?;
        if !team.members.contains_key(reader_id) {
            return Err(TeamError::MemberUnauthorized);
        }
        let mut statement = connection
            .prepare("SELECT record_json FROM team_messages WHERE team_id = ?1 ORDER BY rowid")
            .map_err(storage)?;
        let rows = statement
            .query_map([team_id.as_str()], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|row| decode(&row.map_err(storage)?))
            .filter(|message: &Result<TeamMessage, TeamError>| match message {
                Err(_) => true,
                Ok(message) => {
                    message
                        .receiver_id
                        .as_ref()
                        .is_none_or(|receiver| receiver == reader_id)
                        || &message.sender_id == reader_id
                }
            })
            .collect()
    }
}

fn initialize(connection: &mut Connection) -> Result<(), TeamError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS ash_schema_migrations (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, created_at_unix_ms INTEGER NOT NULL);").map_err(storage)?;
    let version = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = ?1",
            [COMPONENT],
            |row| row.get::<_, u32>(0),
        )
        .optional()
        .map_err(storage)?;
    match version {
        None => {
            transaction.execute_batch("CREATE TABLE teams (team_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL);
                CREATE TABLE team_commands (command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL);
                CREATE TABLE team_runs (run_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(team_id), session_id TEXT NOT NULL, record_json TEXT NOT NULL);
                CREATE INDEX team_runs_team ON team_runs(team_id, run_id);
                CREATE TABLE team_run_commands (command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL);
                CREATE TABLE team_run_threads (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES team_runs(run_id), agent_id TEXT NOT NULL REFERENCES agents(agent_id));
                CREATE INDEX team_run_threads_run ON team_run_threads(run_id, thread_id);
                CREATE TABLE team_messages (message_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(team_id), record_json TEXT NOT NULL);
                CREATE INDEX team_messages_team ON team_messages(team_id, message_id);").map_err(storage)?;
            transaction
                .execute(
                    "INSERT INTO ash_schema_migrations (component, version) VALUES (?1, ?2)",
                    params![COMPONENT, SCHEMA_VERSION],
                )
                .map_err(storage)?;
        }
        Some(SCHEMA_VERSION) => {}
        Some(version) => {
            return Err(TeamError::Storage(format!(
                "unsupported Team schema version {version}"
            )));
        }
    }
    transaction.commit().map_err(storage)
}

fn read_team(connection: &Connection, id: &TeamId) -> Result<Team, TeamError> {
    let record = connection
        .query_row(
            "SELECT record_json FROM teams WHERE team_id = ?1",
            [id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage)?
        .ok_or_else(|| TeamError::NotFound(id.to_string()))?;
    let team: Team = decode(&record)?;
    team.validate()?;
    Ok(team)
}

fn read_receipt<Request: DeserializeOwned, ResultValue: DeserializeOwned>(
    connection: &Connection,
    table: &str,
    id: &CommandId,
) -> Result<Option<(Request, ResultValue)>, TeamError> {
    let sql = match table {
        "team_commands" => {
            "SELECT request_json, result_json FROM team_commands WHERE command_id = ?1"
        }
        "team_run_commands" => {
            "SELECT request_json, result_json FROM team_run_commands WHERE command_id = ?1"
        }
        _ => unreachable!(),
    };
    connection
        .query_row(sql, [id.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .optional()
        .map_err(storage)?
        .map(|(request, result)| Ok((decode(&request)?, decode(&result)?)))
        .transpose()
}

fn require_thread_binding(
    connection: &Connection,
    thread_id: &ThreadId,
    session_id: &SessionId,
    agent_id: &AgentId,
) -> Result<(), TeamError> {
    let exists = connection.query_row("SELECT 1 FROM agent_threads WHERE thread_id = ?1 AND session_id = ?2 AND agent_id = ?3", params![thread_id.as_str(), session_id.as_str(), agent_id.as_str()], |row| row.get::<_, i64>(0)).optional().map_err(storage)?.is_some();
    if exists {
        Ok(())
    } else {
        Err(TeamError::MemberUnauthorized)
    }
}

fn encode<T: Serialize>(value: &T) -> Result<String, TeamError> {
    serde_json::to_string(value).map_err(|error| TeamError::Storage(error.to_string()))
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T, TeamError> {
    serde_json::from_str(value).map_err(|error| TeamError::Storage(error.to_string()))
}
fn storage(error: rusqlite::Error) -> TeamError {
    TeamError::Storage(error.to_string())
}
fn now_ms() -> Result<u64, TeamError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| TeamError::Storage(error.to_string()))?
        .as_millis() as u64)
}
