//! A rebuildable voice index and canonical, snapshot-bounded reads.
use ash_history::StoredEvent;
use ash_protocol::ThreadId;
use ash_protocol::VoiceHistoryFilter;
use ash_sqlite::Migration;
use ash_sqlite::Migrator;
use ash_thread_store::ThreadEventPage;
use ash_thread_store::ThreadStoreError;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::types::Value;

const MIGRATOR: Migrator<'_> = Migrator::new(
    "thread-voice-index",
    &[Migration::sql(
        1,
        include_str!("../../migrations/thread-voice-index/0001_voice_events.sql"),
    )],
);

pub(super) fn migrate(connection: &mut Connection) -> Result<(), ThreadStoreError> {
    MIGRATOR.run(connection).map_err(ThreadStoreError::Storage)
}
fn error(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(error.to_string())
}
fn integer(value: u64) -> Result<i64, ThreadStoreError> {
    i64::try_from(value).map_err(error)
}

pub(super) fn read(
    connection: &mut Connection,
    thread_id: &ThreadId,
    after: u64,
    through: Option<u64>,
    filter: &VoiceHistoryFilter,
    limit: usize,
) -> Result<ThreadEventPage, ThreadStoreError> {
    let transaction = connection.transaction().map_err(error)?;
    let current: Option<i64> = transaction
        .query_row(
            "SELECT current_sequence FROM thread_streams WHERE thread_id = ?1",
            [thread_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)?;
    let current = u64::try_from(current.unwrap_or(0)).map_err(error)?;
    let mut sql = String::from(
        "SELECT records.record_json, records.digest, events.sequence, events.event_id FROM thread_voice_events AS voice JOIN thread_events AS events USING(thread_id, sequence) JOIN history_records AS records ON records.digest = events.record_digest WHERE voice.thread_id = ? AND voice.sequence > ? AND voice.sequence <= ?",
    );
    let mut values = vec![
        Value::Text(thread_id.to_string()),
        Value::Integer(integer(after)?),
        Value::Integer(integer(through.unwrap_or(current))?),
    ];
    if let Some(id) = &filter.voice_session_id {
        sql.push_str(" AND voice.voice_session_id = ?");
        values.push(Value::Text(id.clone()));
    }
    if let Some(id) = &filter.event_id {
        sql.push_str(" AND events.event_id = ?");
        values.push(Value::Text(id.clone()));
    }
    if let Some(from) = filter.from_recorded_at_ms {
        sql.push_str(" AND voice.recorded_at_ms >= ?");
        values.push(Value::Integer(integer(from)?));
    }
    if let Some(to) = filter.to_recorded_at_ms {
        sql.push_str(" AND voice.recorded_at_ms < ?");
        values.push(Value::Integer(integer(to)?));
    }
    sql.push_str(" ORDER BY voice.sequence LIMIT ?");
    values.push(Value::Integer(i64::try_from(limit).map_err(error)?));
    let events = {
        let mut statement = transaction.prepare(&sql).map_err(error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(error)?;
        rows.map(|row| {
            let (json, digest, sequence, event_id) = row.map_err(error)?;
            let event: StoredEvent = super::history::decode_record(&json, &digest)?;
            if event.thread_id != *thread_id
                || event.event.thread_id() != thread_id
                || event.sequence != u64::try_from(sequence).map_err(error)?
                || event.event_id.0 != event_id
                || !ash_thread_store::voice_event_matches(&event, filter)
            {
                return Err(error("voice index disagrees with its canonical record"));
            }
            Ok(event)
        })
        .collect::<Result<Vec<_>, _>>()?
    };
    transaction.commit().map_err(error)?;
    Ok(ThreadEventPage {
        events,
        current_sequence: current,
    })
}
