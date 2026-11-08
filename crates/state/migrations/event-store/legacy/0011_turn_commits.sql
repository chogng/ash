CREATE TABLE turn_commits (
    commit_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL
);

CREATE INDEX turn_commits_thread ON turn_commits(thread_id);
