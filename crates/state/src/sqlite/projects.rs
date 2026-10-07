use super::connection::from_sql_integer;
use super::connection::to_sql_integer;
use crate::SqliteDurability;
use crate::open_sqlite_database;
use ash_projects::Project;
use ash_projects::ProjectCommandRequest;
use ash_projects::ProjectCommit;
use ash_projects::ProjectStore;
use ash_projects::ProjectStoreError;
use ash_projects::ProjectStoreOutcome;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

const PROJECTS_SCHEMA_VERSION: u32 = 1;
const PROJECTS_COMPONENT: &str = "projects";

/// SQLite implementation of complete Project records and retry-safe command receipts.
pub struct SqliteProjectStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SqliteProjectStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ProjectStoreError> {
        let path = path.into();
        let mut connection = open_sqlite_database(&path, SqliteDurability::Durable)
            .map_err(ProjectStoreError::Storage)?;
        initialize(&mut connection)?;
        let store = Self {
            path,
            connection: Mutex::new(connection),
        };
        for project in store.list()? {
            validate_project(&project)?;
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, ProjectStoreError> {
        self.connection
            .lock()
            .map_err(|_| ProjectStoreError::Storage("Project SQLite lock poisoned".into()))
    }
}

impl ProjectStore for SqliteProjectStore {
    fn list(&self) -> Result<Vec<Project>, ProjectStoreError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT project_id, revision, record_json FROM projects
                 ORDER BY project_id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_error)?;
        let mut projects = Vec::new();
        for row in rows {
            let (project_id, revision, record) = row.map_err(storage_error)?;
            let project_id = ProjectId::new(project_id)
                .map_err(|error| ProjectStoreError::Storage(error.to_string()))?;
            projects.push(deserialize_project(&project_id, revision, &record)?);
        }
        Ok(projects)
    }

    fn load(&self, project_id: &ProjectId) -> Result<Project, ProjectStoreError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT revision, record_json FROM projects WHERE project_id = ?1",
                [project_id.as_str()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| ProjectStoreError::NotFound(project_id.to_string()))?;
        deserialize_project(project_id, row.0, &row.1)
    }

    fn load_command(
        &self,
        command_id: &CommandId,
    ) -> Result<Option<ProjectCommit>, ProjectStoreError> {
        let connection = self.connection()?;
        load_command(&connection, command_id)
    }

    fn commit(&self, commit: &ProjectCommit) -> Result<ProjectStoreOutcome, ProjectStoreError> {
        validate_commit(commit)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if let Some(existing) = load_command(&transaction, &commit.request.command_id)? {
            if existing.request != commit.request {
                return Err(ProjectStoreError::CommandConflict);
            }
            transaction.commit().map_err(storage_error)?;
            return Ok(ProjectStoreOutcome::Replayed(existing.result));
        }
        let actual = transaction
            .query_row(
                "SELECT revision FROM projects WHERE project_id = ?1",
                [commit.request.project_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?
            .map(from_sql_integer)
            .transpose()
            .map_err(ProjectStoreError::Storage)?
            .unwrap_or(0);
        if actual != commit.request.expected_revision {
            return Err(ProjectStoreError::RevisionConflict {
                expected: commit.request.expected_revision,
                actual,
            });
        }
        let record = serialize(&commit.result)?;
        if actual == 0 {
            transaction
                .execute(
                    "INSERT INTO projects (project_id, revision, record_json)
                     VALUES (?1, ?2, ?3)",
                    params![
                        commit.result.project_id.as_str(),
                        to_sql_integer(commit.result.revision)
                            .map_err(ProjectStoreError::Storage)?,
                        record,
                    ],
                )
                .map_err(storage_error)?;
        } else {
            let updated = transaction
                .execute(
                    "UPDATE projects SET revision = ?1, record_json = ?2
                     WHERE project_id = ?3 AND revision = ?4",
                    params![
                        to_sql_integer(commit.result.revision)
                            .map_err(ProjectStoreError::Storage)?,
                        record,
                        commit.result.project_id.as_str(),
                        to_sql_integer(actual).map_err(ProjectStoreError::Storage)?,
                    ],
                )
                .map_err(storage_error)?;
            if updated != 1 {
                return Err(ProjectStoreError::RevisionConflict {
                    expected: commit.request.expected_revision,
                    actual,
                });
            }
        }
        transaction
            .execute(
                "INSERT INTO project_commands
                 (command_id, project_id, expected_revision, request_json,
                  result_revision, result_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    commit.request.command_id.as_str(),
                    commit.request.project_id.as_str(),
                    to_sql_integer(commit.request.expected_revision)
                        .map_err(ProjectStoreError::Storage)?,
                    serialize(&commit.request)?,
                    to_sql_integer(commit.result.revision).map_err(ProjectStoreError::Storage)?,
                    serialize(&commit.result)?,
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(ProjectStoreOutcome::Applied)
    }
}

fn initialize(connection: &mut Connection) -> Result<(), ProjectStoreError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                 component TEXT PRIMARY KEY,
                 version INTEGER NOT NULL
             );",
        )
        .map_err(storage_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let version = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = ?1",
            [PROJECTS_COMPONENT],
            |row| row.get::<_, u32>(0),
        )
        .optional()
        .map_err(storage_error)?;
    match version {
        None => {
            transaction
                .execute_batch(
                    "CREATE TABLE projects (
                         project_id TEXT PRIMARY KEY,
                         revision INTEGER NOT NULL,
                         record_json TEXT NOT NULL
                     );
                     CREATE TABLE project_commands (
                         command_id TEXT PRIMARY KEY,
                         project_id TEXT NOT NULL,
                         expected_revision INTEGER NOT NULL,
                         request_json TEXT NOT NULL,
                         result_revision INTEGER NOT NULL,
                         result_json TEXT NOT NULL,
                         FOREIGN KEY (project_id) REFERENCES projects(project_id)
                     );
                     CREATE INDEX project_commands_project_revision
                     ON project_commands(project_id, result_revision);",
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO ash_schema_migrations (component, version) VALUES (?1, ?2)",
                    params![PROJECTS_COMPONENT, PROJECTS_SCHEMA_VERSION],
                )
                .map_err(storage_error)?;
        }
        Some(PROJECTS_SCHEMA_VERSION) => {}
        Some(version) => {
            return Err(ProjectStoreError::Storage(format!(
                "unsupported Project SQLite schema version {version}"
            )));
        }
    }
    transaction.commit().map_err(storage_error)
}

