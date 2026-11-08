ALTER TABLE thread_pull_requests ADD COLUMN is_artifact INTEGER NOT NULL DEFAULT 0 CHECK(is_artifact IN (0, 1));
