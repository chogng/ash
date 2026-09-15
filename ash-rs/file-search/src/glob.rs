use crate::Service;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fmt;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

/// File enumeration and glob matching within an already-authorized directory.
/// Empty includes enumerate eligible files. Positive includes use rg override semantics.
pub struct GlobQuery {
    pub scope: PathBuf,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_results: usize,
}

/// Root-relative files ordered by modification time (newest first), then path.
#[derive(Debug, Eq, PartialEq)]
pub struct GlobResult {
    pub paths: Vec<PathBuf>,
    pub total_matches: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Error {
    InvalidInput(String),
    Cancelled(String),
    Failed(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::Cancelled(message) | Self::Failed(message) => {
                f.write_str(message)
            }
        }
    }
}
impl std::error::Error for Error {}

impl Service {
    /// Enumerates current disk paths without reading file contents or starting a process.
    pub fn glob(
        &self,
        dir: &Dir,
        query: &GlobQuery,
        cancellation: &CancellationToken,
    ) -> Result<GlobResult, Error> {
        check_cancelled(cancellation)?;
        if !(1..=5000).contains(&query.max_results)
            || query.include_patterns.len() > 64
            || query.exclude_patterns.len() > 64
            || !relative(&query.scope)
        {
            return Err(Error::InvalidInput(
                "invalid file-search scope or limits".into(),
            ));
        }
        let root = dir.canonical_path();
        let scope = root.join(&query.scope).canonicalize().map_err(failed)?;
        if !scope.starts_with(root) || !scope.is_dir() {
            return Err(Error::InvalidInput(
                "scope must be a directory inside its root".into(),
            ));
        }
        let mut overrides = OverrideBuilder::new(root);
        for (patterns, prefix) in [
            (&query.include_patterns, ""),
            (&query.exclude_patterns, "!"),
        ] {
            for pattern in patterns {
                if pattern.is_empty()
                    || pattern.len() > 1024
                    || pattern.starts_with('!')
                    || pattern.contains('\0')
                    || !relative(Path::new(pattern))
                {
                    return Err(Error::InvalidInput(
                        "glob must be a relative include or exclude".into(),
                    ));
                }
                overrides
                    .add(&format!("{prefix}{pattern}"))
                    .map_err(|error| Error::InvalidInput(error.to_string()))?;
            }
        }
        let mut builder = WalkBuilder::new(scope);
        builder
            .hidden(true)
            .follow_links(false)
            .require_git(true)
            .overrides(
                overrides
                    .build()
                    .map_err(|error| Error::InvalidInput(error.to_string()))?,
            );
        let started = Instant::now();
        let mut newest = BinaryHeap::new();
        let mut total_matches = 0usize;
        for entry in builder.build() {
            check_cancelled(cancellation)?;
            if started.elapsed() >= Duration::from_secs(30) {
                return Err(Error::Failed("file search exceeded 30 seconds".into()));
            }
            let entry = entry.map_err(failed)?;
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let path = entry
                .path()
                .strip_prefix(root)
                .map_err(failed)?
                .to_path_buf();
            // Path search contracts use UTF-8 paths, matching the fuzzy path index.
            if path.to_str().is_none() {
                continue;
            }
            let modified = entry.metadata().map_err(failed)?.modified().ok();
            total_matches = total_matches.saturating_add(1);
            newest.push((Reverse(modified), path));
            if newest.len() > query.max_results {
                newest.pop();
            }
        }
        check_cancelled(cancellation)?;
        Ok(GlobResult {
            paths: newest
                .into_sorted_vec()
                .into_iter()
                .map(|(_, path)| path)
                .collect(),
            total_matches,
        })
    }
}

fn relative(path: &Path) -> bool {
    path.components()
        .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn failed(error: impl fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    cancellation
        .check()
        .map_err(|signal| Error::Cancelled(signal.reason().to_string()))
}

#[cfg(test)]
#[path = "glob_tests.rs"]
mod tests;
