//! Resolves a [`crate::SandboxScope`] into the concrete host filesystem view
//! shared by every process backend and file tool.
//!
//! Resolution is a preparation-time snapshot: grants, path rules and hidden
//! directories are bound to canonical host paths once, before launch. The
//! canonicalization and containment proofs delegate to `ash-file-access`
//! (`Dir::resolve_existing`); this module owns only the sandbox policy
//! semantics such as deny precedence, protected metadata and host-read scope.
//! Path rules cannot defer that binding to the backends, because a policy
//! expressed in lexical paths is symlink-bypassable and continuous matching is
//! not supported by the registered process backends.

use crate::FileSystemAccess;
use crate::PROTECTED_DIR_METADATA_NAMES;
use crate::SandboxDirAccess;
use crate::SandboxError;
use crate::SandboxScope;
use ash_file_access::Dir;
use ash_file_access::DirPathError;
use globset::GlobBuilder;
use std::collections::BTreeSet;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

const MAX_PATTERN_OBJECTS: usize = 50_000;
const MAX_PATTERN_TIME: Duration = Duration::from_secs(2);

/// Host paths that remain readable in addition to the explicit filesystem rules.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostReadScope {
    /// Only explicit grants and path rules are visible.
    Minimal,
    /// The host remains readable unless a rule explicitly denies access.
    Host,
}

/// Access assigned by one exact or pattern-based filesystem rule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxPathAccess {
    ReadOnly,
    ReadWrite,
    Denied,
}

/// How an exact rule handles a path that does not exist during preparation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MissingPathBehavior {
    Reject,
    Ignore,
}

/// Whether a pattern is frozen during preparation or must cover later filesystem changes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PatternMatchTiming {
    PreparationSnapshot,
    Continuous,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SandboxPathSelector {
    Exact {
        relative: PathBuf,
        missing: MissingPathBehavior,
    },
    Pattern {
        relative: String,
        timing: PatternMatchTiming,
    },
}

/// One filesystem exception owned by an existing directory grant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxPathRule {
    owner: Dir,
    selector: SandboxPathSelector,
    access: SandboxPathAccess,
}

impl SandboxPathRule {
    pub fn exact(
        owner: Dir,
        relative: impl Into<PathBuf>,
        access: SandboxPathAccess,
        missing: MissingPathBehavior,
    ) -> Result<Self, SandboxError> {
        let relative = relative.into();
        validate_relative(&relative)?;
        Ok(Self {
            owner,
            selector: SandboxPathSelector::Exact { relative, missing },
            access,
        })
    }

    pub fn pattern(
        owner: Dir,
        relative: impl Into<String>,
        access: SandboxPathAccess,
        timing: PatternMatchTiming,
    ) -> Result<Self, SandboxError> {
        let relative = relative.into();
        validate_relative(Path::new(&relative))?;
        GlobBuilder::new(&relative)
            .literal_separator(true)
            .build()
            .map_err(|error| {
                SandboxError::InvalidScope(format!("invalid path pattern: {error}"))
            })?;
        Ok(Self {
            owner,
            selector: SandboxPathSelector::Pattern { relative, timing },
            access,
        })
    }

    pub fn owner(&self) -> &Dir {
        &self.owner
    }

    pub fn access(&self) -> SandboxPathAccess {
        self.access
    }

    pub fn pattern_timing(&self) -> Option<PatternMatchTiming> {
        match self.selector {
            SandboxPathSelector::Exact { .. } => None,
            SandboxPathSelector::Pattern { timing, .. } => Some(timing),
        }
    }
}

/// Fully resolved filesystem input shared by every process backend and file tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedFileSystem {
    host_read: HostReadScope,
    readwrite_paths: Vec<PathBuf>,
    readonly_paths: Vec<PathBuf>,
    denied_paths: Vec<PathBuf>,
}

impl ResolvedFileSystem {
    pub fn host_read(&self) -> HostReadScope {
        self.host_read
    }

    pub fn readwrite_paths(&self) -> &[PathBuf] {
        &self.readwrite_paths
    }

