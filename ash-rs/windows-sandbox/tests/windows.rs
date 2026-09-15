//! Windows acceptance uses the executor → Windows account backend → restricted process chain.
#![cfg(windows)]

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxDirAccess;
use ash_sandboxing::SandboxDirGrant;
use ash_sandboxing::SandboxKind;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionError;
use ash_tool_executor::ExecutionLimits;
use network_proxy::NetworkDecision;
use network_proxy::NetworkPolicyHandle;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use windows_sandbox::WindowsSandbox;

struct Approved;
impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

fn executor(dir: &Dir, timeout: Duration) -> CommandExecutor<Approved, WindowsSandbox> {
    let backend = WindowsSandbox::new(ash_install_context::InstallContext::current());
    assert_eq!(
        backend.kind(),
        SandboxKind::Restricted,
        "the adapter must prepare restricted execution"
    );
    assert!(backend.requires_shared_network_proxy());
    CommandExecutor::new(
        dir.clone(),
        backend,
        Approved,
        ExecutionLimits {
            timeout,
            max_output_bytes: 64 * 1024,
        },
    )
}

fn sandbox_policy(files: FileSystemAccess, network: NetworkAccess) -> SandboxPolicy {
    SandboxPolicy::new(files, network)
        .with_host_acl_changes(ash_sandboxing::HostAclChanges::ScopedWithTraversal)
        .with_file_system_isolation(ash_sandboxing::FileSystemIsolation::WindowsAccount)
}

fn powershell(script: String) -> CommandRequest {
    let program = Path::new(&std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    CommandRequest {
        program: program.to_str().unwrap().into(),
        arguments: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            script,
        ],
        working_directory: ".".into(),
        input: CommandInput::Closed,
    }
}

fn literal(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "''"))
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn scoped_execution_preserves_grants_metadata_and_exit_code_authenticity() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["work", "reference", "other-agent"] {
        std::fs::create_dir(temp.path().join(name)).unwrap();
    }
    let storage = Dir::open_local(temp.path()).unwrap();
    let work = Dir::open_local(temp.path().join("work")).unwrap();
    let reference = Dir::open_local(temp.path().join("reference")).unwrap();
    let secret = temp.path().join("other-agent/secret");
    std::fs::write(&secret, "secret").unwrap();
    std::fs::write(reference.canonical_path().join("input"), "reference").unwrap();
    std::fs::create_dir(work.canonical_path().join(".git")).unwrap();
    std::fs::write(work.canonical_path().join(".git/config"), "metadata").unwrap();
    let protected = [
        work.canonical_path(),
        reference.canonical_path(),
        secret.as_path(),
    ];
    let before = protected.map(sddl);
    let scope = SandboxScope::new(
        work.clone(),
        vec![
            SandboxDirGrant::new(work.clone(), SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(reference.clone(), SandboxDirAccess::ReadOnly),
        ],
        vec![storage],
    )
    .unwrap();
    let script = format!(
        "$ErrorActionPreference='Stop'; Set-Content output 'ok'; \
         if ((Get-Content {}) -ne 'reference') {{ exit 10 }}; \
         function MustDeny([scriptblock]$action) {{ try {{ & $action }} catch {{ return }}; throw 'restriction was not enforced' }}; \
         MustDeny {{ Get-Content {} }}; MustDeny {{ Set-Content {} 'bad' }}; \
         MustDeny {{ Set-Content .git/modified 'bad' }}; if ((Get-Content .git/config) -ne 'metadata') {{ exit 11 }}; MustDeny {{ Set-Content .git/config 'bad' }}; Write-Output 'scoped-ok'; exit 125",
        literal(&reference.canonical_path().join("input")),
        literal(&secret),
        literal(&reference.canonical_path().join("modified")),
    );
    let result = executor(&work, Duration::from_secs(30))
        .execute_scoped_with_network(
            powershell(script),
            CommandExecutionAuthority::Sandboxed(sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Denied,
            )),
            &CancellationSource::new().token(),
            Some(&scope),
            None,
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = result else {
        panic!("{result:?}")
    };
    assert_eq!(output.exit_code, Some(125), "{output:?}");
    assert!(output.stdout.contains("scoped-ok"), "{output:?}");
    assert_eq!(
        protected.map(sddl),
        before,
        "host ACLs changed after teardown"
    );
    assert!(work.canonical_path().join("output").exists());
    assert!(!reference.canonical_path().join("modified").exists());
    assert!(!work.canonical_path().join(".git/modified").exists());
    for name in [".agents", ".codex", ".ash"] {
        assert!(!work.canonical_path().join(name).exists());
    }
}

