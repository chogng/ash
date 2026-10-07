use super::Artifact;
use super::Command;
use super::write_typescript_files;
use ash_app_server_protocol::GENERATED_TYPESCRIPT_HEADER;
use std::path::PathBuf;
use std::time::SystemTime;

#[test]
fn parses_a_typescript_output_directory() {
    let command = Command::parse([
        "typescript".to_owned(),
        "--out".to_owned(),
        "generated/app-server".to_owned(),
    ])
    .unwrap();

    let Command::Generate {
        artifact,
        output_directory,
    } = command
    else {
        panic!("expected an artifact generation command");
    };
    assert!(matches!(artifact, Artifact::TypeScript));
    assert_eq!(output_directory, PathBuf::from("generated/app-server"));
}

#[test]
fn parses_the_checked_in_fixture_command() {
    assert!(matches!(
        Command::parse(["fixtures".to_owned()]),
        Ok(Command::WriteFixtures)
    ));
}

#[test]
fn rejects_missing_and_extra_arguments() {
    assert!(Command::parse(["json".to_owned()]).is_err());
    assert!(
        Command::parse([
            "json".to_owned(),
            "--out".to_owned(),
            "schema".to_owned(),
            "unexpected".to_owned(),
        ])
        .is_err()
    );
    assert!(Command::parse(["fixtures".to_owned(), "unexpected".to_owned()]).is_err());
}

#[test]
fn generation_removes_only_stale_generated_typescript() {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "ash-app-server-protocol-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("stale.ts"),
        format!("{GENERATED_TYPESCRIPT_HEADER}export type Stale = never;\n"),
    )
    .unwrap();
    std::fs::write(
        directory.join("handwritten.ts"),
        "export const keep = true;\n",
    )
    .unwrap();

    write_typescript_files(&directory).unwrap();

    assert!(!directory.join("stale.ts").exists());
    assert!(directory.join("handwritten.ts").exists());
    assert!(directory.join("types/ModelRef.ts").exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn writes_metadata_without_exporting_typescript() {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "ash-protocol-metadata-{}-{unique}",
        std::process::id()
    ));
    Command::parse([
        "metadata".to_owned(),
        "--out".to_owned(),
        directory.to_str().unwrap().to_owned(),
    ])
    .unwrap()
    .write()
    .unwrap();
    let actual: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("metadata.json")).unwrap()).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../../schema/metadata.json")).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);

    let path = directory.join("metadata.json");
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_times(
        std::fs::FileTimes::new()
            .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000)),
    )
    .unwrap();
    let modified = file.metadata().unwrap().modified().unwrap();
    drop(file);
    super::write_artifact(
        &directory,
        "metadata.json",
        ash_app_server_protocol::protocol_metadata(),
    )
    .unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    std::fs::remove_dir_all(directory).unwrap();
}
