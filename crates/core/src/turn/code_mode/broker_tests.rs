use super::CellCall;
use super::CodeModeBroker;
use super::TurnKey;
use crate::CoreError;
use crate::InMemoryThreadStore;
use crate::ModelToolCatalogSnapshot;
use crate::NoTools;
use crate::ThreadController;
use crate::turn_policy::UnavailableActionPolicyService;
use ash_async_utils::CancellationSource;
use ash_code_mode_protocol::CellId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use std::sync::Arc;

#[test]
fn interrupted_turn_rejects_cell_registration_after_cleanup() {
    let broker = CodeModeBroker::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(NoTools),
        Arc::new(UnavailableActionPolicyService),
    );
    let session_id = SessionId::new("session").unwrap();
    let thread_id = ThreadId::new("thread").unwrap();
    let turn_id = TurnId::new("turn").unwrap();
    let key = TurnKey::new(session_id.to_string(), &thread_id, &turn_id);
    let cancellation = CancellationSource::new();
    let call = || CellCall {
        parent: ToolCallId::new("exec").unwrap(),
        catalog: ModelToolCatalogSnapshot::new(Vec::new()),
        tools: Arc::clone(&broker.tools),
        policy: Arc::clone(&broker.policy),
    };
    broker
        .register_cell(
            &key,
            &CellId::new("active").unwrap(),
            call(),
            &cancellation.token(),
        )
        .unwrap();

    cancellation.cancel();
    broker.turn_cleanup(&session_id, &thread_id, &turn_id)();

    let late = broker.register_cell(
        &key,
        &CellId::new("late").unwrap(),
        call(),
        &cancellation.token(),
    );
    assert!(matches!(late, Err(CoreError::Cancelled(_))));
    assert!(broker.inner.cell_calls.lock().unwrap().is_empty());
    assert!(matches!(
        broker.session_for(&key, &cancellation.token()),
        Err(CoreError::Cancelled(_))
    ));
    assert!(broker.inner.sessions.lock().unwrap().is_empty());
}
