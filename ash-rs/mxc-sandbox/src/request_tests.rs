use super::Request;
use ash_file_access::Dir;
use ash_sandboxing::{
    FileSystemAccess, HostReadScope, NetworkAccess, SandboxCommand, SandboxPolicy, SandboxScope,
};

fn request(dir: &Dir) -> Request {
    crate::policy::request(
        &SandboxCommand::new(
            "program with spaces",
            ["a b", "", "quote\"", "尾部\\"],
            dir.canonical_path(),
        ),
        SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
        &SandboxScope::single(dir.clone()).with_host_read(HostReadScope::Minimal),
    )
    .unwrap()
}

#[test]
fn terminal_handoff_preserves_explicit_environment_and_filesystem_identity() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let dir = Dir::open_local(&work).unwrap();
    let mut prepared = request(&dir);
    prepared.set_env(&[("ASH_TEST".into(), "a=b 中文".into())]);
    let encoded = serde_json::to_string(&prepared).unwrap();
    drop(dir);
    let decoded: Request = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded.inner.env, Some(vec!["ASH_TEST=a=b 中文".into()]));
    assert!(!decoded.inner.inherit_default_env);
    assert!(decoded.inner.lifecycle.destroy_on_exit);
    assert!(!decoded.inner.lifecycle.preserve_policy);
    assert_eq!(decoded.inner.script_code, prepared.inner.script_code);
    assert_eq!(
        decoded.inner.policy.readwrite_paths,
        prepared.inner.policy.readwrite_paths
    );
    decoded.snapshot.validate().unwrap();
    std::fs::rename(&work, temp.path().join("old-work")).unwrap();
    std::fs::create_dir(&work).unwrap();
    assert!(decoded.snapshot.validate().is_err());
    assert!(decoded.prepare().is_err());
}

#[test]
fn explicit_empty_environment_stays_empty_after_terminal_handoff() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut prepared = request(&dir);
    prepared.set_env(&[]);
    let decoded: Request =
        serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
    assert_eq!(decoded.inner.env, Some(Vec::new()));
    assert!(!decoded.inner.inherit_default_env);
}

