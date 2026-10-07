use super::Calls;
use super::NotificationQueue;
use ash_app_server_protocol::protocol::call::CallDeployment;
use ash_app_server_protocol::protocol::call::CallStartParams;
use ash_http_client::NetworkAccess;
use ash_http_client::OutboundNetworkPolicy;
use std::collections::BTreeSet;
use std::path::Path;

#[test]
fn blocked_call_host_is_rejected_before_starting_local_devices() {
    let mut calls = Calls::default();
    calls.set_network_policy(OutboundNetworkPolicy::new(NetworkAccess::Hosts(
        BTreeSet::new(),
    )));
    let error = calls
        .start(
            1,
            CallStartParams {
                resource_id: "call-1".into(),
                operation_id: "start-1".into(),
                device_id: "device-1".into(),
                deployment: CallDeployment::Server {
                    url: "https://media.example.com".into(),
                    administrator: "unused".into(),
                },
            },
            Path::new("."),
            NotificationQueue::default(),
        )
        .unwrap_err();
    assert!(error.contains("blocked by application network policy"));
}
