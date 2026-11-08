ALTER TABLE message_history ADD COLUMN scope TEXT;

CREATE INDEX message_history_scope ON message_history(scope, id);
