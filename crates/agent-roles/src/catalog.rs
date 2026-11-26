use crate::model::AgentRole;
use crate::model::AgentRoleCatalogSnapshot;
use crate::model::AgentRoleDiagnostic;
use crate::model::AgentRoleDiagnosticCode;
use crate::model::AgentRoleSource;
use serde::Serialize;
use std::fs;
use std::io;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const AGENT_DIRECTORY: &str = ".ash/agents";
const MAX_ENTRIES: usize = 64;
const MAX_FILE_BYTES: usize = 32 * 1024;

#[derive(Debug)]
pub enum UserRoleMutationError {
    RevisionConflict,
    Io(io::Error),
}

impl From<io::Error> for UserRoleMutationError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
/// Refreshable catalog for one directory's Agent definitions.
pub struct AgentRoleCatalog {
    source: AgentRoleSource,
    source_root: PathBuf,
    snapshot: Arc<AgentRoleCatalogSnapshot>,
}

impl AgentRoleCatalog {
    pub fn discover(source_id: impl Into<String>, dir_root: impl AsRef<Path>) -> Self {
        let source = AgentRoleSource::Directory {
            id: source_id.into(),
        };
        Self::from_source(source, dir_root.as_ref().join(AGENT_DIRECTORY))
    }

    pub fn discover_user(home: &Path) -> Self {
        Self::from_source(AgentRoleSource::User, home.join("agents"))
    }

    fn from_source(source: AgentRoleSource, source_root: PathBuf) -> Self {
        let (entries, diagnostics) = scan(&source, &source_root);
        Self {
            source,
            source_root,
            snapshot: Arc::new(AgentRoleCatalogSnapshot::new(1, entries, diagnostics)),
        }
    }

    pub fn snapshot(&self) -> Arc<AgentRoleCatalogSnapshot> {
        Arc::clone(&self.snapshot)
    }

    pub fn refresh(&mut self) -> Arc<AgentRoleCatalogSnapshot> {
        let (entries, diagnostics) = scan(&self.source, &self.source_root);
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

    /// Creates a user role atomically. An identical retry returns the existing definition.
    pub fn create_user_role(
        &mut self,
        name: &str,
        description: &str,
        prompt: &str,
    ) -> io::Result<()> {
        if self.source != AgentRoleSource::User
            || !crate::definition::valid_name(name)
            || matches!(name, "ash" | "advisor" | "codereview" | "issue")
        {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "Invalid or reserved Agent name",
            ));
        }
        #[derive(Serialize)]
        struct Header<'a> {
            name: &'a str,
            description: &'a str,
        }
        validate_user_text_size(description, prompt)?;
        let header =
            serde_saphyr::to_string_with_options(&Header { name, description }, Default::default())
                .map_err(io::Error::other)?;
        let definition = format!("---\n{}\n---\n{}\n", header.trim_end(), prompt.trim());
        let file_name = PathBuf::from(format!("{name}.md"));
        if definition.len() > MAX_FILE_BYTES {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "Agent definition exceeds its size limit",
            ));
        }
        let expected = crate::definition::parse(&self.source, &file_name, &definition)
            .map_err(invalid_definition)?;
        fs::create_dir_all(&self.source_root)?;
        if !fs::symlink_metadata(&self.source_root)?.is_dir() {
            return Err(io::Error::other(
                "User Agent directory must be a real directory",
            ));
        }
        let path = self.source_root.join(file_name);
        if !path.exists()
            && fs::read_dir(&self.source_root)?.take(MAX_ENTRIES).count() >= MAX_ENTRIES
        {
            return Err(io::Error::other("User Agent directory is full"));
        }
        ash_utils_path::ensure_file_atomically(&path, definition.as_bytes())?;
        let catalog = self.refresh();
        if catalog.get(name) != Some(&expected) {
            return Err(io::Error::new(
                ErrorKind::AlreadyExists,
                "An Agent with this name already exists",
            ));
        }
        Ok(())
    }

    /// Replaces only editable text in an existing user definition, using its catalog digest as a revision.
    pub fn update_user_role(
        &mut self,
        name: &str,
        expected_content_digest: &str,
        description: &str,
        prompt: &str,
    ) -> Result<(), UserRoleMutationError> {
        validate_user_text_size(description, prompt)?;
        let (path, text, role) = self.read_user_definition(name)?;
        if role.description() == description.trim() && role.role_instructions() == prompt.trim() {
            return Ok(());
        }
        if role.content_digest() != expected_content_digest {
            return Err(UserRoleMutationError::RevisionConflict);
        }
        let updated =
            crate::definition::edit_user_text(role.relative_path(), &text, description, prompt)
                .map_err(invalid_definition)?;
        if updated.len() > MAX_FILE_BYTES {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "Agent definition exceeds its size limit",
            )
            .into());
        }
        crate::definition::parse(&self.source, role.relative_path(), &updated)
            .map_err(invalid_definition)?;
        ash_utils_path::write_atomically(&path, updated.as_bytes())?;
        self.refresh();
        Ok(())
    }

    /// Deletes an existing user definition only when its revision still matches.
    pub fn delete_user_role(
        &mut self,
        name: &str,
        expected_content_digest: &str,
    ) -> Result<(), UserRoleMutationError> {
        let (path, _, role) = self.read_user_definition(name)?;
        if role.content_digest() != expected_content_digest {
            return Err(UserRoleMutationError::RevisionConflict);
        }
        fs::remove_file(path)?;
        self.refresh();
        Ok(())
    }

    fn read_user_definition(
        &self,
        name: &str,
    ) -> Result<(PathBuf, String, AgentRole), UserRoleMutationError> {
        if self.source != AgentRoleSource::User || !crate::definition::valid_name(name) {
            return Err(io::Error::new(ErrorKind::InvalidInput, "Invalid Agent name").into());
        }
        if !fs::symlink_metadata(&self.source_root)?.is_dir() {
            return Err(io::Error::other("User Agent directory must be a real directory").into());
        }
        let file_name = PathBuf::from(format!("{name}.md"));
        let path = self.source_root.join(&file_name);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES as u64 {
            return Err(UserRoleMutationError::RevisionConflict);
        }
        let text = fs::read_to_string(&path)?;
        let role = crate::definition::parse(&self.source, &file_name, &text)
            .map_err(|_| UserRoleMutationError::RevisionConflict)?;
        Ok((path, text, role))
    }
}

fn validate_user_text_size(description: &str, prompt: &str) -> io::Result<()> {
    if description.len() > 1024 || prompt.len() > MAX_FILE_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "Agent definition exceeds its size limit",
        ));
    }
    Ok(())
}

fn invalid_definition(error: AgentRoleDiagnostic) -> io::Error {
    io::Error::new(ErrorKind::InvalidInput, error.message().to_owned())
}

fn scan(
    source: &AgentRoleSource,
    source_root: &Path,
) -> (Vec<AgentRole>, Vec<AgentRoleDiagnostic>) {
    let metadata = match fs::symlink_metadata(source_root) {
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
    let mut paths = match fs::read_dir(source_root) {
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
        .filter_map(|path| load_entry(source, source_root, &path, &mut diagnostics))
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
