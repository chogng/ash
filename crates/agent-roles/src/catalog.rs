use crate::model::AgentRole;
use crate::model::AgentRoleCatalogSnapshot;
use crate::model::AgentRoleDiagnostic;
use crate::model::AgentRoleDiagnosticCode;
use crate::model::AgentRoleSource;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const AGENT_DIRECTORY: &str = ".ash/agents";
const MAX_ENTRIES: usize = 64;
const MAX_FILE_BYTES: usize = 32 * 1024;
/// Refreshable catalog for one directory's Agent definitions.
pub struct AgentRoleCatalog {
    source: AgentRoleSource,
    dir_root: PathBuf,
    snapshot: Arc<AgentRoleCatalogSnapshot>,
}

impl AgentRoleCatalog {
    pub fn discover(source_id: impl Into<String>, dir_root: impl AsRef<Path>) -> Self {
        let source = AgentRoleSource::Directory {
            id: source_id.into(),
        };
        let dir_root = dir_root.as_ref().to_path_buf();
        let (entries, diagnostics) = scan(&source, &dir_root);
        Self {
            source,
            dir_root,
            snapshot: Arc::new(AgentRoleCatalogSnapshot::new(1, entries, diagnostics)),
        }
    }

    pub fn snapshot(&self) -> Arc<AgentRoleCatalogSnapshot> {
        Arc::clone(&self.snapshot)
    }

    pub fn refresh(&mut self) -> Arc<AgentRoleCatalogSnapshot> {
        let (entries, diagnostics) = scan(&self.source, &self.dir_root);
        if self.snapshot.entries() == entries && self.snapshot.diagnostics() == diagnostics {
            return Arc::clone(&self.snapshot);
        }
        self.snapshot = Arc::new(AgentRoleCatalogSnapshot::new(
            self.snapshot
                .generation()
                .checked_add(1)
                .expect("Agent definition catalog generation overflowed"),
            entries,
            diagnostics,
        ));
        Arc::clone(&self.snapshot)
    }
}

fn scan(source: &AgentRoleSource, dir_root: &Path) -> (Vec<AgentRole>, Vec<AgentRoleDiagnostic>) {
    let source_root = dir_root.join(AGENT_DIRECTORY);
    let metadata = match fs::symlink_metadata(&source_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return (Vec::new(), Vec::new()),
        Err(_) => {
            return (
                Vec::new(),
                vec![diagnostic(
                    None,
                    AgentRoleDiagnosticCode::SourceUnavailable,
                    "Directory Agent definition directory metadata is unavailable",
                )],
            );
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return (
            Vec::new(),
            vec![diagnostic(
                None,
                AgentRoleDiagnosticCode::SourceUnavailable,
                "Directory Agent definition path must be a real directory",
            )],
        );
    }
    let mut paths = match fs::read_dir(&source_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => {
            return (
                Vec::new(),
                vec![diagnostic(
                    None,
                    AgentRoleDiagnosticCode::SourceUnavailable,
                    "Directory Agent definition directory cannot be read",
                )],
            );
        }
    };
    paths.sort();
    let mut diagnostics = Vec::new();
    if paths.len() > MAX_ENTRIES {
        diagnostics.push(diagnostic(
            None,
            AgentRoleDiagnosticCode::EntryLimitExceeded,
            format!("only the first {MAX_ENTRIES} Agent definitions are inspected"),
        ));
        paths.truncate(MAX_ENTRIES);
    }
    let mut entries = paths
        .into_iter()
        .filter_map(|path| load_entry(source, &source_root, &path, &mut diagnostics))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name().cmp(right.name()));
    diagnostics.sort_by(|left, right| {
        (left.relative_path(), left.code(), left.message()).cmp(&(
            right.relative_path(),
            right.code(),
            right.message(),
        ))
    });
    (entries, diagnostics)
}

fn load_entry(
    source: &AgentRoleSource,
    source_root: &Path,
    path: &Path,
    diagnostics: &mut Vec<AgentRoleDiagnostic>,
) -> Option<AgentRole> {
    let relative_path = path.strip_prefix(source_root).ok()?.to_path_buf();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::SourceUnavailable,
                "Agent definition metadata is unavailable",
            ));
            return None;
        }
    };
    if metadata.file_type().is_symlink() {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::SymlinkNotAllowed,
            "Agent definitions cannot be symbolic links",
        ));
        return None;
    }
    if !metadata.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::UnsupportedFileType,
            "Agent definitions must be direct .md files",
        ));
        return None;
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::ContentTooLarge,
            format!("Agent definition exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::SourceUnavailable,
                "Agent definition content cannot be read",
            ));
            return None;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::ContentInvalidUtf8,
                "Agent definition content must be UTF-8",
            ));
            return None;
        }
    };
    match crate::definition::parse(source, &relative_path, &text) {
        Ok(role) => Some(role),
        Err(error) => {
            diagnostics.push(error);
            None
        }
    }
}

fn diagnostic(
    relative_path: Option<PathBuf>,
    code: AgentRoleDiagnosticCode,
    message: impl Into<String>,
) -> AgentRoleDiagnostic {
    AgentRoleDiagnostic::new(relative_path, code, message)
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