    pub fn readonly_paths(&self) -> &[PathBuf] {
        &self.readonly_paths
    }

    pub fn denied_paths(&self) -> &[PathBuf] {
        &self.denied_paths
    }

    pub fn allows_read(&self, path: &Path) -> bool {
        if contained_by(path, &self.denied_paths) {
            return false;
        }
        self.host_read == HostReadScope::Host
            || contained_by(path, &self.readwrite_paths)
            || contained_by(path, &self.readonly_paths)
    }

    pub fn allows_write(&self, path: &Path) -> bool {
        !contained_by(path, &self.denied_paths)
            && contained_by(path, &self.readwrite_paths)
            && !contained_by(path, &self.readonly_paths)
    }
}

pub(crate) fn resolve(
    scope: &SandboxScope,
    access: FileSystemAccess,
) -> Result<ResolvedFileSystem, SandboxError> {
    let mut readwrite = BTreeSet::new();
    let mut readonly = BTreeSet::new();
    let mut denied = BTreeSet::new();

    for grant in scope.grants() {
        let root = grant.dir().canonical_path().to_owned();
        let private_runtime = scope
            .private_ipc_dirs()
            .iter()
            .any(|dir| dir == grant.dir());
        if private_runtime
            || (access != FileSystemAccess::ReadOnly
                && grant.access() == SandboxDirAccess::ReadWrite)
        {
            readwrite.insert(root.clone());
            for name in PROTECTED_DIR_METADATA_NAMES {
                let path = root.join(name);
                match std::fs::symlink_metadata(&path) {
                    Ok(_) => {
                        readonly.insert(resolve_owned(grant.dir(), Path::new(name))?);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(SandboxError::Io(format!(
                            "cannot inspect protected path '{}': {error}",
                            path.display()
                        )));
                    }
                }
            }
        } else {
            readonly.insert(root);
        }
    }
    denied.extend(
        scope
            .hidden_dirs()
            .iter()
            .map(|dir| dir.canonical_path().to_owned()),
    );

    for rule in scope.path_rules() {
        let paths = resolve_rule(rule)?;
        if rule.access() == SandboxPathAccess::Denied {
            for path in &paths {
                reject_linked_file(path)?;
            }
        }
        match rule.access() {
            SandboxPathAccess::ReadOnly => readonly.extend(paths),
            SandboxPathAccess::ReadWrite => readwrite.extend(paths),
            SandboxPathAccess::Denied => denied.extend(paths),
        }
    }

    for path in &denied {
        readwrite.remove(path);
        readonly.remove(path);
    }
    for path in &readwrite {
        readonly.remove(path);
    }

    Ok(ResolvedFileSystem {
        host_read: scope.host_read(),
        readwrite_paths: readwrite.into_iter().collect(),
        readonly_paths: readonly.into_iter().collect(),
        denied_paths: denied.into_iter().collect(),
    })
}

