use super::Broker;
use std::net::TcpStream;
use std::sync::Weak;
use std::time::Duration;

#[test]
fn idle_broker_shutdown_wakes_accept_and_releases_its_listener() {
    let mut broker = Broker::start(Weak::new()).unwrap();
    let address = broker.connection.address;
    broker.stop();
    // Shutdown joins the worker: a successful return must release the listening socket.
    assert!(TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_err());
    broker.stop();
}
