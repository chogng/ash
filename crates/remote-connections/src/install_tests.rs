use std::fs;
use std::fs::File;
use std::num::NonZeroU64;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::process::Stdio;

use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tar::Builder;
use tar::EntryType;
use tar::Header;

use super::RemoteRuntimeArtifact;
use super::RemoteRuntimeArtifactIntegrity;
#[cfg(unix)]
use super::RemoteRuntimeInstallDisposition;
use super::RemoteRuntimeInstallFailureKind;
use super::RemoteRuntimeInstallLocation;
#[cfg(unix)]
use super::RemoteRuntimeInstallProgress;
use super::RemoteRuntimeInstallRoot;
use super::RemoteRuntimeVersion;
#[cfg(unix)]
use super::SshRemoteRuntimeInstaller;
use super::install::parse_remote_platform;
use super::install::remote_platform_probe_command;
use super::install::remote_runtime_install_command;
use ash_remote::RemoteArchitecture;
use ash_remote::RemoteLinuxLibc;
use ash_remote::RemotePlatform;
#[cfg(unix)]
use ash_remote::SshHost;

const VERSION: &str = "0.1.0";
const TARGET: RemotePlatform =
    RemotePlatform::linux(RemoteArchitecture::X86_64, RemoteLinuxLibc::Gnu);

#[test]
fn a_transport_upload_reads_the_exact_verified_archive_from_its_start() {
    use std::io::Read;
    let root = tempfile::tempdir().unwrap();
    let artifact = package_artifact(root.path(), PackageVariant::Canonical);
    let mut file = artifact.open_verified().unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, fs::read(artifact.archive()).unwrap());
    fs::write(artifact.archive(), b"changed after verification").unwrap();
    assert!(artifact.open_verified().is_err());
}

#[test]
fn platform_probe_parses_each_supported_package_target() {
    let probes = [
        ("linux:aarch64:gnu", "aarch64-unknown-linux-gnu"),
        ("linux:aarch64:musl", "aarch64-unknown-linux-musl"),
        ("linux:x86_64:gnu", "x86_64-unknown-linux-gnu"),
        ("linux:x86_64:musl", "x86_64-unknown-linux-musl"),
        ("macos:aarch64:none", "aarch64-apple-darwin"),
        ("macos:x86_64:none", "x86_64-apple-darwin"),
        ("windows:x86_64:msvc", "x86_64-pc-windows-msvc"),
        ("windows:aarch64:msvc", "aarch64-pc-windows-msvc"),
    ];

    for (probe, target) in probes {
        let output = format!("login banner\n__ASH_REMOTE_PLATFORM__:{probe}\n");
        assert_eq!(
            parse_remote_platform(&output).unwrap().target_triple(),
            target
        );
    }
    assert_eq!(
        parse_remote_platform("__ASH_REMOTE_PLATFORM__:windows:x86_64:none\n"),
        None
    );
    assert!(remote_platform_probe_command().contains("GNU_LIBC_VERSION"));
    assert!(remote_platform_probe_command().contains("*musl*"));
}

#[test]
fn artifact_metadata_and_install_roots_reject_path_syntax() {
    assert!(RemoteRuntimeVersion::parse("0.1.0-dev.4+build").is_ok());
    assert!(RemoteRuntimeVersion::parse("../current").is_err());
    assert!(RemoteRuntimeVersion::parse("..").is_err());
    assert!(RemoteRuntimeVersion::parse(".hidden").is_err());
    assert!(RemoteRuntimeVersion::parse("release/latest").is_err());
    assert!(RemoteRuntimeInstallRoot::parse("/srv/ash/remote runtimes").is_ok());
    assert!(RemoteRuntimeInstallRoot::parse("/srv/ash/../runtime").is_err());
    assert!(RemoteRuntimeInstallRoot::parse("relative/runtime").is_err());
    assert!(RemoteRuntimeInstallRoot::parse("/").is_err());
    assert!(
        RemoteRuntimeArtifactIntegrity::new(
            NonZeroU64::new(1).unwrap(),
            NonZeroU64::new(1).unwrap(),
            "A".repeat(64),
        )
        .is_err()
    );
}

