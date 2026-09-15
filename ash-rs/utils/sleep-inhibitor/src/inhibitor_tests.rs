use super::*;
use std::sync::Barrier;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct Counts {
    acquired: AtomicUsize,
    released: AtomicUsize,
}

struct Assertion(Arc<Counts>);

impl Drop for Assertion {
    fn drop(&mut self) {
        self.0.released.fetch_add(1, Ordering::SeqCst);
    }
}

fn inhibitor(counts: &Arc<Counts>) -> SleepInhibitor {
    let counts = Arc::clone(counts);
    SleepInhibitor {
        inner: Arc::new(Inner {
            reason: "test operation".into(),
            acquire: Box::new(move |reason| {
                assert_eq!(reason, "test operation");
                counts.acquired.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(Assertion(Arc::clone(&counts))))
            }),
            state: Mutex::new(State::default()),
        }),
    }
}

#[test]
fn overlapping_operations_release_only_after_the_last_lease() {
    let counts = Arc::new(Counts::default());
    let inhibitor = inhibitor(&counts);
    let first = inhibitor.acquire().unwrap();
    let second = inhibitor.clone().acquire().unwrap();
    assert_eq!(counts.acquired.load(Ordering::SeqCst), 1);
    drop(first);
    assert_eq!(counts.released.load(Ordering::SeqCst), 0);
    drop(second);
    assert_eq!(counts.released.load(Ordering::SeqCst), 1);
    let resumed = inhibitor.acquire().unwrap();
    assert_eq!(counts.acquired.load(Ordering::SeqCst), 2);
    drop(inhibitor);
    assert_eq!(counts.released.load(Ordering::SeqCst), 1);
    drop(resumed);
    assert_eq!(counts.released.load(Ordering::SeqCst), 2);
}

#[test]
fn concurrent_workers_share_one_assertion() {
    let counts = Arc::new(Counts::default());
    let inhibitor = inhibitor(&counts);
    let acquired = Barrier::new(9);
    let release = Barrier::new(9);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                let lease = inhibitor.acquire().unwrap();
                acquired.wait();
                release.wait();
                drop(lease);
            });
        }
        acquired.wait();
        assert_eq!(counts.acquired.load(Ordering::SeqCst), 1);
        assert_eq!(counts.released.load(Ordering::SeqCst), 0);
        release.wait();
    });
    assert_eq!(counts.released.load(Ordering::SeqCst), 1);
}

#[test]
fn a_failed_acquisition_retains_no_lease_and_can_be_retried() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let counts = Arc::new(Counts::default());
    let inhibitor = SleepInhibitor {
        inner: Arc::new(Inner {
            reason: "test".into(),
            acquire: Box::new({
                let attempts = Arc::clone(&attempts);
                let counts = Arc::clone(&counts);
                move |_| {
                    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
                    }
                    Ok(Box::new(Assertion(Arc::clone(&counts))))
                }
            }),
            state: Mutex::new(State::default()),
        }),
    };
    assert!(
        matches!(inhibitor.acquire(), Err(error) if error.kind() == io::ErrorKind::PermissionDenied)
    );
    let lease = inhibitor.acquire().unwrap();
    drop(lease);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(counts.released.load(Ordering::SeqCst), 1);
}

#[test]
fn unwinding_releases_the_assertion() {
    let counts = Arc::new(Counts::default());
    let inhibitor = inhibitor(&counts);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lease = inhibitor.acquire().unwrap();
            panic!("operation failed");
        }))
        .is_err()
    );
    assert_eq!(counts.released.load(Ordering::SeqCst), 1);
    drop(inhibitor.acquire().unwrap());
    assert_eq!(counts.released.load(Ordering::SeqCst), 2);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_registers_and_releases_a_real_idle_sleep_assertion() {
    let reason = format!("Ash sleep inhibitor test {}", std::process::id());
    let assertions = || {
        let output = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter(|line| line.contains(&reason) && line.contains("PreventUserIdleSystemSleep"))
            .count()
    };
    let inhibitor = SleepInhibitor::new(&reason);
    assert_eq!(assertions(), 0);
    let first = inhibitor.acquire().unwrap();
    let second = inhibitor.acquire().unwrap();
    assert_eq!(assertions(), 1);
    drop(first);
    assert_eq!(assertions(), 1);
    drop(second);
    assert_eq!(assertions(), 0);
}
