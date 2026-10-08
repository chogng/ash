use super::*;

fn repository(name: &str) -> Repository {
    Repository::new("github.com".into(), "team".into(), name.into()).unwrap()
}

fn page(number: u64) -> IssuePage {
    IssuePage {
        issues: vec![github::Issue {
            labels: Vec::new(),
            assignees: Vec::new(),
            number,
            title: format!("Issue {number}"),
            body: Some("Private body is not cached".into()),
            html_url: format!("https://github.com/team/repo/issues/{number}"),
            created_at: String::new(),
            updated_at: "now".into(),
            state: "open".into(),
            pull_request: None,
        }],
        next_page: Some(2),
        notice: String::new(),
    }
}

#[test]
fn private_issue_cache_isolates_accounts_and_grants_and_clears_only_the_selected_grant() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteIssueCache::open(&directory.path().join("state.db")).unwrap();
    let repository = repository("repo");
    let first = github::GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "first".into(),
    };
    let second = github::GitHubAuthorization {
        account_id: "43".into(),
        ..first.clone()
    };
    let renewed = github::GitHubAuthorization {
        grant_id: "renewed".into(),
        ..first.clone()
    };
    let key = IssueCacheKey {
        authorization: &first,
        repository: &repository,
        state: "open",
        query: "",
        page: 1,
    };
    let now = RETENTION_SECONDS + 1;
    store.write(&key, &page(1), now).unwrap();
    for authorization in [&second, &renewed] {
        assert!(
            store
                .read(
                    &IssueCacheKey {
                        authorization,
                        ..key
                    },
                    now
                )
                .unwrap()
                .is_none()
        );
        store
            .write(
                &IssueCacheKey {
                    authorization,
                    ..key
                },
                &page(2),
                now,
            )
            .unwrap();
    }
    store.clear(&key).unwrap();
    assert!(store.read(&key, now).unwrap().is_none());
    for authorization in [&second, &renewed] {
        assert_eq!(
            store
                .read(
                    &IssueCacheKey {
                        authorization,
                        ..key
                    },
                    now
                )
                .unwrap()
                .unwrap()
                .page
                .issues[0]
                .number,
            2
        );
    }
}

#[test]
fn issue_cache_survives_restart_and_isolates_repository_state_query_and_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let repo = repository("repo");
    let other = repository("other");
    let authorization = github::GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "grant-one".into(),
    };
    let key = IssueCacheKey {
        authorization: &authorization,
        repository: &repo,
        state: "open",
        query: "",
        page: 1,
    };
    let now = RETENTION_SECONDS + 100;
    {
        let store = SqliteIssueCache::open(&path).unwrap();
        store.write(&key, &page(3), now).unwrap();
        store
            .write(
                &IssueCacheKey {
                    state: "closed",
                    ..key
                },
                &page(9),
                now,
            )
            .unwrap();
        store
            .write(
                &IssueCacheKey {
                    query: "bug",
                    ..key
                },
                &page(5),
                now,
            )
            .unwrap();
        store
            .write(&IssueCacheKey { page: 2, ..key }, &page(7), now)
            .unwrap();
    }
    let store = SqliteIssueCache::open(&path).unwrap();
    let result = store.read(&key, now + 1).unwrap().unwrap();
    assert_eq!(result.page.issues[0].number, 3);
    assert_eq!(result.page.issues[0].body, None);
    assert_eq!(result.fetched_at, now);
    assert_eq!(
        store
            .read(
                &IssueCacheKey {
                    state: "closed",
                    ..key
                },
                now
            )
            .unwrap()
            .unwrap()
            .page
            .issues[0]
            .number,
        9
    );
    assert_eq!(
        store
            .read(
                &IssueCacheKey {
                    query: "bug",
                    ..key
                },
                now
            )
            .unwrap()
            .unwrap()
            .page
            .issues[0]
            .number,
        5
    );
    assert_eq!(
        store
            .read(&IssueCacheKey { page: 2, ..key }, now)
            .unwrap()
            .unwrap()
            .page
            .issues[0]
            .number,
        7
    );
    assert!(
        store
            .read(
                &IssueCacheKey {
                    repository: &other,
                    ..key
                },
                now
            )
            .unwrap()
            .is_none()
    );
    assert!(store.read(&key, now + RETENTION_SECONDS).unwrap().is_none());
}

#[test]
fn issue_cache_refresh_invalidates_continuation_and_clear_preserves_other_repositories_and_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = SqliteIssueCache::open(&path).unwrap();
    let repo = repository("repo");
    let other = repository("other");
    let authorization = github::GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "grant-one".into(),
    };
    let key = IssueCacheKey {
        authorization: &authorization,
        repository: &repo,
        state: "open",
        query: "",
        page: 1,
    };
    let now = RETENTION_SECONDS + 1;
    store.write(&key, &page(3), now).unwrap();
    store
        .write(&IssueCacheKey { page: 2, ..key }, &page(4), now)
        .unwrap();
    store
        .write(
            &IssueCacheKey {
                repository: &other,
                ..key
            },
            &page(5),
            now,
        )
        .unwrap();
    store.write(&key, &page(6), now + 1).unwrap();
    assert!(
        store
            .read(&IssueCacheKey { page: 2, ..key }, now + 1)
            .unwrap()
            .is_none()
    );
    let connection = Connection::open(&path).unwrap();
    // A legacy execution table is unrelated to the browser cache and must stay intact.
    connection.execute("CREATE TABLE issue_tasks (command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, task TEXT NOT NULL)", []).unwrap();
    connection
        .execute(
            "INSERT INTO issue_tasks VALUES ('command','session','fingerprint','context')",
            [],
        )
        .unwrap();
    store.clear(&key).unwrap();
    assert!(store.read(&key, now + 1).unwrap().is_none());
    assert!(
        store
            .read(
                &IssueCacheKey {
                    repository: &other,
                    ..key
                },
                now + 1
            )
            .unwrap()
            .is_some()
    );
    assert_eq!(
        connection
            .query_row("SELECT task FROM issue_tasks", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "context"
    );
}

#[test]
fn issue_cache_bounds_pages_and_rejects_oversized_replacement_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteIssueCache::open(&dir.path().join("state.db")).unwrap();
    let repo = repository("repo");
    let authorization = github::GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "grant-one".into(),
    };
    let key = IssueCacheKey {
        authorization: &authorization,
        repository: &repo,
        state: "open",
        query: "",
        page: 1,
    };
    let now = RETENTION_SECONDS + 1;
    for index in 1..=MAX_PAGES + 1 {
        store
            .write(
                &IssueCacheKey {
                    page: index as u32,
                    ..key
                },
                &page(index as u64),
                now + index as u64,
            )
            .unwrap();
    }
    assert!(store.read(&key, now + 300).unwrap().is_none());
    assert!(
        store
            .read(&IssueCacheKey { page: 2, ..key }, now + 300)
            .unwrap()
            .is_some()
    );
    let mut large = page(99);
    large.issues[0].title = "x".repeat(MAX_PAGE_BYTES);
    assert!(store.write(&key, &large, now + 300).is_err());
    assert_eq!(
        store
            .read(&IssueCacheKey { page: 2, ..key }, now + 300)
            .unwrap()
            .unwrap()
            .page
            .issues[0]
            .number,
        2
    );
}