#[test]
fn install_command_uses_digest_addressing_without_a_mutable_activation_link() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = package_artifact(directory.path(), PackageVariant::Canonical);
    let location = RemoteRuntimeInstallLocation::Absolute(
        RemoteRuntimeInstallRoot::parse("/srv/ash remote").unwrap(),
    );
    let command = remote_runtime_install_command(&artifact, &location);

    assert!(command.contains("install_root='/srv/ash remote'"));
    assert!(command.contains("runtime_dir=\"$runtime_parent/$digest\""));
    assert!(command.contains("archive-sha256-mismatch"));
    assert!(command.contains("mv \"$package\" \"$runtime_dir\""));
    assert!(!command.contains("/current"));
    assert!(!command.contains("ln -s"));
}

#[cfg(unix)]
#[test]
fn installer_probes_uploads_and_returns_an_exact_immutable_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = package_artifact(directory.path(), PackageVariant::Canonical);
    let captured = directory.path().join("captured.tar.gz");
    let fake_ssh = directory.path().join("fake-ssh");
    let executable = format!(
        "/home/remote/.local/share/ash/remote/runtimes/{}/{}/{}/bin/ash-remote-server",
        artifact.platform().target_triple(),
        artifact.version().as_str(),
        artifact.integrity().sha256()
    );
    fs::write(
        &fake_ssh,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  *__ASH_REMOTE_PLATFORM__*) printf '%s\\n' '__ASH_REMOTE_PLATFORM__:linux:x86_64:gnu' ;;\n  *__ASH_REMOTE_RUNTIME_INSTALLED__*) cat > '{}'; printf '%s\\n' '__ASH_REMOTE_RUNTIME_INSTALLED__:{}:{}' ;;\n  *) exit 90 ;;\nesac\n",
            captured.display(),
            artifact.integrity().sha256(),
            executable,
        ),
    )
    .unwrap();
    make_executable(&fake_ssh);

    let mut progress = Vec::new();
    let installed = SshRemoteRuntimeInstaller::new(SshHost::parse("build-linux").unwrap())
        .with_ssh_executable(fake_ssh)
        .install_with_progress(&artifact, |event| progress.push(event))
        .unwrap();

    assert_eq!(installed.runtime().executable(), executable);
    assert_eq!(installed.version().as_str(), VERSION);
    assert_eq!(installed.platform(), TARGET);
    assert_eq!(
        installed.disposition(),
        RemoteRuntimeInstallDisposition::Installed
    );
    assert_eq!(installed.archive_sha256(), artifact.integrity().sha256());
    assert_eq!(
        fs::read(captured).unwrap(),
        fs::read(artifact.archive()).unwrap()
    );
    assert_eq!(
        progress.first(),
        Some(&RemoteRuntimeInstallProgress::ValidatingArtifact)
    );
    assert_eq!(
        progress.get(1),
        Some(&RemoteRuntimeInstallProgress::ProbingPlatform)
    );
    assert!(matches!(
        progress.get(2),
        Some(RemoteRuntimeInstallProgress::Uploading {
            transferred_bytes: 0,
            ..
        })
    ));
    assert!(progress.iter().any(|event| matches!(
        event,
        RemoteRuntimeInstallProgress::Uploading {
            transferred_bytes,
            total_bytes,
        } if *transferred_bytes == total_bytes.get()
    )));
    assert_eq!(
        progress.get(progress.len() - 2),
        Some(&RemoteRuntimeInstallProgress::FinalizingRemoteInstall)
    );
    assert_eq!(
        progress.last(),
        Some(&RemoteRuntimeInstallProgress::Complete {
            disposition: RemoteRuntimeInstallDisposition::Installed,
        })
    );
}

