//! Real managed CLI install/uninstall boundaries, with all storage in a fixture.
use std::collections::BTreeMap;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use sha2::Digest;
use sha2::Sha256;

#[test]
fn install_keep_reinstall_purge_and_active_client_retry() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path();
    let install = directory.join("安装 with spaces");
    let launchers = directory.join("bin");
    let profile = directory.join("profile");
    let registry = directory.join("registry");
    let source = directory.join("source");
    let cli = cargo_bin::cargo_bin!("ash").unwrap();
    let daemon = cli.with_file_name(format!(
        "ash-app-server-daemon{}",
        std::env::consts::EXE_SUFFIX
    ));
    assert!(
        daemon.is_file(),
        "build the matching ash-app-server-daemon before this process test"
    );
    package(
        &source,
        &[(&cli, "ash"), (&daemon, "ash-app-server-daemon")],
    );
    let command = |binary: &Path| {
        let mut command = Command::new(binary);
        command
            .env("ASH_HOME", &profile)
            .env("ASH_INSTALLATION_REGISTRY", &registry)
            .env("TEMP", directory)
            .env("TMP", directory)
            .env("TMPDIR", directory)
            .env("LC_ALL", "zh_CN.UTF-8");
        command
    };
    for purge in [false, true] {
        let installed = command(&cli)
            .args(["install-managed", "--package"])
            .arg(&source)
            .arg("--install-root")
            .arg(&install)
            .arg("--bin-dir")
            .arg(&launchers)
            .output()
            .unwrap();
        assert!(
            installed.status.success(),
            "{}",
            String::from_utf8_lossy(&installed.stderr)
        );
        fs::create_dir_all(profile.join("cache")).unwrap();
        fs::write(profile.join("cache/download"), "cache").unwrap();
        fs::write(profile.join("settings.json"), "settings").unwrap();
        fs::create_dir_all(profile.join("worktrees/project/.git")).unwrap();
        fs::write(profile.join("worktrees/project/dirty.txt"), "uncommitted").unwrap();
        #[cfg(windows)]
        let selected = install
            .join("versions")
            .join(fs::read_to_string(install.join("current")).unwrap());
        #[cfg(unix)]
        let selected = fs::canonicalize(install.join("current")).unwrap();
        let executable = selected
            .join("bin")
            .join(format!("ash{}", std::env::consts::EXE_SUFFIX));
        let help = command(&executable)
            .args(["uninstall", "--help"])
            .output()
            .unwrap();
        assert!(help.status.success());
        assert!(String::from_utf8_lossy(&help.stdout).contains("工作树"));
        if purge {
            let mut active = command(&daemon)
                .args(["installation", "lease", "--product", "cli", "--root"])
                .arg(&install)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut ready = String::new();
            BufReader::new(active.stdout.take().unwrap())
                .read_line(&mut ready)
                .unwrap();
            assert_eq!(ready, "ready\n");
            assert!(
                command(&executable)
                    .args(["uninstall", "--purge"])
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
            let result = wait_report(&registry);
            assert_eq!(result["status"], "failed", "{result}");
            assert!(profile.join("cache/download").exists());
            assert!(executable.exists());
            drop(active.stdin.take());
            assert!(active.wait().unwrap().success());
        }
        let mut removal = command(&executable);
        removal.arg("uninstall");
        if purge {
            removal.arg("--purge");
        }
        let output = removal.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = wait_report(&registry);
        assert_eq!(result["status"], "complete", "{result}");
        assert!(!install.exists(), "owned installation remains: {result}");
        assert_eq!(profile.join("settings.json").exists(), !purge);
        assert!(!profile.join("cache").exists());
        assert_eq!(
            fs::read_to_string(profile.join("worktrees/project/dirty.txt")).unwrap(),
            "uncommitted"
        );
        assert!(
            !launchers
                .join(if cfg!(windows) { "ash.cmd" } else { "ash" })
                .exists()
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        while fs::read_dir(directory).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("ash-uninstall-")
        }) {
            assert!(
                Instant::now() < deadline,
                "uninstall helper was not reclaimed"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn wait_report(registry: &Path) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if let Some(path) = fs::read_dir(registry)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with("removal-"))
            .map(|entry| entry.path())
        {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            if value["status"] != "pending" {
                return value;
            }
        }
        assert!(Instant::now() < deadline, "uninstall did not complete");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn package(root: &Path, binaries: &[(&Path, &str)]) {
    fs::create_dir_all(root.join("bin")).unwrap();
    let mut files = BTreeMap::new();
    for (source, name) in binaries {
        let name = format!("bin/{name}{}", std::env::consts::EXE_SUFFIX);
        cargo_bin::copy_executable(source, &root.join(&name)).unwrap();
        files.insert(
            name,
            format!("{:x}", Sha256::digest(fs::read(source).unwrap())),
        );
    }
    let mut metadata = serde_json::json!({
        "layoutVersion":2,"version":env!("CARGO_PKG_VERSION"),"target":build_info::TARGET,
        "buildProfile":"release","javascriptRuntime":{"kind":"packagedNode"},
        "protocol":{"major":1,"schemaHash":format!("sha256:{}", "0".repeat(64))},
        "components":{"cli":{"binarySha256":files[&format!("bin/ash{}", std::env::consts::EXE_SUFFIX)],"updatePublicKey":"01".repeat(32)}}
    });
    metadata.sort_all_objects();
    let mut digest = Sha256::new();
    digest.update(b"ash-package-build-v2\0");
    digest.update(serde_json::to_vec(&metadata).unwrap());
    digest.update(b"\0");
    for (path, hash) in &files {
        digest.update(path);
        digest.update(b"\0");
        digest.update(hash);
        digest.update(b"\0");
    }
    metadata["buildId"] = format!("sha256:{:x}", digest.finalize()).into();
    metadata["files"] = serde_json::to_value(files).unwrap();
    fs::write(
        root.join("ash-package.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
}