#[test]
fn strict_isolation_is_rejected_before_installation_or_process_creation() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let command = ash_sandboxing::SandboxCommand::new(
        "cmd.exe",
        ["/c", "echo started>started"],
        dir.canonical_path(),
    );
    let result = WindowsSandbox::new(ash_install_context::InstallContext::current()).prepare(
        &command,
        SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
            .with_host_acl_changes(ash_sandboxing::HostAclChanges::Scoped),
        &dir,
    );
    assert!(
        matches!(result, Err(ash_sandboxing::SandboxError::UnsupportedPolicy(ref reason)) if reason.contains("strict host filesystem isolation"))
    );
    assert!(!temp.path().join("started").exists());
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn denied_network_blocks_ipv6_connections_datagrams_and_listeners() {
    let tcp = TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0)).unwrap();
    tcp.set_nonblocking(true).unwrap();
    let port = tcp.local_addr().unwrap().port();
    let udp = std::net::UdpSocket::bind((std::net::Ipv6Addr::LOCALHOST, port)).unwrap();
    udp.set_nonblocking(true).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let script = format!(
        "$ErrorActionPreference='Stop'; function MustDeny([scriptblock]$a) {{ try {{ & $a }} catch {{ return }}; throw 'network restriction missing' }}; \
         MustDeny {{ $c=[Net.Sockets.TcpClient]::new([Net.Sockets.AddressFamily]::InterNetworkV6); try {{ $c.Connect('::1',{port}) }} finally {{ $c.Dispose() }} }}; \
         MustDeny {{ $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Any,0); try {{ $l.Start() }} finally {{ $l.Stop() }} }}; \
         $u=[Net.Sockets.UdpClient]::new([Net.Sockets.AddressFamily]::InterNetworkV6); try {{ $null=$u.Send([byte[]](1,2,3),3,[Net.IPEndPoint]::new([Net.IPAddress]::IPv6Loopback,{port})) }} catch {{ }} finally {{ $u.Dispose() }}; Write-Output 'ipv6-denied'"
    );
    let result = executor(&dir, Duration::from_secs(15))
        .execute(
            powershell(script),
            CommandExecutionAuthority::Sandboxed(sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Denied,
            )),
            &CancellationSource::new().token(),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = result else {
        panic!("{result:?}")
    };
    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert!(output.stdout.contains("ipv6-denied"), "{output:?}");
    assert_eq!(
        tcp.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        udp.recv(&mut [0; 64]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn concurrent_accounts_keep_their_own_acl_lifetimes() {
    let temp = tempfile::tempdir().unwrap();
    let first_path = temp.path().join("one");
    let second_path = temp.path().join("two");
    std::fs::create_dir(&first_path).unwrap();
    std::fs::create_dir(&second_path).unwrap();
    let first = Dir::open_local(&first_path).unwrap();
    let second = Dir::open_local(&second_path).unwrap();
    std::thread::scope(|threads| {
        let running = threads.spawn(|| executor(&first, Duration::from_secs(20)).execute(
            powershell("$ErrorActionPreference='Stop'; Set-Content ready 'yes'; while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content completed 'one'".into()),
            CommandExecutionAuthority::Sandboxed(sandbox_policy(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)),
            &CancellationSource::new().token(),
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !first_path.join("ready").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            first_path.join("ready").exists(),
            "first account did not start"
        );
        let result = executor(&second, Duration::from_secs(15)).execute(
            powershell("$ErrorActionPreference='Stop'; Set-Content completed 'two'".into()),
            CommandExecutionAuthority::Sandboxed(sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Allowed,
            )),
            &CancellationSource::new().token(),
        );
        std::fs::write(first_path.join("release"), "release").unwrap();
        for result in [result, running.join().unwrap()] {
            let CommandExecutionOutcome::Completed(output) = result.unwrap() else {
                panic!("execution did not complete")
            };
            assert_eq!(output.exit_code, Some(0), "{output:?}");
        }
    });
    assert_eq!(
        std::fs::read_to_string(first_path.join("completed"))
            .unwrap()
            .trim(),
        "one"
    );
    assert_eq!(
        std::fs::read_to_string(second_path.join("completed"))
            .unwrap()
            .trim(),
        "two"
    );
}

#[test]
fn managed_execution_without_a_policy_never_starts() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let result = executor(&dir, Duration::from_secs(5)).execute_scoped_with_network(
        powershell("Set-Content started 'must not run'".into()),
        CommandExecutionAuthority::Sandboxed(sandbox_policy(
            FileSystemAccess::DirectoryWrite,
            NetworkAccess::Managed,
        )),
        &CancellationSource::new().token(),
        None,
        None,
    );
    assert!(
        matches!(result, Err(ExecutionError::Network(_))),
        "{result:?}"
    );
    assert!(!dir.canonical_path().join("started").exists());
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn timeout_and_cancellation_terminate_descendants() {
    for mode in ["timeout", "cancel"] {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let pid_file = dir.canonical_path().join("child.pid");
        let cancellation = CancellationSource::new();
        let watcher = if mode == "cancel" {
            let path = pid_file.clone();
            let source = cancellation.clone();
            Some(std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(12);
                while !path.exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                source.cancel();
            }))
        } else {
            None
        };
        let script = format!(
            "$ErrorActionPreference='Stop'; $p=Start-Process -WindowStyle Hidden -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru; [IO.File]::WriteAllText({}, [string]$p.Id); Start-Sleep 60",
            literal(&pid_file)
        );
        let timeout = Duration::from_secs(if mode == "cancel" { 15 } else { 8 });
        let result = executor(&dir, timeout).execute(
            powershell(script),
            CommandExecutionAuthority::Sandboxed(sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Denied,
            )),
            &cancellation.token(),
        );
        if let Some(watcher) = watcher {
            watcher.join().unwrap();
        }
        match (mode, result) {
            ("timeout", Err(ExecutionError::TimedOut))
            | ("cancel", Err(ExecutionError::CancelledAfterStart(_))) => {}
            (_, result) => panic!("unexpected {mode} result: {result:?}"),
        }
        let pid: u32 = std::fs::read_to_string(pid_file)
            .expect("sandbox must start its descendant before termination")
            .parse()
            .unwrap();
        assert_process_exited(pid);
    }
}

