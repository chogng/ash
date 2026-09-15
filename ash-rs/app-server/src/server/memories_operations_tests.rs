use super::AppServer;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[test]
fn memory_requests_forward_cancellation_and_only_notify_committed_writes() {
    for revision in [0, 1] {
        let root = tempfile::tempdir().unwrap();
        let server = AppServer::new(
            Arc::new(ThreadController::with_store(Arc::new(
                InMemoryThreadStore::default(),
            ))),
            Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
        )
        .with_ephemeral_env_state()
        .with_local_memories(&root.path().join("state.sqlite"))
        .unwrap();
        let mut host = server.product_host_connection();
        server
            .initialize(
                &mut host,
                &json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}}),
            )
            .unwrap();
        let notifications = server.connection_notifications(&host);
        // Enter the real dispatcher directly: handle_json's initial cancellation check must not
        // mask a missing token in the Memory handler or domain call.
        let mut dispatch = |method: &str, params: Value, cancellation: &CancellationToken| {
            let mut request = serde_json::from_value(
                json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}),
            )
            .unwrap();
            server.dispatch(&mut host, &mut request, cancellation)
        };
        let active = CancellationSource::new();
        let seed = json!({"commandId":"seed","memoryId":"decision","scope":{"type":"profile"},"title":"Decision","body":"Original fact"});
        if revision == 1 {
            dispatch("memory/add", seed.clone(), &active.token()).unwrap();
            assert_eq!(notifications.drain().len(), 1);
        }
        let service = server.memories.as_ref().unwrap();
        let snapshot = || {
            service
                .list(memories::ListMemoriesRequest {
                    scope: memories::MemoryScope::Profile,
                    cursor: None,
                    limit: 10,
                })
                .unwrap()
        };
        let before = snapshot();
        let (method, params) = if revision == 0 {
            ("memory/add", seed)
        } else {
            (
                "memory/update",
                json!({"commandId":"update","memoryId":"decision","scope":{"type":"profile"},"expectedRevision":1,"title":"Decision","body":"Updated fact"}),
            )
        };
        let cancelled = CancellationSource::new();
        cancelled.cancel();
        let error = dispatch(method, params.clone(), &cancelled.token()).unwrap_err();
        assert_eq!(error.code, -32800);
        assert_eq!(error.message, super::AppServerErrorName::RequestCancelled);
        assert_eq!(snapshot(), before);
        assert!(notifications.drain().is_empty());
        if revision == 1 {
            assert_eq!(
                service
                    .read(memories::ReadMemoryRequest {
                        scope: memories::MemoryScope::Profile,
                        memory_id: memories::MemoryId::new("decision").unwrap(),
                    })
                    .unwrap()
                    .body,
                "Original fact"
            );
        }
        let saved = dispatch(method, params.clone(), &active.token()).unwrap();
        assert_eq!(saved["disposition"], "committed");
        assert_eq!(saved["memory"]["revision"], revision + 1);
        assert_eq!(notifications.drain().len(), 1);
        let replay = dispatch(method, params, &active.token()).unwrap();
        assert_eq!(replay["disposition"], "replayed");
        assert!(notifications.drain().is_empty());
    }
}
