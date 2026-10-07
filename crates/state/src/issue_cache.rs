use crate::SqliteDurability;
use crate::open_sqlite_database;
use github::IssuePage;
use github::Repository;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use std::path::Path;
use std::sync::Mutex;

const RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
const MAX_PAGES: usize = 256;
const MAX_PAGE_BYTES: usize = 1024 * 1024;

/// Rebuildable issue summaries; clearing these rows never deletes issue-task context.
pub struct SqliteIssueCache {
    connection: Mutex<Connection>,
}

pub struct IssueCacheKey<'a> {
    pub authorization: &'a github::GitHubAuthorization,
    pub repository: &'a Repository,
    pub state: &'a str,
    pub query: &'a str,
    pub page: u32,
}

pub struct CachedIssuePage {
    pub page: IssuePage,
    pub fetched_at: u64,
}

impl SqliteIssueCache {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = open_sqlite_database(path, SqliteDurability::Durable)
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS issue_pages (
            repository TEXT NOT NULL, state TEXT NOT NULL, query TEXT NOT NULL,
            page INTEGER NOT NULL, fetched_at INTEGER NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY(repository, state, query, page)
        ); CREATE INDEX IF NOT EXISTS issue_pages_age ON issue_pages(fetched_at);",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn read(
        &self,
        key: &IssueCacheKey<'_>,
        now: u64,
    ) -> Result<Option<CachedIssuePage>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Issue cache lock poisoned")?;
        prune(&connection, now)?;
        let stored: Option<(i64, String)> = connection.query_row(
            "SELECT fetched_at, value FROM issue_pages WHERE repository=?1 AND state=?2 AND query=?3 AND page=?4",
            (identity(key), key.state, key.query, key.page),
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| error.to_string())?;
        stored
            .map(|(fetched_at, value)| {
                let page = serde_json::from_str(&value)
                    .map_err(|error| format!("Invalid issue cache: {error}"))?;
                Ok(CachedIssuePage {
                    page,
                    fetched_at: u64::try_from(fetched_at)
                        .map_err(|_| "Invalid cached issue timestamp")?,
                })
            })
            .transpose()
    }

    /// Replaces a page atomically; a refreshed first page invalidates its previous continuation.
    pub fn write(&self, key: &IssueCacheKey<'_>, page: &IssuePage, now: u64) -> Result<(), String> {
        let mut page = page.clone();
        for issue in &mut page.issues {
            issue.body = None;
        }
        let value = serde_json::to_string(&page).map_err(|error| error.to_string())?;
        if value.len() > MAX_PAGE_BYTES {
            return Err("Issue summary page exceeds the 1 MiB cache limit".into());
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Issue cache lock poisoned")?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if key.page == 1 {
            transaction
                .execute(
                    "DELETE FROM issue_pages WHERE repository=?1 AND state=?2 AND query=?3",
                    (identity(key), key.state, key.query),
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.execute("INSERT INTO issue_pages(repository,state,query,page,fetched_at,value) VALUES(?1,?2,?3,?4,?5,?6)
            ON CONFLICT(repository,state,query,page) DO UPDATE SET fetched_at=excluded.fetched_at,value=excluded.value",
            (identity(key), key.state, key.query, key.page, timestamp(now)?, value)).map_err(|error| error.to_string())?;
        prune(&transaction, now)?;
        transaction.execute("DELETE FROM issue_pages WHERE rowid IN (SELECT rowid FROM issue_pages ORDER BY fetched_at DESC, rowid DESC LIMIT -1 OFFSET ?1)", [MAX_PAGES as u32]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn clear(&self, key: &IssueCacheKey<'_>) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Issue cache lock poisoned")?;
        connection
            .execute(
                "DELETE FROM issue_pages WHERE repository=?1",
                [identity(key)],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn identity(key: &IssueCacheKey<'_>) -> String {
    let repository = key.repository;
    format!(
        "{}:{}@{}/{}/{}",
        key.authorization.account_id,
        key.authorization.grant_id,
        repository.host.to_lowercase(),
        repository.owner.to_lowercase(),
        repository.name.to_lowercase()
    )
}

fn prune(connection: &Connection, now: u64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM issue_pages WHERE fetched_at <= ?1 OR fetched_at > ?2",
            (
                timestamp(now.saturating_sub(RETENTION_SECONDS))?,
                timestamp(now)?,
            ),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
#[path = "issue_cache_tests.rs"]
mod tests;

fn timestamp(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "Issue cache timestamp is out of range".into())
}
