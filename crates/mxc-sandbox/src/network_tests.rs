use super::MxcSandbox;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_install_context::InstallContext;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandOutput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use network_proxy::NetworkDecision;
use network_proxy::NetworkPolicyHandle;
use std::io;
use std::io::Read;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

struct Approved;
impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

fn execute(
    scope: &SandboxScope,
    network: NetworkAccess,
    policy: Option<&NetworkPolicyHandle>,
    program: &str,
    arguments: Vec<String>,
) -> CommandOutput {
    let executor = CommandExecutor::new(
        scope.command_dir().clone(),
        MxcSandbox::new(InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout: Duration::from_secs(5),
            max_output_bytes: 4096,
        },
    );
    let outcome = executor
        .execute_scoped_with_network(
            CommandRequest {
                program: program.into(),
                arguments,
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                FileSystemAccess::DirectoryWrite,
                network,
            )),
            &CancellationSource::new().token(),
            Some(scope),
            policy,
        )
        .unwrap();
    match outcome {
        CommandExecutionOutcome::Completed(output) => output,
        CommandExecutionOutcome::SandboxDenied(denial) => CommandOutput {
            exit_code: match denial.output().exit_status() {
                ash_protocol::ProcessExitStatus::Code(code) => Some(code),
                _ => None,
            },
            stdout: denial.output().stdout().to_owned(),
            stderr: denial.output().stderr().to_owned(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    }
}

fn curl_arguments(url: String) -> Vec<String> {
    vec![
        "--fail".into(),
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        "2".into(),
        url,
    ]
}

struct HttpFixture {
    stopped: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<thread::JoinHandle<()>>,
}
impl HttpFixture {
    fn start<S: Read + Write + Send + 'static>(
        mut accept: impl FnMut() -> io::Result<S> + Send + 'static,
    ) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::clone(&stopped);
        let count = Arc::clone(&requests);
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match accept() {
                    Ok(mut stream) => {
                        let mut bytes = [0; 4096];
                        if stream.read(&mut bytes).is_ok_and(|size| size > 0) {
                            count.fetch_add(1, Ordering::SeqCst);
                            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nfixture-ok");
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            }
        });
        Self {
            stopped,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

#[test]
#[ignore = "requires ASH_SANDBOX_LAN_IP set to this Mac's reachable private IPv4 address"]
fn lan_http_requires_proxy_authorization_and_rejects_direct_access() {
    let ip: Ipv4Addr = std::env::var("ASH_SANDBOX_LAN_IP")
        .unwrap()
        .parse()
        .unwrap();
    assert!(ip.is_private() && !ip.is_loopback());
    let listener = TcpListener::bind((ip, 0)).unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let fixture = HttpFixture::start(move || {
        let (stream, _) = listener.accept()?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        Ok(stream)
    });
    let url = format!("http://{address}/");
    let mut direct = curl_arguments(url.clone());
    direct.extend(["--noproxy".into(), "*".into()]);
    let positive = std::process::Command::new("/usr/bin/curl")
        .args(&direct)
        .output()
        .unwrap();
    assert!(
        positive.status.success(),
        "ordinary LAN request: {positive:?}"
    );
    assert_eq!(positive.stdout, b"fixture-ok");
    let directory = tempfile::tempdir().unwrap();
    let scope = SandboxScope::single(Dir::open_local(directory.path()).unwrap());
    assert_ne!(
        execute(
            &scope,
            NetworkAccess::Denied,
            None,
            "/usr/bin/curl",
            direct.clone()
        )
        .exit_code,
        Some(0)
    );
    let seen = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&seen);
    let allow = NetworkPolicyHandle::new(move |request: network_proxy::NetworkRequest, _| {
        assert_eq!(request.host(), ip.to_string());
        assert_eq!(request.port(), address.port());
        observed.fetch_add(1, Ordering::SeqCst);
        async { NetworkDecision::Allow }
    });
    assert_ne!(
        execute(
            &scope,
            NetworkAccess::Managed,
            Some(&allow),
            "/usr/bin/curl",
            direct
        )
        .exit_code,
        Some(0)
    );
    assert_eq!(
        seen.load(Ordering::SeqCst),
        0,
        "direct requests must not reach the proxy"
    );
    let proxied = execute(
        &scope,
        NetworkAccess::Managed,
        Some(&allow),
        "/usr/bin/curl",
        curl_arguments(url.clone()),
    );
    assert_eq!(proxied.exit_code, Some(0), "{proxied:?}");
    assert_eq!(proxied.stdout, "fixture-ok");
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    let deny = NetworkPolicyHandle::new(|_, _| async {
        NetworkDecision::Deny("unapproved LAN target".into())
    });
    assert_ne!(
        execute(
            &scope,
            NetworkAccess::Managed,
            Some(&deny),
            "/usr/bin/curl",
            curl_arguments(url)
        )
        .exit_code,
        Some(0)
    );
    assert_eq!(
        fixture.requests.load(Ordering::SeqCst),
        2,
        "only the ordinary and approved requests reach the LAN fixture"
    );
}

#[test]
fn private_ipc_directory_does_not_open_other_writable_sockets() {
    let directory = tempfile::tempdir().unwrap();
    let private = directory.path().join("ipc");
    std::fs::create_dir(&private).unwrap();
    let work = directory.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let root = Dir::open_local(&work).unwrap();
    let scope = SandboxScope::single(root)
        .with_private_ipc_dir(Dir::open_local(&private).unwrap())
        .unwrap();
    for (path, allowed) in [(private.join("s"), true), (work.join("s"), false)] {
        let control = path.with_file_name("control");
        let script = "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])";
        assert!(
            std::process::Command::new("/usr/bin/python3")
                .args(["-c", script])
                .arg(&control)
                .status()
                .unwrap()
                .success()
        );
        let created = path.with_file_name("created");
        let output = execute(
            &scope,
            NetworkAccess::Denied,
            None,
            "/usr/bin/python3",
            vec!["-c".into(), script.into(), created.display().to_string()],
        );
        assert_eq!(
            output.exit_code == Some(0),
            allowed,
            "Unix bind: {output:?}"
        );
        assert_eq!(created.exists(), allowed);
        let written = path.with_file_name("written");
        assert_eq!(
            execute(
                &scope,
                NetworkAccess::Denied,
                None,
                "/usr/bin/touch",
                vec![written.display().to_string()]
            )
            .exit_code,
            Some(0)
        );
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let fixture = HttpFixture::start(move || {
            let (stream, _) = listener.accept()?;
            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
            Ok(stream)
        });
        let mut arguments = curl_arguments("http://localhost/".into());
        arguments.extend([
            "--noproxy".into(),
            "*".into(),
            "--unix-socket".into(),
            path.display().to_string(),
        ]);
        let positive = std::process::Command::new("/usr/bin/curl")
            .args(&arguments)
            .output()
            .unwrap();
        assert!(
            positive.status.success(),
            "ordinary IPC request: {positive:?}"
        );
        let output = execute(
            &scope,
            NetworkAccess::Denied,
            None,
            "/usr/bin/curl",
            arguments,
        );
        assert_eq!(output.exit_code == Some(0), allowed, "{output:?}");
        assert_eq!(
            fixture.requests.load(Ordering::SeqCst),
            if allowed { 2 } else { 1 }
        );
    }
}

#[test]
fn sensitive_ipc_stays_denied_inside_a_private_ipc_directory() {
    const CHILD_SOCKET: &str = "ASH_SANDBOX_TEST_SENSITIVE_SOCKET";
    if let Some(path) = std::env::var_os(CHILD_SOCKET) {
        let path = std::path::PathBuf::from(path);
        assert_eq!(
            std::env::var_os("SSH_AUTH_SOCK"),
            Some(path.clone().into_os_string())
        );
        let dir = Dir::open_local(path.parent().unwrap()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let scope = SandboxScope::single(Dir::open_local(work.path()).unwrap())
            .with_private_ipc_dir(dir)
            .unwrap();
        let mut arguments = curl_arguments("http://localhost/".into());
        arguments.extend([
            "--noproxy".into(),
            "*".into(),
            "--unix-socket".into(),
            path.display().to_string(),
        ]);
        let output = execute(
            &scope,
            NetworkAccess::Denied,
            None,
            "/usr/bin/curl",
            arguments,
        );
        assert_ne!(output.exit_code, Some(0), "{output:?}");
        return;
    }
    // The child owns its environment; parallel host tests never mutate SSH_AUTH_SOCK.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("s");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let fixture = HttpFixture::start(move || {
        let (stream, _) = listener.accept()?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        Ok(stream)
    });
    let positive = std::process::Command::new("/usr/bin/curl")
        .args(curl_arguments("http://localhost/".into()))
        .args(["--noproxy", "*", "--unix-socket"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        positive.status.success(),
        "ordinary sensitive socket request: {positive:?}"
    );
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "network_tests::sensitive_ipc_stays_denied_inside_a_private_ipc_directory",
            "--nocapture",
        ])
        .env("SSH_AUTH_SOCK", &path)
        .env(CHILD_SOCKET, &path)
        .output()
        .unwrap();
    assert!(child.status.success(), "sensitive socket child: {child:?}");
    assert_eq!(fixture.requests.load(Ordering::SeqCst), 1);
}
