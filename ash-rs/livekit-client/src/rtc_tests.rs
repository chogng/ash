use super::wait_for_connection;
use tokio::sync::watch;
use webrtc::peer_connection::RTCPeerConnectionState;

#[tokio::test]
async fn publisher_waits_for_transport_connection_before_sending() {
    let (state, receiver) = watch::channel(RTCPeerConnectionState::New);
    let mut waiting = Box::pin(wait_for_connection(receiver));
    assert!(futures::poll!(&mut waiting).is_pending());
    state.send_replace(RTCPeerConnectionState::Connecting);
    assert!(futures::poll!(&mut waiting).is_pending());
    state.send_replace(RTCPeerConnectionState::Connected);
    waiting.await.unwrap();
    // Republishing on an established transport needs no new state transition.
    wait_for_connection(state.subscribe()).await.unwrap();
}

#[tokio::test]
async fn publisher_wait_ends_when_connection_cannot_complete() {
    for terminal in [
        RTCPeerConnectionState::Failed,
        RTCPeerConnectionState::Closed,
        RTCPeerConnectionState::Disconnected,
    ] {
        let (state, receiver) = watch::channel(RTCPeerConnectionState::Connecting);
        let mut waiting = Box::pin(wait_for_connection(receiver));
        assert!(futures::poll!(&mut waiting).is_pending());
        state.send_replace(terminal);
        assert!(waiting.await.is_err());
    }
    let (state, receiver) = watch::channel(RTCPeerConnectionState::Connecting);
    drop(state);
    assert!(wait_for_connection(receiver).await.is_err());
}