fn reject_linked_file(path: &Path) -> Result<(), SandboxError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        SandboxError::Io(format!(
            "cannot inspect denied path '{}': {error}",
            path.display()
        ))
    })?;
    if metadata.is_file() && !file_has_one_link(path, &metadata)? {
        return Err(SandboxError::UnsupportedPolicy(format!(
            "denied file has multiple or unknown hard links: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn file_has_one_link(_: &Path, metadata: &std::fs::Metadata) -> Result<bool, SandboxError> {
    use std::os::unix::fs::MetadataExt;
    Ok(metadata.nlink() == 1)
}

#[cfg(windows)]
fn file_has_one_link(path: &Path, _: &std::fs::Metadata) -> Result<bool, SandboxError> {
    let file = std::fs::File::open(path).map_err(|error| {
        SandboxError::Io(format!(
            "cannot open denied path '{}': {error}",
            path.display()
        ))
    })?;
    let information = winapi_util::file::information(&file).map_err(|error| {
        SandboxError::Io(format!(
            "cannot inspect denied path '{}': {error}",
            path.display()
        ))
    })?;
    Ok(information.number_of_links() == 1)
}

#[cfg(not(any(unix, windows)))]
fn file_has_one_link(_: &Path, _: &std::fs::Metadata) -> Result<bool, SandboxError> {
    Ok(false)
}

fn resolve_rule(rule: &SandboxPathRule) -> Result<Vec<PathBuf>, SandboxError> {
    match &rule.selector {
        SandboxPathSelector::Exact { relative, missing } => {
            let candidate = rule.owner.canonical_path().join(relative);
            match std::fs::symlink_metadata(&candidate) {
                Ok(_) => Ok(vec![resolve_owned(&rule.owner, relative)?]),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && *missing == MissingPathBehavior::Ignore =>
                {
                    Ok(Vec::new())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Err(SandboxError::InvalidScope(format!(
                        "required sandbox path does not exist: {}",
                        candidate.display()
                    )))
                }
                Err(error) => Err(SandboxError::Io(error.to_string())),
            }
        }
        SandboxPathSelector::Pattern { relative, timing } => {
            if *timing == PatternMatchTiming::Continuous {
                return Err(SandboxError::UnsupportedPolicy(
                    "continuous filesystem patterns are not supported by the registered process backends"
                        .into(),
                ));
            }
            snapshot_pattern(&rule.owner, relative)
        }
    }
}

fn snapshot_pattern(owner: &Dir, relative: &str) -> Result<Vec<PathBuf>, SandboxError> {
    let pattern = relative.replace('\\', "/");
    let matcher = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .case_insensitive(cfg!(windows))
        .build()
        .map_err(|error| SandboxError::InvalidScope(format!("invalid path pattern: {error}")))?
        .compile_matcher();
    let started = Instant::now();
    let mut pending = vec![owner.canonical_path().to_owned()];
    let mut visited = 0usize;
    let mut matches = Vec::new();
    while let Some(path) = pending.pop() {
        visited += 1;
        if visited > MAX_PATTERN_OBJECTS || started.elapsed() > MAX_PATTERN_TIME {
            return Err(SandboxError::InvalidScope(
                "filesystem pattern snapshot exceeded its preparation budget".into(),
            ));
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            SandboxError::Io(format!(
                "cannot inspect sandbox path '{}': {error}",
                path.display()
            ))
        })?;
        let relative_path = path
            .strip_prefix(owner.canonical_path())
            .expect("pattern traversal stays beneath its owner")
            .to_path_buf();
        let matchable = relative_path.to_string_lossy().replace('\\', "/");
        if matcher.is_match(matchable) {
            matches.push(resolve_owned(owner, &relative_path)?);
        }
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let entries = std::fs::read_dir(&path).map_err(|error| {
                SandboxError::Io(format!(
                    "cannot enumerate sandbox path '{}': {error}",
                    path.display()
                ))
            })?;
            for entry in entries {
                pending.push(
                    entry
                        .map_err(|error| SandboxError::Io(error.to_string()))?
                        .path(),
                );
            }
        }
    }
    matches.sort();
    matches.dedup();
    Ok(matches)
}

fn validate_relative(path: &Path) -> Result<(), SandboxError> {
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(SandboxError::InvalidRelativePath(path.to_owned()));
    }
    Ok(())
}

/// Canonicalizes a rule-owned relative path through its directory owner so
/// symlink containment stays the file-access layer's single implementation.
fn resolve_owned(owner: &Dir, relative: &Path) -> Result<PathBuf, SandboxError> {
    owner
        .resolve_existing(relative)
        .map_err(|error| match error {
            DirPathError::OutsideDir(path) => SandboxError::OutsideDir(path),
            DirPathError::InvalidRelativePath(path) => SandboxError::InvalidRelativePath(path),
            DirPathError::RootNotDirectory(path) => SandboxError::Io(format!(
                "sandbox directory root is not a directory: {}",
                path.display()
            )),
            DirPathError::RootUnavailable { message, .. } => SandboxError::Io(message),
        })
}

fn contained_by(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

#[cfg(test)]
#[path = "filesystem_tests.rs"]
mod tests;
