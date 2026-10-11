use std::cell::RefCell;
use std::io;
use std::os::fd::RawFd;
use std::process::Command;

thread_local! {
    static CLOEXEC_FAILURE: RefCell<Option<Vec<RawFd>>> = const { RefCell::new(None) };
}

pub(super) fn before_set_cloexec(fd: RawFd) -> io::Result<()> {
    CLOEXEC_FAILURE.with_borrow_mut(|failure| {
        if let Some(fds) = failure {
            fds.push(fd);
            if fds.len() == 2 {
                return Err(io::Error::other("injected slave CLOEXEC failure"));
            }
        }
        Ok(())
    })
}

#[test]
fn cloexec_failure_closes_both_pty_descriptors() {
    // Isolate the FD checks: parallel tests could reuse a closed descriptor number.
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "pty::tests::cloexec_failure_fixture",
            "--nocapture",
        ])
        .env("ASH_PTY_CLOEXEC_FAILURE_FIXTURE", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "FD cleanup fixture failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn cloexec_failure_fixture() {
    if std::env::var_os("ASH_PTY_CLOEXEC_FAILURE_FIXTURE").is_none() {
        return;
    }
    CLOEXEC_FAILURE.with_borrow_mut(|failure| *failure = Some(Vec::new()));
    let error = super::open_unix_pty(crate::TerminalSize::default()).unwrap_err();
    assert!(error.to_string().contains("injected slave CLOEXEC failure"));
    let fds = CLOEXEC_FAILURE.with_borrow_mut(Option::take).unwrap();
    assert_eq!(fds.len(), 2);
    for fd in fds {
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
    }
}
