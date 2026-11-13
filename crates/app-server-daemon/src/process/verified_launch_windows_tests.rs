use super::*;

fn pipe_file(reader: &io::PipeReader) -> File {
    File::from(reader.as_handle().try_clone_to_owned().unwrap())
}

#[test]
fn a_verified_image_denies_writes_rename_and_delete_until_release() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("backend.exe");
    let moved = directory.path().join("moved.exe");
    std::fs::write(&path, b"original").unwrap();
    let file = open_locked(&path).unwrap();
    let verified = VerifiedExecutable {
        stamp: FileStamp::read(&file).unwrap(),
        file,
    };
    verified.check(&path).unwrap();
    assert!(OpenOptions::new().write(true).open(&path).is_err());
    assert!(std::fs::rename(&path, &moved).is_err());
    assert!(std::fs::remove_file(&path).is_err());
    drop(verified);
    std::fs::write(&path, b"modified").unwrap();
    std::fs::rename(&path, &moved).unwrap();
}

#[test]
fn a_replaced_file_cannot_reuse_the_hashed_file_id() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("backend.exe");
    let replacement = directory.path().join("replacement.exe");
    std::fs::write(&path, b"original").unwrap();
    std::fs::write(&replacement, b"modified").unwrap();
    let file = File::open(&path).unwrap();
    let stamp = FileStamp::read(&file).unwrap();
    std::fs::rename(replacement, &path).unwrap();
    assert!(stamp.check(&file, &path).is_err());
}

#[test]
fn restoring_last_write_time_does_not_restore_the_change_stamp() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("backend.exe");
    std::fs::write(&path, b"original").unwrap();
    let file = File::open(&path).unwrap();
    let stamp = FileStamp::read(&file).unwrap();
    let modified = file.metadata().unwrap().modified().unwrap();
    std::fs::write(&path, b"modified").unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let current = FileStamp::read(&file).unwrap();
    assert_eq!(current.modified, stamp.modified);
    assert_ne!(current.changed, stamp.changed);
    assert!(stamp.check(&file, &path).is_err());
}

#[test]
fn launch_pipe_identifies_its_creator() {
    let (reader, _writer) = io::pipe().unwrap();
    let mut peer = 0;
    // The reader owns its valid pipe handle; peer is a writable u32 output.
    assert_ne!(
        unsafe { GetNamedPipeServerProcessId(reader.as_raw_handle(), &mut peer) },
        0
    );
    assert_eq!(peer, std::process::id());
}

#[test]
fn direct_parent_query_agrees_with_the_kernel_process_snapshot() {
    let direct = parent_pid_native().expect("Windows supports ProcessBasicInformation");
    assert_eq!(Some(direct), parent_pid_snapshot());
}

#[test]
fn proof_input_is_bounded_and_rejects_a_closed_partial_write() {
    let (reader, mut writer) = io::pipe().unwrap();
    writer.write_all(&[b'x'; MAX_PROOF_BYTES + 1]).unwrap();
    assert!(
        read_proof(&mut pipe_file(&reader))
            .unwrap_err()
            .contains("size limit")
    );
    drop(writer);

    let (reader, mut writer) = io::pipe().unwrap();
    writer.write_all(b"{").unwrap();
    drop(writer);
    assert!(
        read_proof(&mut pipe_file(&reader))
            .unwrap_err()
            .contains("incomplete")
    );
}