#[cfg(unix)]
#[test]
fn installer_accepts_an_idempotent_receipt_when_remote_closes_upload_stdin_early() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = package_artifact(directory.path(), PackageVariant::Canonical);
    let fake_ssh = directory.path().join("fake-ssh");
    let executable = format!(
        "/home/remote/.local/share/ash/remote/runtimes/{}/{}/{}/bin/ash-remote-server",
        artifact.platform().target_triple(),
        artifact.version().as_str(),
        artifact.integrity().sha256()
    );
    fs::write(
        &fake_ssh,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  *__ASH_REMOTE_PLATFORM__*) printf '%s\\n' '__ASH_REMOTE_PLATFORM__:linux:x86_64:gnu' ;;\n  *__ASH_REMOTE_RUNTIME_INSTALLED__*) printf '%s\\n' '__ASH_REMOTE_RUNTIME_REUSED__:{}:{}' ;;\nesac\n",
            artifact.integrity().sha256(),
            executable,
        ),
    )
    .unwrap();
    make_executable(&fake_ssh);

    let installed = SshRemoteRuntimeInstaller::new(SshHost::parse("build-linux").unwrap())
        .with_ssh_executable(fake_ssh)
        .install(&artifact)
        .unwrap();

    assert_eq!(installed.runtime().executable(), executable);
    assert_eq!(
        installed.disposition(),
        RemoteRuntimeInstallDisposition::Reused
    );
}

#[cfg(unix)]
#[test]
fn installer_does_not_contact_ssh_when_local_artifact_integrity_fails() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = package_artifact(directory.path(), PackageVariant::Canonical);
    let mut bytes = fs::read(artifact.archive()).unwrap();
    bytes[0] ^= 0xff;
    fs::write(artifact.archive(), bytes).unwrap();
    let marker = directory.path().join("ssh-was-started");
    let fake_ssh = directory.path().join("fake-ssh");
    fs::write(
        &fake_ssh,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    make_executable(&fake_ssh);

    let error = SshRemoteRuntimeInstaller::new(SshHost::parse("build-linux").unwrap())
        .with_ssh_executable(fake_ssh)
        .install(&artifact)
        .unwrap_err();

    assert_eq!(
        error.kind(),
        RemoteRuntimeInstallFailureKind::ArtifactIntegrity
    );
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn installer_rejects_target_mismatch_before_upload() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = package_artifact(directory.path(), PackageVariant::Canonical);
    let captured = directory.path().join("captured.tar.gz");
    let fake_ssh = directory.path().join("fake-ssh");
    fs::write(
        &fake_ssh,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  *__ASH_REMOTE_PLATFORM__*) printf '%s\\n' '__ASH_REMOTE_PLATFORM__:macos:aarch64:none' ;;\n  *) cat > '{}' ;;\nesac\n",
            captured.display()
        ),
    )
    .unwrap();
    make_executable(&fake_ssh);

    let error = SshRemoteRuntimeInstaller::new(SshHost::parse("build-linux").unwrap())
        .with_ssh_executable(fake_ssh)
        .install(&artifact)
        .unwrap_err();

    assert_eq!(
        error.kind(),
        RemoteRuntimeInstallFailureKind::PlatformMismatch
    );
    assert!(!captured.exists());
}

#[test]
fn archive_validation_rejects_host_provided_node_and_link_entries() {
    let directory = tempfile::tempdir().unwrap();
    for (index, variant) in [
        PackageVariant::HostProvidedNode,
        PackageVariant::LinkedEntrypoint,
    ]
    .into_iter()
    .enumerate()
    {
        let root = directory.path().join(index.to_string());
        fs::create_dir(&root).unwrap();
        let artifact = package_artifact(&root, variant);
        let error = super::install::open_and_validate_artifact(&artifact).unwrap_err();
        assert_eq!(
            error.kind(),
            RemoteRuntimeInstallFailureKind::ArtifactIntegrity
        );
    }
}

