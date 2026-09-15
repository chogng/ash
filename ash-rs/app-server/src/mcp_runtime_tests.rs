use super::McpRuntimeIntents;
use ash_config::McpServerId;
use ash_mcp_extension::McpServerRuntimeIntent;
use std::sync::mpsc::TryRecvError;

#[test]
fn runtime_intents_publish_process_local_changes() {
    let intents = McpRuntimeIntents::default();
    let changes = intents.subscribe();
    let server = McpServerId::new("user:mcp:test").unwrap();

    assert_eq!(changes.try_recv(), Err(TryRecvError::Empty));
    intents.set(server.clone(), McpServerRuntimeIntent::Connect);
    assert_eq!(changes.try_recv(), Ok(()));
    assert_eq!(
        intents.intent(&server),
        Some(McpServerRuntimeIntent::Connect)
    );

    intents.set(server.clone(), McpServerRuntimeIntent::Connect);
    assert_eq!(changes.try_recv(), Err(TryRecvError::Empty));
    intents.reconcile();
    assert_eq!(changes.try_recv(), Ok(()));
    intents.set(server.clone(), McpServerRuntimeIntent::Disconnect);
    assert_eq!(changes.try_recv(), Ok(()));
    assert_eq!(
        intents.intent(&server),
        Some(McpServerRuntimeIntent::Disconnect)
    );
}
