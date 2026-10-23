use super::*;

#[test]
fn closing_session_does_not_block_on_a_full_event_channel() {
    let (sender, _receiver) = std::sync::mpsc::sync_channel(1);
    sender
        .send(AppServerEvent::ConnectionClosed(
            ConnectionCloseReason::DriverStopped,
        ))
        .unwrap();
    let closing = AtomicBool::new(true);

    assert!(!send_event(
        &sender,
        AppServerEvent::ConnectionClosed(ConnectionCloseReason::Shutdown),
        &closing,
    ));
}
