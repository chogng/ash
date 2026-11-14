-- A derived index over canonical records. No transcript text or competing state is stored.
CREATE TABLE thread_voice_events (
    thread_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    voice_session_id TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_id, sequence),
    FOREIGN KEY (thread_id, sequence) REFERENCES thread_events(thread_id, sequence) ON DELETE CASCADE
);
CREATE INDEX thread_voice_events_session ON thread_voice_events(thread_id, voice_session_id, sequence);
CREATE INDEX thread_voice_events_time ON thread_voice_events(thread_id, recorded_at_ms, sequence);
INSERT INTO thread_voice_events
SELECT events.thread_id, events.sequence,
       json_extract(records.record_json, '$.event.transcript.voiceSessionId'),
       json_extract(records.record_json, '$.recordedAt')
FROM thread_events AS events JOIN history_records AS records ON records.digest = events.record_digest
WHERE json_extract(records.record_json, '$.event.type') = 'voiceTranscriptRecorded';
CREATE TRIGGER thread_voice_events_append AFTER INSERT ON thread_events
WHEN json_extract((SELECT record_json FROM history_records WHERE digest = NEW.record_digest), '$.event.type') = 'voiceTranscriptRecorded'
BEGIN
    INSERT INTO thread_voice_events
    SELECT NEW.thread_id, NEW.sequence,
           json_extract(record_json, '$.event.transcript.voiceSessionId'),
           json_extract(record_json, '$.recordedAt')
    FROM history_records WHERE digest = NEW.record_digest;
END;
