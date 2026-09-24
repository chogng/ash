use std::sync::mpsc;
use std::time::Duration;

use futures::executor::block_on;

use super::BlockingServiceExecutor;

#[test]
fn blocking_service_work_starts_without_blocking_the_calling_thread() {
    let (started, observe_start) = mpsc::channel();
    let (release, wait_for_release) = mpsc::channel();
    let future = BlockingServiceExecutor.spawn("test service", move || {
        started.send(()).unwrap();
        wait_for_release.recv().unwrap();
        Ok(41_u8)
    });

    observe_start.recv_timeout(Duration::from_secs(2)).unwrap();
    release.send(()).unwrap();
    assert_eq!(block_on(future).unwrap(), 41);
}
