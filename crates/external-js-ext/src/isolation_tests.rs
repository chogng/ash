use super::restrict_javascript_process;

#[test]
fn javascript_confinement_blocks_host_access_in_all_threads() {
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "isolation::tests::confinement_probe",
            "--nocapture",
        ])
        .env("ASH_JAVASCRIPT_CONFINEMENT_PROBE", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("confinement verified"));
}

#[test]
fn confinement_probe() {
    if std::env::var_os("ASH_JAVASCRIPT_CONFINEMENT_PROBE").is_none() {
        return;
    }
    let (send, receive) = std::sync::mpsc::channel();
    let existing_thread = std::thread::spawn(move || {
        receive.recv().unwrap();
        assert_eq!(
            std::fs::read("/etc/passwd").unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    });
    restrict_javascript_process().unwrap();
    assert_eq!(
        std::fs::read("/etc/passwd").unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        std::fs::write("/tmp/ash-js-must-not-write", b"escape")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        std::net::TcpStream::connect("127.0.0.1:9")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        std::process::Command::new("/usr/bin/true")
            .spawn()
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    send.send(()).unwrap();
    existing_thread.join().unwrap();
    println!("confinement verified");
}
