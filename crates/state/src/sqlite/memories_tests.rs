use super::SqliteMemoryStore;
use ash_protocol::CommandId;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use memories::Memories;
use memories::Memory;
use memories::MemoryError;
use memories::MemoryMutationDisposition;
use memories::MemoryMutationResult;
use memories::MemoryScope;
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Copy)]
enum Writer {
    User,
    Model,
}

struct Fixture {
    _root: tempfile::TempDir,
    store: Arc<SqliteMemoryStore>,
    service: Memories,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(SqliteMemoryStore::open(root.path().join("memories.sqlite")).unwrap());
        let service = Memories::new(store.clone());
        service
            .update_policy(memories::UpdateMemoryPolicyRequest {
                command_id: CommandId::new("enable").unwrap(),
                scope: MemoryScope::Profile,
                expected_revision: 0,
                automatic_read: memories::MemoryReadMode::Disabled,
                model_write: memories::MemoryWriteMode::Enabled,
            })
            .unwrap();
        Self {
            _root: root,
            store,
            service,
        }
    }

    fn save(
        &self,
        writer: Writer,
        revision: u64,
        cancellation: &CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryError> {
        let command_id = CommandId::new(format!("save-{revision}")).unwrap();
        let memory_id = memories::MemoryId::new("decision").unwrap();
        let title = "Decision".to_owned();
        let body = format!("Revision {}", revision + 1);
        match writer {
            Writer::User if revision == 0 => self.service.add_user_memory(
                memories::AddMemoryRequest {
                    command_id,
                    memory_id,
                    scope: MemoryScope::Profile,
                    title,
                    body,
                },
                cancellation,
            ),
            Writer::User => self.service.update_user_memory(
                memories::UpdateMemoryRequest {
                    command_id,
                    memory_id,
                    scope: MemoryScope::Profile,
                    expected_revision: revision,
                    title,
                    body,
                },
                cancellation,
            ),
            Writer::Model => self.service.save_model_memory(
                memories::SaveModelMemoryRequest {
                    command_id,
                    scope: MemoryScope::Profile,
                    expected_revision: revision,
                    title,
                    body,
                    session_id: ash_protocol::SessionId::new("session").unwrap(),
                    thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
                    turn_id: ash_protocol::TurnId::new("turn").unwrap(),
                },
                cancellation,
            ),
        }
    }

    fn snapshot(&self) -> (u64, Vec<Memory>, i64) {
        let page = self
            .service
            .list(memories::ListMemoriesRequest {
                scope: MemoryScope::Profile,
                cursor: None,
                limit: 10,
            })
            .unwrap();
        let records = page
            .memories
            .into_iter()
            .map(|memory| {
                self.service
                    .read(memories::ReadMemoryRequest {
                        scope: memory.scope,
                        memory_id: memory.memory_id,
                    })
                    .unwrap()
            })
            .collect();
        let receipts = self
            .store
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM memory_commands", [], |row| row.get(0))
            .unwrap();
        (page.catalog_revision, records, receipts)
    }
}

// The handler runs on the blocked writer's thread, so each test owns its synchronization.
thread_local! {
    static ON_BUSY: RefCell<Option<Box<dyn FnOnce() -> bool>>> = RefCell::new(None);
}

fn on_busy(_: i32) -> bool {
    ON_BUSY.with(|callback| {
        callback
            .borrow_mut()
            .take()
            .is_some_and(|callback| callback())
    })
}

#[test]
fn cancelled_memory_writes_do_not_wait_for_sqlite() {
    for writer in [Writer::User, Writer::Model] {
        for revision in [0, 1] {
            let fixture = Fixture::new();
            let active = CancellationSource::new();
            if revision == 1 {
                fixture.save(writer, 0, &active.token()).unwrap();
            }
            let before = fixture.snapshot();
            let lock =
                crate::open_sqlite_database(fixture.store.path(), crate::SqliteDurability::Durable)
                    .unwrap();
            lock.execute_batch("BEGIN IMMEDIATE").unwrap();
            fixture
                .store
                .connection()
                .unwrap()
                .busy_handler(Some(|_| false))
                .unwrap();
            let cancelled = CancellationSource::new();
            cancelled.cancel();
            assert!(matches!(
                fixture.save(writer, revision, &cancelled.token()),
                Err(MemoryError::Cancelled(_))
            ));
            lock.execute_batch("ROLLBACK").unwrap();
            assert_eq!(fixture.snapshot(), before);
        }
    }
}

