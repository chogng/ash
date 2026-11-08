-- Canonical events are kept so the history index can be rebuilt.
DROP TABLE IF EXISTS thread_history_items;

DROP TABLE thread_history_turns;

DELETE FROM thread_history_index;
