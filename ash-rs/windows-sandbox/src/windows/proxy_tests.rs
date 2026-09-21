use super::super::process;
use super::super::win;
use super::*;
use std::io::Read;
use std::io::Write;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Threading::*;

#[test]
fn a_connection_without_the_execution_sid_never_reaches_the_upstream_proxy() {
    let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    upstream.set_nonblocking(true).unwrap();
    let reserved = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let owner = win::current_user().unwrap();
    let proxy = Proxy::start(
        port,
        upstream.local_addr().unwrap().port(),
        owner,
        "S-1-5-21-901-902-903-904".into(),
    )
    .unwrap();
    let mut client = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    client
        .write_all(b"CONNECT example.test:443 HTTP/1.1\r\n\r\n")
        .unwrap();
    let mut byte = [0];
    match client.read(&mut byte) {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
            ) => {}
        other => panic!("unauthenticated connection was not closed: {other:?}"),
    }
    assert!(matches!(upstream.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock));
    drop(proxy);
}

#[test]
fn a_connection_from_different_account_never_reaches_the_upstream_proxy() {
    let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    upstream.set_nonblocking(true).unwrap();
    let reserved = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let proxy = Proxy::start(
        port,
        upstream.local_addr().unwrap().port(),
        "S-1-5-21-999-999-999-999".into(),
        "S-1-5-21-901-902-903-904".into(),
    )
    .unwrap();
    let mut client = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    client
        .write_all(b"CONNECT example.test:443 HTTP/1.1\r\n\r\n")
        .unwrap();
    let mut byte = [0];
    match client.read(&mut byte) {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
            ) => {}
        other => panic!("unauthenticated connection was not closed: {other:?}"),
    }
    assert!(matches!(upstream.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock));
    drop(proxy);
}

#[test]
fn cross_account_borrowing_with_execution_sid_is_rejected() {
    let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    upstream.set_nonblocking(true).unwrap();
    let reserved = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let capability = "S-1-5-21-801-802-803-804";
    let foreign_account = "S-1-5-21-999-999-999-999";
    let proxy = Proxy::start(
        port,
        upstream.local_addr().unwrap().port(),
        foreign_account.into(),
        capability.into(),
    )
    .unwrap();
    let (code, _, _) = run_restricted_client(capability, port);
    assert_ne!(code, 0, "cross-account client must fail to connect");
    assert!(
        matches!(upstream.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock),
        "cross-account connection must not reach upstream proxy"
    );
    drop(proxy);
}

#[test]
fn matching_account_and_capability_reaches_upstream() {
    let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    upstream.set_nonblocking(true).unwrap();
    let reserved = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let owner = win::current_user().unwrap();
    let capability = "S-1-5-21-811-812-813-814";
    let proxy = Proxy::start(
        port,
        upstream.local_addr().unwrap().port(),
        owner,
        capability.into(),
    )
    .unwrap();

    let responder = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match upstream.accept() {
                Ok((mut stream, _)) => {
                    // Windows accepts inherit the listener's nonblocking mode.
                    // Wait for the forwarded request instead of treating WouldBlock as EOF.
                    stream.set_nonblocking(false).unwrap();
                    let mut buf = [0u8; 1024];
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let read_len = stream.read(&mut buf).unwrap();
                    if read_len > 0 {
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
                        );
                    }
                    return;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
        panic!("upstream did not receive authorized connection within timeout");
    });

    let (code, stdout, stderr) = run_restricted_client(capability, port);
    assert_eq!(
        code, 0,
        "authorized client must successfully connect: stdout={stdout}, stderr={stderr}"
    );
    responder.join().unwrap();
    drop(proxy);
}

fn run_restricted_client(capability: &str, target_port: u16) -> (i32, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let directory = std::fs::canonicalize(temp.path()).unwrap();
    let _directory_pin = super::super::filesystem::pin(&directory).unwrap();
    let owner = win::current_user().unwrap();
    let desktop = super::super::desktop::Desktop::new(&owner, &owner, capability).unwrap();
    let pipes = process::Pipes::new(&owner, &owner).unwrap();
    let system = std::env::var("SystemRoot").unwrap();
    let command = format!(
        "\"{system}\\System32\\curl.exe\" -s -S --connect-timeout 2 --max-time 3 http://127.0.0.1:{target_port}"
    );
    let request = process::Request {
        version: 4,
        owner: owner.clone(),
        account: owner,
        capability: capability.into(),
        command,
        cwd: directory.to_str().unwrap().into(),
        environment: vec![
            format!("SystemRoot={system}"),
            format!("TEMP={}", directory.display()),
        ],
        pipes: Some(pipes.names.clone()),
        pseudoconsole: None,
        reply: directory.join("unused-reply.json"),
        desktop: desktop.name.clone(),
    };
    let (process, thread, _, _) = process::prepare_child(&request).unwrap();
    struct Cleanup(HANDLE);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            unsafe {
                TerminateProcess(self.0, 1);
                WaitForSingleObject(self.0, 5000);
            }
        }
    }
    let _cleanup = Cleanup(process.0);
    let job = super::super::job::Job::new(&win::random_hex(16).unwrap()).unwrap();
    job.assign_process(process.0).unwrap();
    job.set_ui_limits().unwrap();
    pipes.connect(unsafe { GetCurrentProcess() }).unwrap();
    let [stdin, mut stdout, mut stderr] = pipes.files();
    drop(stdin);
    assert_eq!(unsafe { ResumeThread(thread.0) }, 1);
    assert_eq!(
        unsafe { WaitForSingleObject(process.0, 15000) },
        WAIT_OBJECT_0
    );
    let mut code = 0;
    assert_ne!(unsafe { GetExitCodeProcess(process.0, &mut code) }, 0);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let _ = stdout.read_to_end(&mut out);
    let _ = stderr.read_to_end(&mut err);
    (
        code as i32,
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
    )
}
