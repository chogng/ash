use std::fs;
use std::path::Path;

use tempfile::TempDir;

use super::MAX_DIRECTORY_ENTRIES;
use super::MAX_FILE_BYTES;
use super::MAX_SOURCE_BYTES;
use super::MAX_SOURCE_ENTRIES;
use super::Source;
use crate::AgentImportDiagnosticCode;
use crate::AgentImportLocation;
use crate::ImportItemKind;

#[test]
fn bounds_single_files_and_cumulative_reads() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("large"), vec![b'x'; MAX_FILE_BYTES + 1]).unwrap();
    fs::write(temp.path().join("exact"), vec![b'x'; MAX_FILE_BYTES]).unwrap();
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    assert!(
        source
            .read(Path::new("large"), ImportItemKind::Settings, |text| Ok(
                text.len()
            ))
            .is_none()
    );
    assert_eq!(
        source.diagnostics[0].code(),
        AgentImportDiagnosticCode::LimitExceeded
    );
    for _ in 0..MAX_SOURCE_BYTES / MAX_FILE_BYTES {
        assert_eq!(
            source
                .read(Path::new("exact"), ImportItemKind::Settings, |text| Ok(
                    text.len()
                ))
                .unwrap()
                .value,
            MAX_FILE_BYTES
        );
    }
    assert!(
        source
            .read(Path::new("exact"), ImportItemKind::Settings, |text| Ok(
                text.len()
            ))
            .is_none()
    );
    assert_eq!(
        source.diagnostics.last().unwrap().code(),
        AgentImportDiagnosticCode::LimitExceeded
    );
}

#[test]
fn bounds_each_directory_and_total_enumeration() {
    let temp = TempDir::new().unwrap();
    let directory = temp.path().join("entries");
    fs::create_dir(&directory).unwrap();
    for index in 0..MAX_DIRECTORY_ENTRIES {
        fs::write(directory.join(index.to_string()), "").unwrap();
    }
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    for _ in 0..MAX_SOURCE_ENTRIES / MAX_DIRECTORY_ENTRIES {
        assert_eq!(
            source
                .directory(Path::new("entries"), ImportItemKind::Skills)
                .unwrap()
                .entries
                .len(),
            MAX_DIRECTORY_ENTRIES
        );
    }
    assert!(
        source
            .directory(Path::new("entries"), ImportItemKind::Skills)
            .is_none()
    );
    assert_eq!(
        source.diagnostics.last().unwrap().code(),
        AgentImportDiagnosticCode::LimitExceeded
    );
    fs::write(directory.join("excess"), "").unwrap();
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    assert!(
        source
            .directory(Path::new("entries"), ImportItemKind::Skills)
            .is_none()
    );
    assert_eq!(
        source.diagnostics[0].code(),
        AgentImportDiagnosticCode::LimitExceeded
    );
}

#[test]
fn missing_invalid_and_wrong_type_files_are_isolated() {
    let temp = TempDir::new().unwrap();
    fs::create_dir(temp.path().join("directory")).unwrap();
    fs::write(temp.path().join("invalid-utf8"), [255]).unwrap();
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    assert!(
        source
            .read(Path::new("missing"), ImportItemKind::Settings, |text| Ok(
                text.len()
            ))
            .is_none()
    );
    assert!(source.diagnostics.is_empty());
    assert!(
        source
            .read(Path::new("directory"), ImportItemKind::Settings, |text| Ok(
                text.len()
            ))
            .is_none()
    );
    assert_eq!(
        source.diagnostics[0].code(),
        AgentImportDiagnosticCode::UnexpectedFileType
    );
    assert!(
        source
            .read(
                Path::new("invalid-utf8"),
                ImportItemKind::Settings,
                |text| Ok(text.len())
            )
            .is_none()
    );
    assert_eq!(
        source.diagnostics[1].code(),
        AgentImportDiagnosticCode::InvalidContent
    );
}
