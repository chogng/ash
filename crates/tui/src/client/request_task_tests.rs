use super::RequestTask;
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[test]
fn request_task_returns_completion_without_blocking_its_polling_owner() {
    let mut task = RequestTask::spawn("request-task-test", || {
        thread::sleep(Duration::from_millis(20));
        7
    })
    .unwrap();

    assert_eq!(task.poll().unwrap(), None);
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Some(value) = task.poll().unwrap() {
            assert_eq!(value, 7);
            break;
        }
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
}
