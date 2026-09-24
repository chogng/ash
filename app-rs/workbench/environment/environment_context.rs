use std::path::{Path, PathBuf};
use std::{fs, io};

use ash_app_server_protocol::protocol::git::{GitChangeStatusDto, GitHeadDto, GitTextDiffResult};
use ash_diff::DiffDocument;
use ash_editor::{CodeEditorLanguage, DiffEditorDocument};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GitDiff {
    path: String,
    document: DiffEditorDocument,
    staging: ash_scm::ScmStaging,
}

impl GitDiff {
    pub(crate) fn path(&self) -> &str {
        &self.path
    }

    pub(crate) const fn document(&self) -> &DiffEditorDocument {
        &self.document
    }

    pub(crate) const fn staging(&self) -> ash_scm::ScmStaging {
        self.staging
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EnvironmentContext {
    working_directory: PathBuf,
    working_directory_label: String,
    location: EnvironmentLocation,
    git_branch: Option<String>,
    git_repository_root: Option<PathBuf>,
    upstream_distance: Option<(usize, usize)>,
    change_count: usize,
    diffs: Vec<GitDiff>,
    diff_additions: usize,
    diff_deletions: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EnvironmentLocation {
    Local,
    Remote,
}

impl EnvironmentContext {
    pub(crate) fn capture_current() -> Self {
        let working_directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self::capture_with_location(working_directory, EnvironmentLocation::Local)
    }

    #[cfg(test)]
    fn capture(working_directory: PathBuf) -> Self {
        Self::capture_with_location(working_directory, EnvironmentLocation::Local)
    }

    pub(crate) fn capture_remote(working_directory: PathBuf) -> Self {
        Self::capture_with_location(working_directory, EnvironmentLocation::Remote)
    }

    fn capture_with_location(working_directory: PathBuf, location: EnvironmentLocation) -> Self {
        let working_directory = match location {
            EnvironmentLocation::Local => working_directory
                .canonicalize()
                .unwrap_or(working_directory),
            EnvironmentLocation::Remote => working_directory,
        };
        let home = (location == EnvironmentLocation::Local)
            .then(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from)
            })
            .flatten();
        let working_directory_label =
            display_working_directory(&working_directory, home.as_deref());
        Self {
            working_directory,
            working_directory_label,
            location,
            git_branch: None,
            git_repository_root: None,
            upstream_distance: None,
            change_count: 0,
            diffs: Vec::new(),
            diff_additions: 0,
            diff_deletions: 0,
        }
    }

    pub(crate) const fn location_label(&self) -> &'static str {
        match self.location {
            EnvironmentLocation::Local => "Local",
            EnvironmentLocation::Remote => "Remote",
        }
    }

    pub(crate) fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    pub(crate) fn working_directory_label(&self) -> &str {
        &self.working_directory_label
    }

    pub(crate) fn git_branch_label(&self) -> &str {
        self.git_branch.as_deref().unwrap_or("No Git")
    }

    pub(crate) fn git_repository_root(&self) -> Option<&Path> {
        self.git_repository_root.as_deref()
    }

    pub(crate) fn diff_summary_label(&self) -> String {
        self.git_branch
            .as_ref()
            .map(|_| {
                format!(
                    "Changes {} • +{} -{}",
                    self.change_count, self.diff_additions, self.diff_deletions
                )
            })
            .unwrap_or_else(|| "Changes —".to_string())
    }

    pub(crate) const fn upstream_distance(&self) -> Option<(usize, usize)> {
        self.upstream_distance
    }

    pub(crate) fn diffs(&self) -> &[GitDiff] {
        &self.diffs
    }