#[cfg(unix)]
#[test]
fn generated_remote_script_commits_a_package_and_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = package_artifact(directory.path(), PackageVariant::Canonical);
    let install_root = directory.path().join("remote data");
    let location = RemoteRuntimeInstallLocation::Absolute(
        RemoteRuntimeInstallRoot::parse(install_root.to_string_lossy()).unwrap(),
    );
    let command = remote_runtime_install_command(&artifact, &location);

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = File::open(artifact.archive()).unwrap();
    std::io::copy(&mut input, child.stdin.as_mut().unwrap()).unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt = String::from_utf8(output.stdout).unwrap();
    let executable = install_root
        .join("runtimes")
        .join(TARGET.target_triple())
        .join(VERSION)
        .join(artifact.integrity().sha256())
        .join("bin/ash-remote-server");
    let executable_text = executable.to_string_lossy().into_owned();
    assert!(receipt.contains(&executable_text));
    assert_eq!(fs::read(&executable).unwrap(), b"ash");
    let package = executable.parent().unwrap().parent().unwrap();
    let sidecar = package.with_extension("sha256");
    let legacy_receipt = package.join(".ash-remote-runtime-sha256");
    assert!(
        !legacy_receipt.exists(),
        "installation must preserve the package manifest"
    );
    assert_eq!(
        fs::read_to_string(&sidecar).unwrap().trim(),
        artifact.integrity().sha256()
    );
    // Existing installs used an in-package receipt. Reuse must migrate it out
    // before the shared package store validates and activates this runtime.
    fs::rename(&sidecar, &legacy_receipt).unwrap();

    let output = Command::new("sh").arg("-c").arg(command).output().unwrap();
    assert!(output.status.success());
    assert!(sidecar.is_file());
    assert!(!legacy_receipt.exists());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains(&executable_text)
    );
}

#[derive(Clone, Copy)]
enum PackageVariant {
    Canonical,
    HostProvidedNode,
    LinkedEntrypoint,
    MetadataBytes(usize),
    ExtraPath(&'static str),
    #[cfg(windows)]
    LargeBinary,
}

#[test]
fn installer_accepts_full_release_manifests_but_bounds_metadata_memory() {
    for (size, accepted) in [(300 * 1024, true), (1024 * 1024 + 1, false)] {
        let root = tempfile::tempdir().unwrap();
        let artifact = package_artifact(root.path(), PackageVariant::MetadataBytes(size));
        let result = artifact.open_verified();
        assert_eq!(result.is_ok(), accepted, "{size} bytes: {result:?}");
        if !accepted {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("bounded regular file")
            );
        }
    }
}

#[test]
fn windows_archives_require_exe_payloads_and_reject_filesystem_aliases() {
    let root = tempfile::tempdir().unwrap();
    let platform = RemotePlatform::windows(RemoteArchitecture::X86_64);
    let artifact = package_artifact_for_platform(root.path(), PackageVariant::Canonical, platform);
    artifact.open_verified().unwrap();
    let command =
        remote_runtime_install_command(&artifact, &RemoteRuntimeInstallLocation::UserData);
    assert!(
        command.len() < 8000,
        "command must fit Windows cmd.exe: {}",
        command.len()
    );
    assert!(!command.contains(['$', '`', '%']));
    for path in [
        "BIN/ASH-REMOTE-SERVER.EXE",
        "ash-path/NUL.txt",
        "ash-path/file:stream",
        "ash-path/trailing.",
        "ash-path/trailing ",
    ] {
        let artifact =
            package_artifact_for_platform(root.path(), PackageVariant::ExtraPath(path), platform);
        assert!(artifact.open_verified().is_err(), "{path}");
    }
}

