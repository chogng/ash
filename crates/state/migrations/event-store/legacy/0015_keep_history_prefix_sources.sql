ALTER TABLE thread_history_prefixes RENAME TO old_thread_history_prefixes;

CREATE TABLE thread_history_prefixes (
    thread_id TEXT NOT NULL REFERENCES thread_streams(thread_id),
    prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest),
    PRIMARY KEY(thread_id, prefix_digest)
);

INSERT INTO thread_history_prefixes SELECT thread_id, prefix_digest FROM old_thread_history_prefixes;

DROP TABLE old_thread_history_prefixes;
