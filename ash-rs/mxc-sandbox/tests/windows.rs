//! Windows acceptance uses the executor → adapter → MXC SDK → ProcessContainer chain.
#![cfg(windows)]

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_install_context::InstallContext;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
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
use mxc_sandbox::MxcSandbox;
use network_proxy::NetworkDecision;
use network_proxy::NetworkPolicyHandle;
use std::path::Path;
use std::time::Duration;

struct Approved;
impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

fn executor(dir: &Dir, timeout: Duration) -> CommandExecutor<Approved, MxcSandbox> {
    let backend = MxcSandbox::new(InstallContext::current());
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
    SandboxPolicy::new(files, network).with_host_acl_changes(ash_sandboxing::HostAclChanges::Scoped)
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
#[ignore = "requires a host without PSEC support"]
fn missing_psec_is_reported_before_execution() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let command = SandboxCommand::new(
        "must-not-start",
        std::iter::empty::<&str>(),
        dir.canonical_path(),
    );
    let error = MxcSandbox::new(InstallContext::current())
        .prepare(
            &command,
            sandbox_policy(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
            &dir,
        )
        .unwrap_err();
    assert!(
        matches!(error, ash_sandboxing::SandboxError::UnsupportedPolicy(_)),
        "only confirmed unsupported capability permits another backend: {error}"
    );
}

#[test]
#[ignore = "requires a host capable of preparing Ash's PSEC policy"]
fn psec_host_supports_scoped_policy() {
    let temp = tempfile::tempdir().unwrap();
    let work_path = temp.path().join("work");
    std::fs::create_dir(&work_path).unwrap();
    std::fs::create_dir(work_path.join(".git")).unwrap();
    std::fs::write(temp.path().join("secret"), "hidden").unwrap();
    let work = Dir::open_local(&work_path).unwrap();
    let scope = SandboxScope::new(
        work.clone(),
        vec![SandboxDirGrant::new(
            work.clone(),
            SandboxDirAccess::ReadWrite,
        )],
        vec![Dir::open_local(temp.path()).unwrap()],
    )
    .unwrap();
    let backend = MxcSandbox::new(InstallContext::current());
    let command = SandboxCommand::new(
        "must-not-start",
        std::iter::empty::<&str>(),
        work.canonical_path(),
    );
    // Preparation creates and closes the actual PSEC environment and startup
    // attributes. It does not launch a command or select another backend.
    backend
        .prepare_scoped(
            &command,
            sandbox_policy(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
            &scope,
        )
        .unwrap_or_else(|error| panic!("PSEC policy preparation failed: {error}"));
}

#[test]
#[ignore = "requires PSEC support for the complete filesystem and process policy"]
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
    // Windows PowerShell resolves its provider location through ancestors, which
    // this policy intentionally hides. Check the process cwd independently and
    // address each grant directly when testing filesystem permissions.
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         if ([Environment]::CurrentDirectory -ne {cwd}) {{ exit 12 }}; \
         Set-Content -LiteralPath {output} 'ok'; \
         if ((Get-Content -LiteralPath {input}) -ne 'reference') {{ exit 10 }}; \
         function MustDeny([scriptblock]$action) {{ try {{ & $action }} catch {{ return }}; throw 'restriction was not enforced' }}; \
         MustDeny {{ Get-Content -LiteralPath {secret} }}; MustDeny {{ Set-Content -LiteralPath {reference_write} 'bad' }}; \
         MustDeny {{ Set-Content -LiteralPath {metadata_write} 'bad' }}; \
         if ((Get-Content -LiteralPath {config}) -ne 'metadata') {{ exit 11 }}; \
         MustDeny {{ Set-Content -LiteralPath {config} 'bad' }}; Write-Output 'scoped-ok'; exit 125",
        cwd = literal(work.canonical_path()),
        output = literal(&work.canonical_path().join("output")),
        input = literal(&reference.canonical_path().join("input")),
        secret = literal(&secret),
        reference_write = literal(&reference.canonical_path().join("modified")),
        metadata_write = literal(&work.canonical_path().join(".git/modified")),
        config = literal(&work.canonical_path().join(".git/config")),
    );
    let result = executor(&work, Duration::from_secs(30)).execute_scoped_with_network(
        powershell(script),
        CommandExecutionAuthority::Sandboxed(sandbox_policy(
            FileSystemAccess::DirectoryWrite,
            NetworkAccess::Denied,
        )),
        &CancellationSource::new().token(),
        Some(&scope),
        None,
    );
    assert_eq!(
        protected.map(sddl),
        before,
        "host ACLs changed after execution"
    );
    let result = result.unwrap_or_else(|error| {
        panic!(
            "{error:?}; command reached first write: {}",
            work.canonical_path().join("output").exists()
        )
    });
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
#[ignore = "requires PSEC execution with redirected standard streams"]
fn psec_cmd_preserves_output_and_exit_code() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let program = Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe");
    let result = executor(&dir, Duration::from_secs(15))
        .execute(
            CommandRequest {
                program: program.to_str().unwrap().into(),
                arguments: vec![
                    "/d".into(),
                    "/c".into(),
                    "echo psec-cmd-ok & exit /b 125".into(),
                ],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
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
    assert_eq!(output.exit_code, Some(125), "{output:?}");
    assert!(output.stdout.contains("psec-cmd-ok"), "{output:?}");
}

#[test]
#[ignore = "requires PSEC execution of Windows PowerShell"]
fn psec_powershell_preserves_output_and_exit_code() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let result = executor(&dir, Duration::from_secs(30))
        .execute(
            powershell("Write-Output 'psec-powershell-ok'; exit 125".into()),
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
    assert_eq!(output.exit_code, Some(125), "{output:?}");
    assert!(output.stdout.contains("psec-powershell-ok"), "{output:?}");
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
#[ignore = "requires PSEC support for the complete filesystem and process policy"]
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

#[test]
fn managed_execution_with_a_policy_is_rejected_before_start() {
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = std::sync::Arc::clone(&calls);
    let policy = NetworkPolicyHandle::new(move |_, _| {
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async { NetworkDecision::Allow }
    });
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let result = executor(&dir, Duration::from_secs(5))
        .execute_scoped_with_network(
            powershell("Set-Content started 'must not run'".into()),
            CommandExecutionAuthority::Sandboxed(sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Managed,
            )),
            &CancellationSource::new().token(),
            None,
            Some(&policy),
        )
        .unwrap_err();
    let ExecutionError::Sandbox(error) = result else {
        panic!("{result:?}");
    };
    assert!(
        error.to_string().contains("inbound private-network"),
        "{error:?}"
    );
    assert!(!dir.canonical_path().join("started").exists());
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
#[ignore = "requires PSEC support for the complete policy"]
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
#[ignore = "requires PSEC support for the complete policy"]
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