#[cfg(windows)]
#[test]
fn powershell_installer_preserves_binary_uploads_and_reuses_immutable_runtime() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::process::Stdio;
    let root = tempfile::tempdir().unwrap();
    let artifact = package_artifact_for_platform(
        root.path(),
        PackageVariant::LargeBinary,
        RemotePlatform::windows(RemoteArchitecture::X86_64),
    );
    // Exceed OpenSSH's input window with incompressible bytes. A tiny fixture or
    // a regular input file hides ConsoleStream's nonblocking-pipe failure.
    assert!(artifact.integrity().archive_size().get() > 8 * 1024 * 1024);
    artifact.open_verified().unwrap();
    // A developer shell can put Git/MSYS tar first on PATH. It treats C: as a
    // remote host; the installer must select the inbox tar instead of this entry.
    let shadow_tar = root.path().join("shadow-tar");
    fs::create_dir(&shadow_tar).unwrap();
    fs::write(shadow_tar.join("tar.exe"), b"not the Windows inbox tar").unwrap();
    let inherited_path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(
        std::iter::once(shadow_tar).chain(std::env::split_paths(&inherited_path)),
    )
    .unwrap();
    let mut shells = vec![
        (
            "cmd.exe",
            std::ffi::OsString::from("cmd.exe"),
            vec!["/d", "/s", "/c"],
        ),
        (
            "powershell.exe",
            std::ffi::OsString::from("powershell.exe"),
            vec!["-NoProfile", "-NonInteractive", "-Command"],
        ),
    ];
    // The release preflight supplies a private loopback client. Ordinary unit
    // runs retain their direct-shell coverage without requiring an SSH service.
    if let Some(ssh) = std::env::var_os("ASH_REMOTE_INSTALLER_TEST_SSH") {
        shells.push(("OpenSSH", ssh, vec!["-T", "ash-release-fixture"]));
    }
    for (shell, executable, args) in shells {
        let install_root = root.path().join(format!("安装 O'Brien $literal% {shell}"));
        let location = RemoteRuntimeInstallLocation::Absolute(
            RemoteRuntimeInstallRoot::parse(install_root.to_str().unwrap()).unwrap(),
        );
        let command = remote_runtime_install_command(&artifact, &location);
        for expected in [
            "__ASH_REMOTE_RUNTIME_INSTALLED__:",
            "__ASH_REMOTE_RUNTIME_REUSED__:",
        ] {
            let mut process = Command::new(&executable);
            process.args(&args);
            process.env("PATH", &path);
            if shell == "cmd.exe" {
                // OpenSSH supplies shell syntax after /c. Rust's normal CRT quoting
                // would turn the nested PowerShell command into a string expression.
                process.raw_arg(&command);
            } else {
                process.arg(&command);
            }
            let mut child = process
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut input = File::open(artifact.archive()).unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let upload = std::thread::spawn(move || std::io::copy(&mut input, &mut stdin));
            let output = child.wait_with_output().unwrap();
            let uploaded = upload.join().unwrap();
            assert!(
                output.status.success(),
                "{shell} {expected}\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if expected == "__ASH_REMOTE_RUNTIME_INSTALLED__:" {
                assert_eq!(uploaded.unwrap(), artifact.integrity().archive_size().get());
            }
            let receipt = String::from_utf8(output.stdout).unwrap();
            assert!(receipt.contains(expected), "{receipt}");
            let installed = super::install::parse_install_receipt(&receipt, &artifact)
                .unwrap()
                .unwrap();
            assert!(Path::new(installed.runtime().executable()).starts_with(&install_root));
            assert_eq!(fs::read(installed.runtime().executable()).unwrap(), b"ash");
            let package = Path::new(installed.runtime().executable())
                .parent()
                .unwrap()
                .parent()
                .unwrap();
            assert_eq!(
                fs::read(package.join("ash-resources/binary.dat")).unwrap(),
                binary_fixture()
            );
            let sidecar = package.with_extension("sha256");
            let legacy_receipt = package.join(".ash-remote-runtime-sha256");
            assert!(!legacy_receipt.exists());
            assert_eq!(
                fs::read_to_string(&sidecar).unwrap().trim(),
                artifact.integrity().sha256()
            );
            if expected == "__ASH_REMOTE_RUNTIME_INSTALLED__:" {
                fs::rename(sidecar, legacy_receipt).unwrap();
            }
        }
    }
}

#[cfg(windows)]
fn binary_fixture() -> Vec<u8> {
    (0u32..262_144)
        .flat_map(|counter| Sha256::digest(counter.to_le_bytes()))
        .collect()
}

