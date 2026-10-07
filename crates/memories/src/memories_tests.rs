use super::*;
use ash_protocol::CommandId;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
struct RecordingStore {
    add: Mutex<Option<MemoryAddCommit>>,
    read_gate: Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>,
}

impl MemoryStore for RecordingStore {
    fn policy(&self, scope: &MemoryScope) -> Result<MemoryPolicy, MemoryStoreError> {
        Ok(MemoryPolicy::disabled(scope.clone()))
    }
    fn update_policy(
        &self,
        _: &MemoryPolicyCommit,
    ) -> Result<MemoryPolicyMutationResult, MemoryStoreError> {
        Err(MemoryStoreError::NotFound)
    }
    fn context(&self, _: &MemoryStoreContextRequest) -> Result<Vec<Memory>, MemoryStoreError> {
        Ok(Vec::new())
    }

    fn add(
        &self,
        commit: &MemoryAddCommit,
        cancellation: &async_utils::CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryStoreError> {
        cancellation
            .check()
            .map_err(|signal| MemoryStoreError::Cancelled(signal.reason().to_string()))?;
        *self.add.lock().unwrap() = Some(commit.clone());
        Ok(MemoryMutationResult {
            disposition: MemoryMutationDisposition::Committed,
            catalog_revision: 1,
            memory: commit.memory.clone(),
        })
    }

    fn update(
        &self,
        _: &MemoryUpdateCommit,
        cancellation: &async_utils::CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryStoreError> {
        cancellation
            .check()
            .map_err(|signal| MemoryStoreError::Cancelled(signal.reason().to_string()))?;
        Err(MemoryStoreError::NotFound)
    }

    fn delete(&self, _: &MemoryDeleteCommit) -> Result<MemoryDeleteResult, MemoryStoreError> {
        Err(MemoryStoreError::NotFound)
    }

    fn read(&self, _: &MemoryScope, _: &MemoryId) -> Result<Memory, MemoryStoreError> {
        Err(MemoryStoreError::NotFound)
    }

    fn read_for_context(&self, _: &MemoryScope, _: &MemoryId) -> Result<Memory, MemoryStoreError> {
        if let Some((entered, released)) = &self.read_gate {
            entered.wait();
            released.wait();
        }
        self.add
            .lock()
            .unwrap()
            .as_ref()
            .map(|commit| commit.memory.clone())
            .ok_or(MemoryStoreError::ReadDenied)
    }

    fn list(&self, _: &MemoryStoreListRequest) -> Result<MemoryStorePage, MemoryStoreError> {
        Ok(MemoryStorePage {
            catalog_revision: 0,
            memories: Vec::new(),
            has_more: false,
        })
    }

    fn search(&self, _: &MemoryStoreSearchRequest) -> Result<MemoryStorePage, MemoryStoreError> {
        Ok(MemoryStorePage {
            catalog_revision: 0,
            memories: Vec::new(),
            has_more: false,
        })
    }
}

#[test]
fn user_addition_normalizes_search_and_rejects_unbounded_content() {
    let store = Arc::new(RecordingStore::default());
    let memories = Memories::new(store.clone());
    let result = memories
        .add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new("add-1").unwrap(),
                memory_id: MemoryId::new("memory-1").unwrap(),
                scope: MemoryScope::Profile,
                title: "Preferred Editor".into(),
                body: "Use Ash for Rust work.".into(),
            },
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(result.memory.source, MemorySource::User);
    assert_eq!(
        store
            .add
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .normalized_search_text,
        "preferred editor\nuse ash for rust work."
    );

    assert!(
        memories
            .add_user_memory(
                AddMemoryRequest {
                    command_id: CommandId::new("add-2").unwrap(),
                    memory_id: MemoryId::new("memory-2").unwrap(),
                    scope: MemoryScope::Profile,
                    title: "title".into(),
                    body: "x".repeat(16 * 1024 + 1),
                },
                &async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
}

#[test]
fn identifiers_and_page_limits_are_strict() {
    assert!(MemoryId::new("").is_err());
    assert!(MemoryId::new("contains space").is_err());
    let memories = Memories::new(Arc::new(RecordingStore::default()));
    assert!(
        memories
            .list(ListMemoriesRequest {
                scope: MemoryScope::Profile,
                cursor: None,
                limit: 0,
            })
            .is_err()
    );
}

#[test]
fn citation_round_trip_rejects_malformed_references() {
    let citation = MemoryCitation {
        memory_id: MemoryId::new("memory-1").unwrap(),
        scope: MemoryScope::Profile,
        revision: 3,
        start_byte: 2,
        end_byte: 15,
    };
    assert_eq!(
        MemoryCitation::parse(&citation.reference().unwrap()).unwrap(),
        citation
    );
    for reference in [
        "file:abc",
        "memory:***",
        "memory:",
        &format!("memory:{}", "x".repeat(4096)),
    ] {
        assert!(MemoryCitation::parse(reference).is_err());
    }
    let empty = MemoryCitation {
        end_byte: 2,
        ..citation
    };
    assert!(MemoryCitation::parse(&empty.reference().unwrap()).is_err());
}

#[test]
fn cancellation_during_citation_read_discards_the_loaded_body() {
    let entered = Arc::new(std::sync::Barrier::new(2));
    let released = Arc::new(std::sync::Barrier::new(2));
    let store = Arc::new(RecordingStore {
        read_gate: Some((entered.clone(), released.clone())),
        ..RecordingStore::default()
    });
    let service = Arc::new(Memories::new(store));
    service
        .add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new("add").unwrap(),
                memory_id: MemoryId::new("memory").unwrap(),
                scope: MemoryScope::Profile,
                title: "Decision".into(),
                body: "Rust memory".into(),
            },
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    let cancellation = async_utils::CancellationSource::new();
    let token = cancellation.token();
    let worker = std::thread::spawn(move || {
        service.read_context_citation(
            &[MemoryScope::Profile],
            MemoryCitation {
                memory_id: MemoryId::new("memory").unwrap(),
                scope: MemoryScope::Profile,
                revision: 1,
                start_byte: 0,
                end_byte: 11,
            },
            &token,
        )
    });
    entered.wait();
    cancellation.cancel();
    released.wait();
    assert!(matches!(
        worker.join().unwrap(),
        Err(MemoryError::Cancelled(_))
    ));
}
