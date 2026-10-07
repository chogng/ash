use super::*;
use std::process::Command;

#[test]
fn executable_paths_are_explicit_and_missing_files_are_rejected() {
    let executable = std::env::current_exe().unwrap();
    assert_eq!(resolve_executable(&executable).unwrap(), executable);
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        resolve_executable(directory.path()).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert_eq!(
        resolve_executable(&directory.path().join("missing"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn resource_macro_captures_the_consuming_manifest() {
    let resource =
        crate::find_resource!("Cargo.toml", "_main/crates/utils/cargo-bin/Cargo.toml").unwrap();
    assert!(
        std::fs::read_to_string(resource)
            .unwrap()
            .contains("ash-utils-cargo-bin")
    );
}

#[test]
fn copied_executable_can_be_launched() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory
        .path()
        .join(format!("test-copy{}", std::env::consts::EXE_SUFFIX));
    copy_executable(&std::env::current_exe().unwrap(), &destination).unwrap();
    assert!(
        Command::new(&destination)
            .arg("--list")
            .status()
            .unwrap()
            .success()
    );
}

#[cfg(unix)]
#[test]
fn script_fixture_runs_after_write_and_copy() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("script with spaces");
    let copied = directory.path().join("copied");
    write_executable(&script, "#!/bin/sh\nprintf '%s' \"$1\"\n").unwrap();
    assert_eq!(
        std::fs::metadata(&script).unwrap().permissions().mode() & 0o777,
        0o755
    );
    copy_executable(&script, &copied).unwrap();
    let result = Command::new(copied).arg("a'b $c").output().unwrap();
    assert!(result.status.success());
    assert_eq!(result.stdout, b"a'b $c");
}

#[test]
fn resolves_declared_runfiles_in_directory_and_manifest_modes() {
    let directory = tempfile::tempdir().unwrap();
    let runfiles = directory.path().join("runfiles");
    let program = runfiles.join("_main/bin/fixture");
    std::fs::create_dir_all(program.parent().unwrap()).unwrap();
    std::fs::write(&program, "fixture").unwrap();
    let manifest = directory.path().join("runfiles manifest");
    std::fs::write(
        &manifest,
        format!("_main/bin/fixture {}\n", program.display()),
    )
    .unwrap();
    for (key, value) in [
        ("RUNFILES_DIR", &runfiles),
        ("RUNFILES_MANIFEST_FILE", &manifest),
    ] {
        let mut child = Command::new(std::env::current_exe().unwrap());
        child.args([
            "--exact",
            "tests::runfile_child",
            "--ignored",
            "--nocapture",
        ]);
        for variable in ["RUNFILES_DIR", "RUNFILES_MANIFEST_FILE", "TEST_SRCDIR"] {
            child.env_remove(variable);
        }
        let output = child
            .env(key, value)
            .env("ASH_TEST_PROGRAM", &program)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

#[test]
#[ignore = "invoked in a child process with its own runfiles environment"]
fn runfile_child() {
    assert!(runfiles_available());
    let expected = PathBuf::from(std::env::var_os("ASH_TEST_PROGRAM").unwrap());
    assert_eq!(
        resolve_executable(Path::new("_main/bin/fixture")).unwrap(),
        expected
    );
    assert_eq!(
        resolve_resource("/unused", "unused", "_main/bin/fixture").unwrap(),
        expected
    );
    assert!(resolve_executable(Path::new("_main/bin/missing")).is_err());
}
