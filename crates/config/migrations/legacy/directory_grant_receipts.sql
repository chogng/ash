UPDATE config_command_receipts SET command_json = json_set(command_json, '$.type', 'setDirectoryGrant')
WHERE json_extract(command_json, '$.type') = 'setDirPermissions';
UPDATE config_command_receipts SET command_json = json_set(command_json, '$.type', 'forgetDirectoryGrant')
WHERE json_extract(command_json, '$.type') = 'forgetDirPermissions';