fn package_artifact(root: &Path, variant: PackageVariant) -> RemoteRuntimeArtifact {
    package_artifact_for_platform(root, variant, TARGET)
}

fn package_artifact_for_platform(
    root: &Path,
    variant: PackageVariant,
    platform: RemotePlatform,
) -> RemoteRuntimeArtifact {
    let suffix = platform.executable_suffix();
    let archive_path = root.join("ash-package.tar.gz");
    let archive_file = File::create(&archive_path).unwrap();
    let encoder = GzEncoder::new(archive_file, Compression::default());
    let mut builder = Builder::new(encoder);
    let mut directory = Header::new_gnu();
    directory.set_entry_type(EntryType::Directory);
    directory.set_size(0);
    directory.set_mode(0o755);
    directory.set_cksum();
    builder
        .append_data(&mut directory, "bin/", std::io::empty())
        .unwrap();
    let javascript_runtime = match variant {
        PackageVariant::HostProvidedNode => "hostProvidedNode",
        _ => "packagedNode",
    };
    let mut metadata = json!({
        "layoutVersion": 2,
        "version": VERSION,
        "target": platform.target_triple(),
        "entrypoint": format!("bin/ash-app-server{suffix}"),
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": { "kind": javascript_runtime },
        "components": {},
    });
    if let PackageVariant::MetadataBytes(size) = variant {
        metadata["fixtureFileManifest"] = Value::String("x".repeat(size));
    }
    let metadata = serde_json::to_vec_pretty(&metadata).unwrap();
    let mut unpacked_size = append_file(&mut builder, "ash-package.json", &metadata, 0o644);
    match variant {
        PackageVariant::LinkedEntrypoint => {
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_link_name("../outside/ash").unwrap();
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    &format!("bin/ash-remote-server{suffix}"),
                    std::io::empty(),
                )
                .unwrap();
        }
        _ => {
            unpacked_size += append_file(
                &mut builder,
                &format!("bin/ash-remote-server{suffix}"),
                b"ash",
                0o755,
            )
        }
    }
    unpacked_size += append_file(
        &mut builder,
        &format!("bin/ash-app-server-daemon{suffix}"),
        b"daemon",
        0o755,
    );
    unpacked_size += append_file(
        &mut builder,
        &format!("bin/ash-app-server{suffix}"),
        b"daemon",
        0o755,
    );
    unpacked_size += append_file(
        &mut builder,
        &format!("ash-path/rg{suffix}"),
        b"ripgrep",
        0o755,
    );
    unpacked_size += append_file(
        &mut builder,
        &format!("ash-resources/tgrep/tgrep{suffix}"),
        b"tgrep",
        0o755,
    );
    if !matches!(variant, PackageVariant::HostProvidedNode) {
        unpacked_size += append_file(
            &mut builder,
            &format!("ash-resources/node/bin/node{suffix}"),
            b"node",
            0o755,
        );
    }
    if let PackageVariant::ExtraPath(path) = variant {
        unpacked_size += append_file(&mut builder, path, b"unexpected", 0o644);
    }
    #[cfg(windows)]
    if let PackageVariant::LargeBinary = variant {
        unpacked_size += append_file(
            &mut builder,
            "ash-resources/binary.dat",
            &binary_fixture(),
            0o644,
        );
    }
    let encoder = builder.into_inner().unwrap();
    encoder.finish().unwrap();

    let bytes = fs::read(&archive_path).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    RemoteRuntimeArtifact::new(
        archive_path,
        RemoteRuntimeVersion::parse(VERSION).unwrap(),
        platform,
        RemoteRuntimeArtifactIntegrity::new(
            NonZeroU64::new(bytes.len() as u64).unwrap(),
            NonZeroU64::new(unpacked_size).unwrap(),
            digest,
        )
        .unwrap(),
    )
}

fn append_file(builder: &mut Builder<GzEncoder<File>>, path: &str, bytes: &[u8], mode: u32) -> u64 {
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_size(bytes.len() as u64);
    header.set_mode(mode);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes).unwrap();
    bytes.len() as u64
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}
