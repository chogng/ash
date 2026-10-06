//! Durable PR references follow Thread ownership, deletion and profile history transfer.

use super::thread::SqliteThreadStore;
use ash_protocol::ThreadId;
use ash_thread_store::ThreadStoreError;
use github::Repository;
use rusqlite::params;

impl SqliteThreadStore {
    pub fn list_pull_requests(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<(Repository, u64)>, ThreadStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT host, owner, repository, number FROM thread_pull_requests WHERE thread_id = ?1 ORDER BY rowid"
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
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        let changed = self.connection()?.execute(
            "INSERT INTO thread_pull_requests(thread_id, host, owner, repository, number) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(thread_id, host, owner, repository, number) DO NOTHING",
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
        let repository = normalized(repository, number)?;
        let number = super::connection::to_sql_integer(number).map_err(storage)?;
        let changed = self.connection()?.execute(
            "DELETE FROM thread_pull_requests WHERE thread_id = ?1 AND host = ?2 AND owner = ?3 AND repository = ?4 AND number = ?5",
            params![thread_id.as_str(), repository.host, repository.owner, repository.name, number],
        ).map_err(storage)?;
        Ok(changed != 0)
    }
}

fn normalized(repository: &Repository, number: u64) -> Result<Repository, ThreadStoreError> {
    if number == 0 || number > 9_007_199_254_740_991 {
        return Err(ThreadStoreError::InvalidBatch(
            "invalid pull request number".into(),
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