#[cfg(windows)]
#[test]
#[ignore = "diagnoses startup on a PSEC host"]
fn psec_startup_diagnostics() {
    use std::io::Read;
    use std::time::Duration;
    use wxc_common::sandbox_process::SandboxBackend;

    for variant in ["cmd", "powershell", "hidden", "profile", "capture"] {
        let temp = tempfile::tempdir().unwrap();
        let work = temp.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let dir = Dir::open_local(&work).unwrap();
        let profile = tempfile::tempdir().unwrap();
        let scope = if variant == "hidden" {
            SandboxScope::new(
                dir.clone(),
                vec![ash_sandboxing::SandboxDirGrant::new(
                    dir.clone(),
                    ash_sandboxing::SandboxDirAccess::ReadWrite,
                )],
                vec![Dir::open_local(temp.path()).unwrap()],
            )
            .unwrap()
        } else {
            SandboxScope::single(dir.clone())
        };
        let scope = if variant == "profile" {
            scope
                .with_private_ipc_dir(Dir::open_local(profile.path()).unwrap())
                .unwrap()
        } else {
            scope
        };
        let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let command = if variant == "cmd" {
            SandboxCommand::new(
                system.join("System32/cmd.exe"),
                [
                    "/d",
                    "/c",
                    "echo engine-ready & cd & echo yes>started & echo file-written & exit /b 125",
                ],
                dir.canonical_path(),
            )
        } else {
            SandboxCommand::new(
                system.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    format!(
                        "'engine-ready'; 'process=' + [Environment]::CurrentDirectory; 'location=' + $PWD.Path; try {{ [IO.File]::WriteAllText('{}', 'yes'); 'file-written' }} catch {{ 'write-error=' + $_ }}; 'pipeline-ready' | ForEach-Object {{ Write-Output $_ }}; exit 125",
                        dir.canonical_path()
                            .join("started")
                            .display()
                            .to_string()
                            .replace('\'', "''")
                    ),
                ],
                dir.canonical_path(),
            )
        };
        let mut request = crate::policy::request(
            &command,
            SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
            &scope,
        )
        .unwrap();
        let mut env = [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "TERM",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TMPDIR",
            "TMP",
            "TEMP",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "COMSPEC",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "JAVA_HOME",
            "GOPATH",
        ]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
        .collect::<Vec<_>>();
        if variant == "profile" {
            for key in [
                "TEMP",
                "TMP",
                "HOME",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
            ] {
                env.retain(|(name, _)| name != key);
                env.push((key.into(), profile.path().display().to_string()));
            }
        }
        request.set_env(&env);
        request.restore_runtime_policy();
        if variant == "capture" {
            let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.build/acceptance/psec-diagnostics");
            std::fs::create_dir_all(&output).unwrap();
            request.inner.policy.capture_denials = Some(wxc_common::models::CaptureDenialsConfig {
                output_path: Some(output.join("denials.json").display().to_string()),
                ..Default::default()
            });
        }
        let mut runner = appcontainer_common::base_container_runner::BaseContainerRunner::new();
        let mut logger = wxc_common::logger::Logger::new(wxc_common::logger::Mode::Buffer);
        let result = runner.spawn(
            &request.inner,
            &mut logger,
            wxc_common::sandbox_process::StdioMode::Pipes,
        );
        eprintln!("VARIANT={variant}\n{}", logger.get_buffer());
        let mut child = match result {
            Ok(child) => child,
            Err(error) => {
                eprintln!("SPAWN FAILED: {error:?}");
                continue;
            }
        };
        eprintln!("PID={}", child.id());
        drop(child.take_stdin());
        let readers =
            [child.take_stdout().unwrap(), child.take_stderr().unwrap()].map(|mut stream| {
                std::thread::spawn(move || {
                    let mut output = Vec::new();
                    let result = stream.read_to_end(&mut output);
                    (output, result)
                })
            });
        let start = std::time::Instant::now();
        let status = loop {
            let status = child.try_wait().unwrap();
            if status.is_some() || start.elapsed() > Duration::from_secs(30) {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        child.kill().unwrap();
        let waited = child.wait();
        eprintln!(
            "RESULT={variant} status={status:?} waited={waited:?} elapsed={:?} file={} metadata={:?} warnings={:?}",
            start.elapsed(),
            work.join("started").exists(),
            child.output_metadata(),
            child.warnings()
        );
        for (name, reader) in ["stdout", "stderr"].into_iter().zip(readers) {
            let (bytes, result) = reader.join().unwrap();
            eprintln!(
                "{name}: result={result:?}\n{}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn terminal_handoff_keeps_managed_proxy_and_network_restrictions() {
    use ash_sandboxing::ManagedNetworkAccess;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let command =
        SandboxCommand::new("/bin/sh", ["-c", "exit 0"], dir.canonical_path()).with_network_proxy(
            ManagedNetworkAccess::new(3128.try_into().unwrap(), 3128.try_into().unwrap()),
        );
    let prepared = crate::policy::request(
        &command,
        SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed),
        &SandboxScope::single(dir).with_host_read(HostReadScope::Minimal),
    )
    .unwrap();
    let mut decoded: Request =
        serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
    decoded.restore_runtime_policy();
    assert_eq!(
        decoded.inner.policy.network_proxy.address.unwrap().to_url(),
        "http://127.0.0.1:3128"
    );
    assert!(decoded.inner.policy.runtime_network_proxy_specified);
    assert!(decoded.inner.policy.network_mode_specified);
    assert!(matches!(
        decoded.inner.policy.default_network_policy,
        wxc_common::models::NetworkPolicy::Block
    ));
    assert!(!decoded.inner.policy.allow_local_network);
}
