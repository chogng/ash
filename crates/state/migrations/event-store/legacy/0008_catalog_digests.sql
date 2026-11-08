ALTER TABLE thread_catalog ADD COLUMN record_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE thread_catalog ADD COLUMN record_digest TEXT NOT NULL DEFAULT '';
