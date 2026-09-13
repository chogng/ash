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
fn platform_probe_parses_each_supported_package_target() {
    let probes = [
        ("linux:aarch64:gnu", "aarch64-unknown-linux-gnu"),
        ("linux:aarch64:musl", "aarch64-unknown-linux-musl"),
        ("linux:x86_64:gnu", "x86_64-unknown-linux-gnu"),
        ("linux:x86_64:musl", "x86_64-unknown-linux-musl"),
        ("macos:aarch64:none", "aarch64-apple-darwin"),
        ("macos:x86_64:none", "x86_64-apple-darwin"),
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

    let output = Command::new("sh").arg("-c").arg(command).output().unwrap();
    assert!(output.status.success());
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
}

fn package_artifact(root: &Path, variant: PackageVariant) -> RemoteRuntimeArtifact {
    let archive_path = root.join("ash-package.tar.gz");
    let archive_file = File::create(&archive_path).unwrap();
    let encoder = GzEncoder::new(archive_file, Compression::default());
    let mut builder = Builder::new(encoder);
    let javascript_runtime = match variant {
        PackageVariant::HostProvidedNode => "hostProvidedNode",
        _ => "packagedNode",
    };
    let metadata = serde_json::to_vec_pretty(&json!({
        "layoutVersion": 2,
        "version": VERSION,
        "target": TARGET.target_triple(),
        "entrypoint": "bin/ash-app-server",
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": { "kind": javascript_runtime },
        "components": {},
    }))
    .unwrap();
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
                .append_data(&mut header, "bin/ash-remote-server", std::io::empty())
                .unwrap();
        }
        _ => unpacked_size += append_file(&mut builder, "bin/ash-remote-server", b"ash", 0o755),
    }
    unpacked_size += append_file(&mut builder, "bin/ash-app-server-daemon", b"daemon", 0o755);
    unpacked_size += append_file(&mut builder, "bin/ash-app-server", b"daemon", 0o755);
    unpacked_size += append_file(&mut builder, "ash-path/rg", b"ripgrep", 0o755);
    if !matches!(variant, PackageVariant::HostProvidedNode) {
        unpacked_size += append_file(&mut builder, "ash-resources/node/bin/node", b"node", 0o755);
    }
    let encoder = builder.into_inner().unwrap();
    encoder.finish().unwrap();

    let bytes = fs::read(&archive_path).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    RemoteRuntimeArtifact::new(
        archive_path,
        RemoteRuntimeVersion::parse(VERSION).unwrap(),
        TARGET,
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