fn assert_process_exited(pid: u32) {
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"),
        ])
        .status()
        .unwrap();
    assert!(status.success(), "SDK descendant survived execution");
}

fn sddl(path: &Path) -> String {
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "$ErrorActionPreference='Stop'; $p={}; if ([IO.Directory]::Exists($p)) {{ [IO.Directory]::GetAccessControl($p).Sddl }} else {{ [IO.File]::GetAccessControl($p).Sddl }}",
                literal(path)
            ),
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap()
}

struct Origin {
    port: u16,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Origin {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let mut headers = Vec::new();
                        let mut byte = [0];
                        while headers.len() < 8192 && !headers.ends_with(b"\r\n\r\n") {
                            if stream.read_exact(&mut byte).is_err() {
                                break;
                            }
                            headers.push(byte[0]);
                        }
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\napproved");
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self {
            port,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for Origin {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox and ASH_NETWORK_PROBE"]
fn managed_execution_allows_the_proxy_and_blocks_direct_traffic_and_listeners() {
    let origin = Origin::start();
    let target = origin.port;
    let forbidden = TcpListener::bind("127.0.0.1:0").unwrap();
    forbidden.set_nonblocking(true).unwrap();
    let forbidden_port = forbidden.local_addr().unwrap().port();
    let foreign = TcpListener::bind("127.0.0.1:0").unwrap();
    foreign.set_nonblocking(true).unwrap();
    let foreign_port = foreign.local_addr().unwrap().port();
    let udp = std::net::UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, forbidden_port)).unwrap();
    udp.set_nonblocking(true).unwrap();
    let policy = NetworkPolicyHandle::new(
        move |request: network_proxy::NetworkRequest, _| async move {
            if request.port() == target {
                NetworkDecision::Allow
            } else {
                NetworkDecision::Deny("blocked".into())
            }
        },
    );
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let probe = dir.canonical_path().join("probe.exe");
    std::fs::copy(
        std::env::var_os("ASH_NETWORK_PROBE").expect("build network-proxy --example probe"),
        &probe,
    )
    .unwrap();
    let result = executor(&dir, Duration::from_secs(30))
        .execute_scoped_with_network(
            CommandRequest {
                program: probe.to_str().unwrap().into(),
                arguments: vec![
                    target.to_string(),
                    forbidden_port.to_string(),
                    foreign_port.to_string(),
                ],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Sandboxed(sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Managed,
            )),
            &CancellationSource::new().token(),
            None,
            Some(&policy),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = result else {
        panic!("{result:?}")
    };
    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert!(output.stdout.contains("network-probe-ready"), "{output:?}");
    assert_eq!(
        forbidden.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        foreign.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        udp.recv(&mut [0; 64]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn managed_execution_proxy_rejects_unauthorized_external_connections() {
    let origin = Origin::start();
    let target = origin.port;
    let policy = NetworkPolicyHandle::new(
        move |request: network_proxy::NetworkRequest, _| async move {
            if request.port() == target {
                NetworkDecision::Allow
            } else {
                NetworkDecision::Deny("blocked".into())
            }
        },
    );
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let proxy_file = dir.canonical_path().join("proxy.txt");
    let release_file = dir.canonical_path().join("release");
    let script = format!(
        "$ErrorActionPreference='Stop'; Set-Content -LiteralPath {} -Value $env:HTTP_PROXY; while (!(Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 20 }}; exit 0",
        literal(&proxy_file),
        literal(&release_file)
    );
    std::thread::scope(|threads| {
        let execution = threads.spawn(|| {
            executor(&dir, Duration::from_secs(20)).execute_scoped_with_network(
                powershell(script),
                CommandExecutionAuthority::Sandboxed(sandbox_policy(
                    FileSystemAccess::DirectoryWrite,
                    NetworkAccess::Managed,
                )),
                &CancellationSource::new().token(),
                None,
                Some(&policy),
            )
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !proxy_file.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            proxy_file.exists(),
            "managed command did not record its proxy endpoint"
        );
        let proxy_url = std::fs::read_to_string(&proxy_file).unwrap();
        let proxy_addr: std::net::SocketAddr = proxy_url
            .trim()
            .strip_prefix("http://")
            .unwrap()
            .parse()
            .unwrap();

        // An unauthorized external connection (e.g. current host test runner process)
        // must be rejected because its token user SID and restricting SIDs do not match
        // the leased sandbox account.
        let mut stream =
            std::net::TcpStream::connect_timeout(&proxy_addr, Duration::from_secs(2)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let _ = stream.write_all(
            format!(
                "GET http://127.0.0.1:{target}/ HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        );
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        assert!(
            response.is_empty(),
            "proxy must not forward unauthorized external traffic: {response:?}"
        );

        std::fs::write(&release_file, "release").unwrap();
        let CommandExecutionOutcome::Completed(output) = execution.join().unwrap().unwrap() else {
            panic!("execution did not complete")
        };
        assert_eq!(output.exit_code, Some(0), "{output:?}");
    });
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn subsequent_executions_cannot_write_files_owned_by_an_earlier_execution() {
    let temp = tempfile::tempdir().unwrap();
    let first_path = temp.path().join("first");
    let second_path = temp.path().join("second");
    std::fs::create_dir(&first_path).unwrap();
    std::fs::create_dir(&second_path).unwrap();
    let first = Dir::open_local(&first_path).unwrap();
    let second = Dir::open_local(&second_path).unwrap();
    let token = CancellationSource::new().token();
    let authority = || {
        CommandExecutionAuthority::Sandboxed(sandbox_policy(
            FileSystemAccess::DirectoryWrite,
            NetworkAccess::Denied,
        ))
    };
    let result = executor(&first, Duration::from_secs(15))
        .execute(
            powershell("$ErrorActionPreference='Stop'; Set-Content owned 'original'".into()),
            authority(),
            &token,
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = result else {
        panic!("{result:?}")
    };
    assert_eq!(output.exit_code, Some(0), "{output:?}");
    // A later execution must not acquire writes through prior file ownership.
    for _ in 0..2 {
        let result = executor(&second, Duration::from_secs(15)).execute(powershell(format!(
            "$ErrorActionPreference='Stop'; try {{ Set-Content {} 'changed' }} catch {{ exit 0 }}; exit 99", literal(&first.canonical_path().join("owned")))), authority(), &token).unwrap();
        let CommandExecutionOutcome::Completed(output) = result else {
            panic!("{result:?}")
        };
        assert_eq!(
            output.exit_code,
            Some(0),
            "old file ownership granted a new write: {output:?}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(first_path.join("owned"))
            .unwrap()
            .trim(),
        "original"
    );
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn ordinary_exit_reaps_background_descendants() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let pid_file = dir.canonical_path().join("child.pid");
    let result = executor(&dir, Duration::from_secs(20)).execute(powershell(format!(
        "$ErrorActionPreference='Stop'; $p=Start-Process -WindowStyle Hidden -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru; [IO.File]::WriteAllText({}, [string]$p.Id); exit 0", literal(&pid_file))),
        CommandExecutionAuthority::Sandboxed(sandbox_policy(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)), &CancellationSource::new().token()).unwrap();
    let CommandExecutionOutcome::Completed(output) = result else {
        panic!("{result:?}")
    };
    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert_process_exited(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
}
