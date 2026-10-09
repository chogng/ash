//! Durable GitHub references follow Thread ownership, deletion and profile history transfer.

use super::thread::SqliteThreadStore;
use ash_protocol::ThreadId;
use ash_thread_store::ThreadStoreError;
use github::Repository;
use rusqlite::params;

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

impl SqliteThreadStore {
    pub fn list_pull_requests(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<(Repository, u64)>, ThreadStoreError> {
        self.list_github_references(thread_id, ReferenceKind::PullRequest)
    }

    pub fn list_issues(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<(Repository, u64)>, ThreadStoreError> {
        self.list_github_references(thread_id, ReferenceKind::Issue)
    }

    fn list_github_references(
        &self,
        thread_id: &ThreadId,
        kind: ReferenceKind,
    ) -> Result<Vec<(Repository, u64)>, ThreadStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            &format!("SELECT host, owner, repository, number FROM {} WHERE thread_id = ?1 ORDER BY rowid", kind.table())
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
                ))
            })
            .map_err(storage)?
            .map(|row| {
                let (repository, number) = row.map_err(storage)?;
                Ok((repository, u64::try_from(number).map_err(storage)?))
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
        self.attach_github_reference(thread_id, repository, number, ReferenceKind::PullRequest)
    }

    pub fn attach_issue(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
    ) -> Result<bool, ThreadStoreError> {
        self.attach_github_reference(thread_id, repository, number, ReferenceKind::Issue)
    }

    fn attach_github_reference(
        &self,
        thread_id: &ThreadId,
        repository: &Repository,
        number: u64,
        kind: ReferenceKind,
    ) -> Result<bool, ThreadStoreError> {
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        let changed = self.connection()?.execute(
            &format!("INSERT INTO {}(thread_id, host, owner, repository, number) VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(thread_id, host, owner, repository, number) DO NOTHING", kind.table()),
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
