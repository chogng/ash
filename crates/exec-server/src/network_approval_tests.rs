use super::*;

#[test]
fn dropping_the_proxy_decision_removes_its_pending_reply() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        let owner = std::sync::Arc::new(NetworkApprovals::new(
            "operation".into(),
            Default::default(),
        ));
        let policy = owner.policy();
        let cancellation = ash_async_utils::CancellationSource::new();
        let target =
            NetworkRequest::new(network_proxy::NetworkProtocol::Http, "example.test", 80).unwrap();
        let mut decision = policy.decide(target, cancellation.token());
        std::future::poll_fn(|context| {
            assert!(decision.as_mut().poll(context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        let requests = owner.requests().unwrap();
        assert_eq!(requests.len(), 1);
        drop(decision);
        assert!(owner.requests().unwrap().is_empty());
        assert_eq!(
            owner.respond(&requests[0].request_id, true),
            Err(ExecError::NotFound)
        );
    });
}