    pub(crate) fn apply_git_snapshot(&mut self, snapshot: Option<&GitTextDiffResult>) {
        self.clear_repository();
        let Some(snapshot) = snapshot else {
            return;
        };
        let (branch, upstream_distance) = match &snapshot.status.head {
            GitHeadDto::Branch { name, upstream, .. } => (
                name.clone(),
                upstream
                    .as_ref()
                    .map(|upstream| (upstream.ahead, upstream.behind)),
            ),
            GitHeadDto::Detached { object_id } => {
                (object_id.chars().take(8).collect::<String>(), None)
            }
            GitHeadDto::Unborn { name } => (name.clone(), None),
        };
        self.git_branch = Some(branch);
        self.git_repository_root =
            repository_root_from_path(&self.working_directory, &snapshot.status.path);
        self.upstream_distance = upstream_distance;
        self.change_count = snapshot.status.changes.len();
        self.diffs = snapshot
            .diffs
            .iter()
            .filter_map(|diff| {
                let staging = snapshot
                    .status
                    .changes
                    .iter()
                    .find(|change| change.path == diff.path)
                    .map_or(ash_scm::ScmStaging::Unstaged, |change| {
                        match (
                            change.index_status != GitChangeStatusDto::Unmodified,
                            change.worktree_status != GitChangeStatusDto::Unmodified,
                        ) {
                            (true, true) => ash_scm::ScmStaging::Partial,
                            (true, false) => ash_scm::ScmStaging::Staged,
                            (false, _) => ash_scm::ScmStaging::Unstaged,
                        }
                    });
                DiffDocument::from_text(&diff.original, &diff.modified)
                    .ok()
                    .map(|document| GitDiff {
                        path: diff.path.clone(),
                        staging,
                        document: DiffEditorDocument::new(
                            document,
                            editor_language_for_path(Path::new(&diff.path)),
                        ),
                    })
            })
            .collect();
        self.diff_additions = snapshot.statistics.additions;
        self.diff_deletions = snapshot.statistics.deletions;
    }

    pub(crate) fn switch_working_directory(
        &mut self,
        working_directory: PathBuf,
    ) -> io::Result<()> {
        let working_directory = working_directory.canonicalize()?;
        if !fs::metadata(&working_directory)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not a directory", working_directory.display()),
            ));
        }
        *self = Self::capture_with_location(working_directory, EnvironmentLocation::Local);
        Ok(())
    }

    fn clear_repository(&mut self) {
        self.git_branch = None;
        self.git_repository_root = None;
        self.upstream_distance = None;
        self.change_count = 0;
        self.diffs.clear();
        self.diff_additions = 0;
        self.diff_deletions = 0;
    }

    #[cfg(test)]
    pub(crate) fn fixture(
        working_directory_label: impl Into<String>,
        git_branch: Option<&str>,
        diff_count: Option<usize>,
    ) -> Self {
        let diffs: Vec<_> = (0..diff_count.unwrap_or(0))
            .filter_map(|index| {
                DiffDocument::from_text("", &format!("fixture {index}\n"))
                    .ok()
                    .map(|document| GitDiff {
                        path: format!("fixture-{index}.txt"),
                        staging: ash_scm::ScmStaging::Unstaged,
                        document: DiffEditorDocument::new(document, CodeEditorLanguage::PlainText),
                    })
            })
            .collect();
        Self {
            working_directory: PathBuf::from("/fixture"),
            working_directory_label: working_directory_label.into(),
            location: EnvironmentLocation::Local,
            git_branch: git_branch.map(ToOwned::to_owned),
            git_repository_root: git_branch.map(|_| PathBuf::from("/fixture")),
            upstream_distance: git_branch.map(|_| (0, 0)),
            change_count: diffs.len(),
            diff_additions: diffs.len(),
            diff_deletions: 0,
            diffs,
        }
    }
}

fn repository_root_from_path(working_directory: &Path, path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        return Some(working_directory.to_path_buf());
    }
    let components = path.components().collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    let repository_root = working_directory.ancestors().nth(components.len())?;
    let actual_suffix = working_directory.strip_prefix(repository_root).ok()?;
    actual_suffix
        .components()
        .eq(components)
        .then(|| repository_root.to_path_buf())
}

fn editor_language_for_path(path: &Path) -> CodeEditorLanguage {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("rs") => CodeEditorLanguage::Rust,
        Some("json") => CodeEditorLanguage::Json,
        Some("jsonc") => CodeEditorLanguage::Jsonc,
        Some("sh" | "bash" | "zsh") => CodeEditorLanguage::Shell,
        _ => CodeEditorLanguage::PlainText,
    }
}

pub(crate) fn display_working_directory(working_directory: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if working_directory == home {
            return "~".to_string();
        }
        if let Ok(relative) = working_directory.strip_prefix(home) {
            return format!("~/{}", relative.display());
        }
    }
    working_directory.display().to_string()
}

#[cfg(test)]
#[path = "environment_context_tests.rs"]
mod tests;