#[test]
fn cancellation_while_waiting_for_sqlite_leaves_no_memory_or_receipt_changes() {
    for writer in [Writer::User, Writer::Model] {
        for revision in [0, 1] {
            let fixture = Fixture::new();
            let active = CancellationSource::new();
            if revision == 1 {
                fixture.save(writer, 0, &active.token()).unwrap();
            }
            let before = fixture.snapshot();
            let lock =
                crate::open_sqlite_database(fixture.store.path(), crate::SqliteDurability::Durable)
                    .unwrap();
            lock.execute_batch("BEGIN IMMEDIATE").unwrap();
            let cancellation = CancellationSource::new();
            let source = cancellation.clone();
            let (release, waiting) = mpsc::channel();
            let (released, unlocked) = mpsc::channel();
            let locker = std::thread::spawn(move || {
                waiting.recv_timeout(Duration::from_secs(5)).unwrap();
                lock.execute_batch("ROLLBACK").unwrap();
                released.send(()).unwrap();
            });
            ON_BUSY.with(|callback| {
                *callback.borrow_mut() = Some(Box::new(move || {
                    source.cancel();
                    release.send(()).is_ok()
                        && unlocked.recv_timeout(Duration::from_secs(5)).is_ok()
                }))
            });
            fixture
                .store
                .connection()
                .unwrap()
                .busy_handler(Some(on_busy))
                .unwrap();
            let result = fixture.save(writer, revision, &cancellation.token());
            locker.join().unwrap();
            assert!(cancellation.token().is_cancelled());
            assert!(matches!(result, Err(MemoryError::Cancelled(_))));
            assert_eq!(fixture.snapshot(), before);
            let saved = fixture.save(writer, revision, &active.token()).unwrap();
            assert_eq!(saved.disposition, MemoryMutationDisposition::Committed);
            assert_eq!(saved.memory.revision, revision + 1);
            assert_eq!(
                fixture
                    .save(writer, revision, &active.token())
                    .unwrap()
                    .disposition,
                MemoryMutationDisposition::Replayed
            );
        }
    }
}

#[test]
fn cancellation_during_transaction_preserves_the_memory_result_and_retry_receipt() {
    for writer in [Writer::User, Writer::Model] {
        for revision in [0, 1] {
            let fixture = Fixture::new();
            let active = CancellationSource::new();
            if revision == 1 {
                fixture.save(writer, 0, &active.token()).unwrap();
            }
            let before = fixture.snapshot();
            let cancellation = CancellationSource::new();
            let source = cancellation.clone();
            fixture
                .store
                .connection()
                .unwrap()
                .update_hook(Some(
                    move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                        if table == "memory_catalog" {
                            source.cancel();
                        }
                    },
                ))
                .unwrap();
            let result = fixture
                .save(writer, revision, &cancellation.token())
                .unwrap();
            assert!(cancellation.token().is_cancelled());
            assert_eq!(result.disposition, MemoryMutationDisposition::Committed);
            assert_eq!(result.catalog_revision, before.0 + 1);
            assert_eq!(
                fixture.snapshot(),
                (
                    result.catalog_revision,
                    vec![result.memory.clone()],
                    before.2 + 1
                )
            );
            let replay = fixture.save(writer, revision, &active.token()).unwrap();
            assert_eq!(replay.disposition, MemoryMutationDisposition::Replayed);
            assert_eq!(replay.memory, result.memory);
            assert_eq!(replay.catalog_revision, result.catalog_revision);
        }
    }
}
