ALTER TABLE thread_pull_requests ADD COLUMN artifact_id TEXT;
ALTER TABLE thread_pull_requests ADD COLUMN artifact_source_thread TEXT;
ALTER TABLE thread_pull_requests ADD COLUMN artifact_source_turn TEXT;

-- Frozen histories receive artifact identities when imported into a writable profile.
UPDATE thread_pull_requests
SET artifact_id = lower(hex(randomblob(16)))
WHERE is_artifact = 1
  AND NOT EXISTS (SELECT 1 FROM history_ownership WHERE receiver IS NOT NULL);