#[test]
fn a_writer_without_a_complete_proof_has_a_deadline() {
    let (reader, _writer) = io::pipe().unwrap();
    let start = Instant::now();
    assert!(
        read_proof(&mut pipe_file(&reader))
            .unwrap_err()
            .contains("timed out")
    );
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn an_unknown_parent_cannot_supply_a_digest() {
    let (reader, mut writer) = io::pipe().unwrap();
    let mut child = probe_command(&std::env::current_exe().unwrap(), "receive")
        .stdin(Stdio::from(reader))
        .spawn()
        .unwrap();
    writer.write_all(b"forged digest\n").unwrap();
    drop(writer);
    assert!(child.wait().unwrap().success());
}

#[test]
fn a_carrier_filename_with_the_wrong_bytes_is_not_authenticated() {
    let directory = tempfile::tempdir().unwrap();
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let executable = std::env::current_exe().unwrap();
    for name in ["ash-app-server-daemon.exe", "ash-app-server.exe"] {
        std::fs::copy(&executable, bin.join(name)).unwrap();
    }
    std::fs::write(
        directory.path().join("ash-package.json"),
        serde_json::to_vec(&serde_json::json!({
            "buildId": format!("sha256:{}", "0".repeat(64)),
            "files": { "bin/ash-app-server-daemon.exe": "0".repeat(64) }
        }))
        .unwrap(),
    )
    .unwrap();
    let status = probe_command(&bin.join("ash-app-server-daemon.exe"), "carrier")
        .status()
        .unwrap();
    assert!(status.success());
}

fn probe_command(executable: &Path, mode: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .args([
            "--ignored",
            "--exact",
            "process::verified_launch::tests::proof_probe_child",
            "--nocapture",
        ])
        .env("ASH_VERIFIED_LAUNCH_TEST_CHILD", mode);
    command
}

fn trusted_fixture() -> tempfile::TempDir {
    use sha2::Digest;
    let directory = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap();
    let digest = format!(
        "{:x}",
        sha2::Sha256::digest(std::fs::read(&executable).unwrap())
    );
    for package in ["desktop", "selected"] {
        let root = directory.path().join(package);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        if package == "selected" {
            std::fs::write(root.join(".lease"), []).unwrap();
        }
        let name = if package == "desktop" {
            "ash-app-server-daemon.exe"
        } else {
            "ash-app-server.exe"
        };
        std::fs::copy(&executable, root.join("bin").join(name)).unwrap();
        std::fs::write(
            root.join("ash-package.json"),
            serde_json::to_vec(&serde_json::json!({
                "buildId": format!("sha256:{}", "1".repeat(64)),
                "files": { "bin/ash-app-server-daemon.exe": digest }
            }))
            .unwrap(),
        )
        .unwrap();
    }
    directory
}

#[test]
fn a_verified_desktop_carrier_can_prove_a_separately_installed_image() {
    let directory = trusted_fixture();
    let status = probe_command(
        &directory
            .path()
            .join("desktop/bin/ash-app-server-daemon.exe"),
        "valid-carrier",
    )
    .env(
        "ASH_VERIFIED_LAUNCH_TEST_BACKEND",
        directory.path().join("selected/bin/ash-app-server.exe"),
    )
    .status()
    .unwrap();
    assert!(status.success());
}

#[test]
fn an_unleased_image_must_keep_its_full_identity_check() {
    let directory = trusted_fixture();
    std::fs::remove_file(directory.path().join("selected/.lease")).unwrap();
    let status = probe_command(
        &directory
            .path()
            .join("desktop/bin/ash-app-server-daemon.exe"),
        "unleased-carrier",
    )
    .env(
        "ASH_VERIFIED_LAUNCH_TEST_BACKEND",
        directory.path().join("selected/bin/ash-app-server.exe"),
    )
    .status()
    .unwrap();
    assert!(status.success());
}

#[test]
fn an_authenticated_carrier_cannot_substitute_a_different_file_stamp() {
    let directory = trusted_fixture();
    let status = probe_command(
        &directory
            .path()
            .join("desktop/bin/ash-app-server-daemon.exe"),
        "invalid-stamp",
    )
    .env(
        "ASH_VERIFIED_LAUNCH_TEST_BACKEND",
        directory.path().join("selected/bin/ash-app-server.exe"),
    )
    .status()
    .unwrap();
    assert!(status.success());
}

#[test]
fn a_pipe_created_by_the_grandparent_cannot_authenticate_the_parent() {
    let directory = trusted_fixture();
    let backend = directory.path().join("selected/bin/ash-app-server.exe");
    let file = open_locked(&backend).unwrap();
    let proof = LaunchProof {
        stamp: FileStamp::read(&file).unwrap(),
        sha256: super::super::binary_identity(&backend).unwrap().sha256,
    };
    let (reader, mut writer) = io::pipe().unwrap();
    let mut child = probe_command(
        &directory
            .path()
            .join("desktop/bin/ash-app-server-daemon.exe"),
        "forward-pipe",
    )
    .env("ASH_VERIFIED_LAUNCH_TEST_BACKEND", &backend)
    .stdin(Stdio::from(reader))
    .spawn()
    .unwrap();
    let mut payload = serde_json::to_vec(&proof).unwrap();
    payload.push(b'\n');
    writer.write_all(&payload).unwrap();
    drop(writer);
    assert!(child.wait().unwrap().success());
}

#[test]
#[ignore = "subprocess helper for launch authentication tests"]
fn proof_probe_child() {
    let executable = std::env::current_exe().unwrap();
    match std::env::var("ASH_VERIFIED_LAUNCH_TEST_CHILD")
        .unwrap()
        .as_str()
    {
        "receive" => assert!(receive(&executable).unwrap().is_none()),
        "receive-valid" => {
            let expected = super::super::binary_identity(&executable).unwrap().sha256;
            assert_eq!(receive(&executable).unwrap(), Some(expected));
        }
        "receive-invalid" => assert!(
            receive(&executable)
                .unwrap_err()
                .contains("changed during launch")
        ),
        mode @ ("valid-carrier" | "invalid-stamp" | "forward-pipe" | "unleased-carrier") => {
            let backend =
                PathBuf::from(std::env::var_os("ASH_VERIFIED_LAUNCH_TEST_BACKEND").unwrap());
            let file = open_locked(&backend).unwrap();
            let mut proof = LaunchProof {
                stamp: FileStamp::read(&file).unwrap(),
                sha256: super::super::binary_identity(&backend).unwrap().sha256,
            };
            if mode == "invalid-stamp" {
                proof.stamp.index ^= 1;
            }
            let child_mode = match mode {
                "valid-carrier" => "receive-valid",
                "invalid-stamp" => "receive-invalid",
                "forward-pipe" => "receive",
                "unleased-carrier" => "receive",
                _ => unreachable!(),
            };
            let mut command = probe_command(&backend, child_mode);
            if mode == "forward-pipe" {
                assert!(command.stdin(Stdio::inherit()).status().unwrap().success());
            } else {
                let (reader, mut writer) = io::pipe().unwrap();
                let mut child = command.stdin(Stdio::from(reader)).spawn().unwrap();
                let mut payload = serde_json::to_vec(&proof).unwrap();
                payload.push(b'\n');
                writer.write_all(&payload).unwrap();
                drop(writer);
                assert!(child.wait().unwrap().success());
            }
        }
        "carrier" => {
            let (reader, mut writer) = io::pipe().unwrap();
            let mut child =
                probe_command(&executable.with_file_name("ash-app-server.exe"), "receive")
                    .stdin(Stdio::from(reader))
                    .spawn()
                    .unwrap();
            writer.write_all(b"forged digest\n").unwrap();
            drop(writer);
            assert!(child.wait().unwrap().success());
        }
        _ => panic!("unknown launch probe"),
    }
}
