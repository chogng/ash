-- Drop legacy file references from current projects and command receipts.
-- Receipts must still deserialize and replay their original revision.
UPDATE projects
SET record_json = json_set(record_json, '$.schemaVersion', 2, '$.materials', json((
    SELECT json_group_array(json(material.value) ORDER BY material.key)
    FROM json_each(projects.record_json, '$.materials') AS material
    WHERE json_extract(material.value, '$.kind') IS NOT 'file'
       OR json_extract(material.value, '$.sizeBytes') IS NOT NULL
)))
WHERE json_extract(record_json, '$.schemaVersion') = 1
  AND coalesce(json_type(record_json, '$.materials'), 'array') = 'array';

UPDATE project_commands
SET result_json = json_set(result_json, '$.schemaVersion', 2, '$.materials', json((
    SELECT json_group_array(json(material.value) ORDER BY material.key)
    FROM json_each(project_commands.result_json, '$.materials') AS material
    WHERE json_extract(material.value, '$.kind') IS NOT 'file'
       OR json_extract(material.value, '$.sizeBytes') IS NOT NULL
)))
WHERE json_extract(result_json, '$.schemaVersion') = 1
  AND coalesce(json_type(result_json, '$.materials'), 'array') = 'array';

UPDATE project_commands
SET request_json = json_set(request_json, '$.command.materials', json((
    SELECT json_group_array(json(material.value) ORDER BY material.key)
    FROM json_each(project_commands.request_json, '$.command.materials') AS material
    WHERE json_extract(material.value, '$.kind') IS NOT 'file'
       OR json_extract(material.value, '$.sizeBytes') IS NOT NULL
)))
WHERE json_type(request_json, '$.command.materials') = 'array'
  AND EXISTS (
      SELECT 1
      FROM json_each(project_commands.request_json, '$.command.materials') AS material
      WHERE json_extract(material.value, '$.kind') = 'file'
        AND json_extract(material.value, '$.sizeBytes') IS NULL
  );
