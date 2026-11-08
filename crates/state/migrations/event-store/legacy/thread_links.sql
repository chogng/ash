CREATE TABLE IF NOT EXISTS thread_pull_requests (
    thread_id TEXT NOT NULL REFERENCES thread_streams(thread_id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    owner TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    PRIMARY KEY(thread_id, host, owner, repository, number)
);

CREATE TABLE IF NOT EXISTS thread_issues (
    thread_id TEXT NOT NULL REFERENCES thread_streams(thread_id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    owner TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    PRIMARY KEY(thread_id, host, owner, repository, number)
);
