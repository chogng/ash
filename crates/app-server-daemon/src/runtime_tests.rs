use super::ElectronRuntimeBinding;
use super::RuntimeAvailability;

#[test]
fn installed_electron_availability_requires_the_probed_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let executable = dunce::canonicalize(directory.path())
        .unwrap()
        .join("electron");
    std::fs::write(&executable, b"installed Electron").unwrap();
    let binding = ElectronRuntimeBinding {
        sha256: super::file_digest(&executable).unwrap(),
        executable: executable.clone(),
        electron_version: "40.0.0".into(),
        node_version: "24.0.0".into(),
    };

    assert_eq!(binding.availability(), RuntimeAvailability::Available);
    std::fs::write(&executable, b"modified Electron!").unwrap();
    assert_eq!(binding.availability(), RuntimeAvailability::Unavailable);
    std::fs::remove_file(executable).unwrap();
    assert_eq!(binding.availability(), RuntimeAvailability::Unavailable);
}
