-- Queue requests are mutable. Preserve command identity and revision.
UPDATE queued_messages
SET request = json_set(request, '$.approvalMode',
    CASE json_extract(request, '$.approvalMode')
        WHEN 'askPermissions' THEN 'manual'
        ELSE 'auto'
    END)
WHERE json_extract(request, '$.approvalMode') IN ('askPermissions', 'autoReview');
