//! Durable GitHub references follow Thread ownership, deletion and profile history transfer.

use super::thread::SqliteThreadStore;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_thread_store::ThreadStoreError;
use github::Repository;
use rusqlite::params;

#[cfg(test)]
#[path = "thread_pull_requests_tests.rs"]
mod tests;

enum ReferenceKind {
    PullRequest,
    Issue,
}

impl ReferenceKind {
    fn table(&self) -> &'static str {
        match self {
            Self::PullRequest => "thread_pull_requests",
            Self::Issue => "thread_issues",
        }
    }
}

type ArtifactOrigin = (String, String);
type GitHubReference = (
    Repository,
    u64,
    bool,
    Option<String>,
    Option<ArtifactOrigin>,
);

impl SqliteThreadStore {
    pub fn list_pull_requests(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<GitHubReference>, ThreadStoreError> {
        self.list_github_references(thread_id, ReferenceKind::PullRequest)
    }

    pub fn list_issues(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<(Repository, u64)>, ThreadStoreError> {
        Ok(self
            .list_github_references(thread_id, ReferenceKind::Issue)?
            .into_iter()
            .map(|(repository, number, _, _, _)| (repository, number))
            .collect())
    }

    /// Reads the identity that authorizes this generation of a PR artifact.
    pub fn pull_request_artifact_id(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<Option<String>, ThreadStoreError> {
        use rusqlite::OptionalExtension;
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        self.connection()?
            .query_row(
                "SELECT artifact_id FROM thread_pull_requests
             WHERE thread_id = ?1 AND host = ?2 AND owner = ?3 AND repository = ?4 AND number = ?5",
                params![
                    thread_id.as_str(),
                    repository.host,
                    repository.owner,
                    repository.name,
                    number
                ],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(storage)
    }

    fn list_github_references(
        &self,
        thread_id: &ThreadId,
        kind: ReferenceKind,
    ) -> Result<Vec<GitHubReference>, ThreadStoreError> {
        let artifact_column = match kind {
            ReferenceKind::PullRequest => {
                "is_artifact, artifact_id, artifact_source_thread, artifact_source_turn"
            }
            ReferenceKind::Issue => "0, NULL, NULL, NULL",
        };
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            &format!("SELECT host, owner, repository, number, {artifact_column} FROM {} WHERE thread_id = ?1 ORDER BY rowid", kind.table())
        ).map_err(storage)?;
        statement
            .query_map([thread_id.as_str()], |row| {
                Ok((
                    Repository {
                        host: row.get(0)?,
                        owner: row.get(1)?,
                        name: row.get(2)?,
                    },
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?
                        .zip(row.get::<_, Option<String>>(7)?),
                ))
            })
            .map_err(storage)?
            .map(|row| {
                let (repository, number, is_artifact, artifact_id, artifact_origin) =
                    row.map_err(storage)?;
                Ok((
                    repository,
                    u64::try_from(number).map_err(storage)?,
                    is_artifact,
                    artifact_id,
                    artifact_origin,
                ))
            })
            .collect()
    }

    /// Identity-based insertion is idempotent across windows and reconnects.
    pub fn attach_pull_request(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<bool, ThreadStoreError> {
        self.save_pull_request(thread_id, repository, number, false, None)
    }

    /// Recording a produced PR promotes any existing reference to the same resource.
    pub fn record_pull_request(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<bool, ThreadStoreError> {
        self.save_pull_request(thread_id, repository, number, true, None)
    }

    /// Records the first agent producer using identities from the executing turn.
    pub fn record_agent_pull_request(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
        source_thread: &ThreadId,
        source_turn: &TurnId,
    ) -> Result<bool, ThreadStoreError> {
        self.save_pull_request(
            thread_id,
            repository,
            number,
            true,
            Some((source_thread, source_turn)),
        )
    }

    fn save_pull_request(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
        is_artifact: bool,
        source: Option<(&ThreadId, &TurnId)>,
    ) -> Result<bool, ThreadStoreError> {
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        let (source_thread, source_turn) = source.unzip();
        let changed = self.connection()?.execute(
            "INSERT INTO thread_pull_requests(thread_id, host, owner, repository, number, is_artifact, artifact_id, artifact_source_thread, artifact_source_turn)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?6 = 1 THEN lower(hex(randomblob(16))) END, ?7, ?8)
             ON CONFLICT(thread_id, host, owner, repository, number) DO UPDATE
             SET is_artifact = 1, artifact_id = excluded.artifact_id,
                 artifact_source_thread = excluded.artifact_source_thread,
                 artifact_source_turn = excluded.artifact_source_turn
             WHERE excluded.is_artifact = 1 AND thread_pull_requests.is_artifact = 0",
            params![thread_id.as_str(), repository.host, repository.owner, repository.name, number, is_artifact, source_thread.map(ThreadId::as_str), source_turn.map(TurnId::as_str)],
        ).map_err(storage)?;
        Ok(changed != 0)
    }

    pub fn attach_issue(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<bool, ThreadStoreError> {
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        let changed = self.connection()?.execute(
            "INSERT INTO thread_issues(thread_id, host, owner, repository, number) VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(thread_id, host, owner, repository, number) DO NOTHING",
            params![thread_id.as_str(), repository.host, repository.owner, repository.name, number],
        ).map_err(storage)?;
        Ok(changed != 0)
    }

    pub fn detach_pull_request(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<bool, ThreadStoreError> {
        self.detach_github_reference(thread_id, repository, number, ReferenceKind::PullRequest)
    }

    pub fn detach_issue(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<bool, ThreadStoreError> {
        self.detach_github_reference(thread_id, repository, number, ReferenceKind::Issue)
    }

    fn detach_github_reference(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
        kind: ReferenceKind,
    ) -> Result<bool, ThreadStoreError> {
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        let changed = self.connection()?.execute(
            &format!("DELETE FROM {} WHERE thread_id = ?1 AND host = ?2 AND owner = ?3 AND repository = ?4 AND number = ?5", kind.table()),
            params![thread_id.as_str(), repository.host, repository.owner, repository.name, number],
        ).map_err(storage)?;
        Ok(changed != 0)
    }
}

fn normalized(repository: &Repository, number: u64) -> Result<Repository, ThreadStoreError> {
    if number == 0 || number > 9_007_199_254_740_991 {
        return Err(ThreadStoreError::InvalidBatch(
            "invalid GitHub reference number".into(),
        ));
    }
    Repository::new(
        repository.host.to_lowercase(),
        repository.owner.to_lowercase(),
        repository.name.to_lowercase(),
    )
    .map_err(storage)
}

fn storage(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(error.to_string())
}

/// Runs inside the same immediate transaction as Turn acceptance. DELETE and append
/// therefore have one durable order across independent connections and processes.
pub(super) fn validate_admission(
    transaction: &rusqlite::Transaction<'_>,
    batch: &ash_thread_store::ThreadEventBatch,
    precondition: &ash_thread_store::ThreadEventPrecondition,
) -> Result<(), ThreadStoreError> {
    match precondition {
        ash_thread_store::ThreadEventPrecondition::PullRequestArtifact {
            source_thread_id,
            artifact_id,
        } => {
            let current: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                    SELECT 1 FROM thread_pull_requests AS pr
                    JOIN thread_catalog AS source ON source.thread_id = pr.thread_id
                    WHERE pr.thread_id = ?1 AND pr.artifact_id = ?2 AND pr.is_artifact = 1
                    AND source.session_id = ?3
                )",
                    params![
                        source_thread_id.as_str(),
                        artifact_id,
                        batch.catalog.session_id.as_str()
                    ],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if !current {
                return Err(ThreadStoreError::AuthorizationRevoked);
            }
        }
    }
    Ok(())
}
