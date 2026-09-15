use super::*;
use ash_async_utils::CancellationSource;
use ash_install_context::InstallContext;

#[test]
fn exited_server_returns_an_error_instead_of_using_its_stale_index() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let cancellation = CancellationSource::new();
    let server = Server::start(
        &Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &cancellation.token(),
    )
    .unwrap();
    {
        let mut child = server.child.lock().unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
    }
    let error = server
        .rpc(
            "status",
            Value::Null,
            &cancellation.token(),
            Instant::now() + TIMEOUT,
        )
        .unwrap_err();
    assert!(error.to_string().contains("server exited"));
}

#[cfg(unix)]
#[test]
fn cancellation_of_an_active_scan_reaps_its_child() {
    let temporary = tempfile::tempdir().unwrap();
    let pid_file = temporary.path().join("pid");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("echo $$ > \"$1\"; exec sleep 60")
        .arg("scan-test")
        .arg(&pid_file);
    let cancellation = CancellationSource::new();
    thread::scope(|scope| {
        let worker = scope.spawn(|| {
            capture(
                command,
                &cancellation.token(),
                Instant::now() + TIMEOUT,
                101,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        cancellation.cancel();
        let result = worker.join().unwrap();
        assert!(matches!(result, Err(Error::Cancelled(_))));
    });
    let pid = std::fs::read_to_string(pid_file).unwrap();
    assert!(
        !Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn normal_host_exit_reaps_servers_even_when_sessions_are_retained() {
    const CHILD_INDEX: &str = "ASH_TGREP_TEST_EXIT_INDEX";
    if let Some(index) = std::env::var_os(CHILD_INDEX) {
        let index = PathBuf::from(index);
        let server = Server::start(
            &Executable::resolve(&InstallContext::current()).unwrap(),
            &index.join("root"),
            &index.join("index"),
            &CancellationSource::new().token(),
        )
        .unwrap();
        std::fs::write(index.join("address"), server.address.to_string()).unwrap();
        // Mirrors managed hosts that exit without dropping all background runtime references.
        std::mem::forget(server);
        std::process::exit(0);
    }
    let temporary = tempfile::tempdir().unwrap();
    std::fs::create_dir(temporary.path().join("root")).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "process::tests::normal_host_exit_reaps_servers_even_when_sessions_are_retained",
        ])
        .env(CHILD_INDEX, temporary.path())
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let address = std::fs::read_to_string(temporary.path().join("address")).unwrap();
    assert!(TcpStream::connect(address).is_err());
}
