-- Keep existing receipts. Pause undelivered requests whose execution scope was retired.
CREATE TEMP TABLE queue_mode_cleanup AS
SELECT id, session_id, thread_id,
       status IN ('pending', 'delivering')
           AND json_extract(request, '$.mode') <> 'agent'
           AND json_extract(request, '$.taskCommand') IS NULL AS pause
FROM queued_messages
WHERE json_type(request, '$.mode') IS NOT NULL;

UPDATE queue_metadata SET revision = revision + 1
WHERE id = 1 AND EXISTS (SELECT 1 FROM queue_mode_cleanup WHERE pause);

INSERT INTO queue_invalidations(session_id, thread_id, revision)
SELECT DISTINCT session_id, thread_id, (SELECT revision FROM queue_metadata WHERE id = 1)
FROM queue_mode_cleanup WHERE pause
ON CONFLICT(session_id, thread_id) DO UPDATE SET revision = excluded.revision;

UPDATE queued_messages
SET request = json_remove(request, '$.mode'),
    status = CASE WHEN cleanup.pause THEN 'paused' ELSE queued_messages.status END,
    revision = CASE WHEN cleanup.pause THEN (SELECT revision FROM queue_metadata WHERE id = 1)
                    ELSE queued_messages.revision END,
    lease_until = CASE WHEN cleanup.pause THEN 0 ELSE queued_messages.lease_until END
FROM queue_mode_cleanup AS cleanup
WHERE queued_messages.id = cleanup.id;

DROP TABLE queue_mode_cleanup;
