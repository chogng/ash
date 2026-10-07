use std::fs;
use std::io;

use ash_utils_path::{CanonicalContainmentError, CanonicalPathRoot};

use crate::agent_paths::{AgentPath, ExpectedEntryKind, paths_for};
use crate::error::AgentImportError;
use crate::import::{
    AgentImportCandidate, AgentImportDiagnostic, AgentImportDiagnosticCode, AgentImportLocation,
    AgentPathInspection,
};

/// Inspects known files and directories below caller-selected roots without reading contents.
pub fn inspect_agent_paths(
    locations: impl IntoIterator<Item = AgentImportLocation>,
) -> Result<AgentPathInspection, AgentImportError> {
    let mut candidates = Vec::new();
    let mut diagnostics = Vec::new();
    for location in locations {
        let import_root = validate_import_root(&location)?;
        for agent_path in paths_for(location.agent(), location.scope()) {
            inspect_path(
                &location,
                &import_root,
                agent_path,
                &mut candidates,
                &mut diagnostics,
            );
        }
    }
    candidates.sort_by(|left, right| {
        (
            left.agent(),
            left.scope(),
            left.kind(),
            left.relative_path(),
        )
            .cmp(&(
                right.agent(),
                right.scope(),
                right.kind(),
                right.relative_path(),
            ))
    });
    candidates.dedup_by(|left, right| {
        left.agent() == right.agent()
            && left.scope() == right.scope()
            && left.kind() == right.kind()
            && left.source_path() == right.source_path()
    });
    diagnostics.sort_by(|left, right| {
        (
            left.agent(),
            left.scope(),
            left.kind(),
            left.relative_path(),
            left.code(),
        )
            .cmp(&(
                right.agent(),
                right.scope(),
                right.kind(),
                right.relative_path(),
                right.code(),
            ))
    });
    diagnostics.dedup();
    Ok(AgentPathInspection::new(candidates, diagnostics))
}

pub(crate) fn validate_import_root(
    location: &AgentImportLocation,
) -> Result<CanonicalPathRoot, AgentImportError> {
    let metadata = fs::symlink_metadata(location.root()).map_err(|error| {
        AgentImportError::RootUnavailable {
            agent: location.agent(),
            scope: location.scope(),
            error_kind: error.kind(),
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(AgentImportError::RootSymlinkNotAllowed {
            agent: location.agent(),
            scope: location.scope(),
        });
    }
    if !metadata.is_dir() {
        return Err(AgentImportError::RootNotDirectory {
            agent: location.agent(),
            scope: location.scope(),
        });
    }
    CanonicalPathRoot::new(location.root()).map_err(|error| AgentImportError::RootUnavailable {
        agent: location.agent(),
        scope: location.scope(),
        error_kind: error.kind(),
    })
}

fn inspect_path(
    location: &AgentImportLocation,
    import_root: &CanonicalPathRoot,
    agent_path: &AgentPath,
    candidates: &mut Vec<AgentImportCandidate>,
    diagnostics: &mut Vec<AgentImportDiagnostic>,
) {
    let relative_path = std::path::PathBuf::from(agent_path.relative_path);
    let candidate_path = import_root.path().join(&relative_path);
    let metadata = match fs::symlink_metadata(&candidate_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(_) => {
            diagnostics.push(AgentImportDiagnostic::new(
                location,
                agent_path.kind,
                relative_path,
                AgentImportDiagnosticCode::MetadataUnavailable,
            ));
            return;
        }
    };
    if metadata.file_type().is_symlink() {
        diagnostics.push(AgentImportDiagnostic::new(
            location,
            agent_path.kind,
            relative_path,
            AgentImportDiagnosticCode::SymlinkNotAllowed,
        ));
        return;
    }
    let expected_type_matches = match agent_path.expected {
        ExpectedEntryKind::File => metadata.is_file(),
        ExpectedEntryKind::Directory => metadata.is_dir(),
    };
    if !expected_type_matches {
        diagnostics.push(AgentImportDiagnostic::new(
            location,
            agent_path.kind,
            relative_path,
            AgentImportDiagnosticCode::UnexpectedFileType,
        ));
        return;
    }
    let canonical_path = match import_root.canonicalize_within(&candidate_path) {
        Ok(path) => path,
        Err(CanonicalContainmentError::Unavailable(_)) => {
            diagnostics.push(AgentImportDiagnostic::new(
                location,
                agent_path.kind,
                relative_path,
                AgentImportDiagnosticCode::MetadataUnavailable,
            ));
            return;
        }
        Err(CanonicalContainmentError::OutsideRoot) => {
            diagnostics.push(AgentImportDiagnostic::new(
                location,
                agent_path.kind,
                relative_path,
                AgentImportDiagnosticCode::EscapesSelectedRoot,
            ));
            return;
        }
    };
    candidates.push(AgentImportCandidate::new(
        location,
        agent_path.kind,
        agent_path.review,
        relative_path,
        canonical_path,
    ));
}

#[cfg(test)]
#[path = "inspect_path_tests.rs"]
mod tests;