fn load_command(
    connection: &Connection,
    command_id: &CommandId,
) -> Result<Option<ProjectCommit>, ProjectStoreError> {
    let row = connection
        .query_row(
            "SELECT project_id, expected_revision, request_json,
                    result_revision, result_json
             FROM project_commands WHERE command_id = ?1",
            [command_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?;
    row.map(
        |(project_id, expected_revision, request_json, result_revision, result_json)| {
            let request = serde_json::from_str::<ProjectCommandRequest>(&request_json)
                .map_err(|error| ProjectStoreError::Storage(error.to_string()))?;
            let result = serde_json::from_str::<Project>(&result_json)
                .map_err(|error| ProjectStoreError::Storage(error.to_string()))?;
            let expected_revision =
                from_sql_integer(expected_revision).map_err(ProjectStoreError::Storage)?;
            let result_revision =
                from_sql_integer(result_revision).map_err(ProjectStoreError::Storage)?;
            if request.command_id != *command_id
                || request.project_id.as_str() != project_id
                || request.expected_revision != expected_revision
                || result.project_id != request.project_id
                || result.revision != result_revision
            {
                return Err(ProjectStoreError::Storage(
                    "Project command row metadata disagrees with its record".into(),
                ));
            }
            validate_project(&result)?;
            Ok(ProjectCommit { request, result })
        },
    )
    .transpose()
}

fn validate_commit(commit: &ProjectCommit) -> Result<(), ProjectStoreError> {
    let next_revision = commit
        .request
        .expected_revision
        .checked_add(1)
        .ok_or_else(|| ProjectStoreError::Storage("Project revision overflow".into()))?;
    if commit.result.project_id != commit.request.project_id
        || commit.result.revision != next_revision
    {
        return Err(ProjectStoreError::Storage(
            "Project commit does not contain the requested next aggregate revision".into(),
        ));
    }
    validate_project(&commit.result)
}

fn serialize(value: &impl serde::Serialize) -> Result<String, ProjectStoreError> {
    serde_json::to_string(value).map_err(|error| ProjectStoreError::Storage(error.to_string()))
}

fn deserialize_project(
    project_id: &ProjectId,
    revision: i64,
    record: &str,
) -> Result<Project, ProjectStoreError> {
    let project = serde_json::from_str::<Project>(record)
        .map_err(|error| ProjectStoreError::Storage(error.to_string()))?;
    let revision = from_sql_integer(revision).map_err(ProjectStoreError::Storage)?;
    if &project.project_id != project_id || project.revision != revision {
        return Err(ProjectStoreError::Storage(
            "Project row metadata disagrees with its record".into(),
        ));
    }
    validate_project(&project)?;
    Ok(project)
}

fn validate_project(project: &Project) -> Result<(), ProjectStoreError> {
    project
        .validate()
        .map_err(|error| ProjectStoreError::Storage(format!("invalid Project record: {error}")))
}

fn storage_error(error: impl std::fmt::Display) -> ProjectStoreError {
    ProjectStoreError::Storage(format!("Project SQLite error: {error}"))
}
