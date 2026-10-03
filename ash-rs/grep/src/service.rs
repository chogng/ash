use crate::Backend;
use crate::CaseSensitivity;
use crate::DocumentContent;
use crate::Error;
use crate::Freshness;
use crate::IndexStatus;
use crate::Match;
use crate::MatchRange;
use crate::Pattern;
use crate::Query;
use crate::Search;
use crate::SearchResult;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_file_access::DirId;
use ash_install_context::ExecutableCandidates;
use ash_install_context::InstallContext;
use ash_install_context::ManagedExecutable;
use ash_shell_command::RipgrepExecutable;
use ash_state::DirIndexKind;
use ash_state::DirIndexLease;
use ash_state::StateRuntime;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Component;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

/// Shared engine selection and one owned index session per directory, independent of consumers.
pub struct Service {
    ripgrep: RipgrepExecutable,
    storage: Option<Arc<StateRuntime>>,
    state: RwLock<State>,
}
struct State {
    backend: Backend,
    executable: Option<tgrep::Executable>,
    indexes: Mutex<BTreeMap<DirId, Arc<Index>>>,
    changed_paths: Mutex<BTreeMap<DirId, BTreeSet<PathBuf>>>,
}
struct Index {
    search: tgrep::Session,
    _lease: Option<DirIndexLease>,
    _temporary: Option<tempfile::TempDir>,
}
impl Service {
    /// Resolves managed executables once when the host assembles the shared capability.
    pub fn installed(backend: Backend, storage: Option<Arc<StateRuntime>>) -> Result<Self, Error> {
        let ripgrep =
            match InstallContext::current().executable_candidates(ManagedExecutable::Ripgrep) {
                ExecutableCandidates::ExplicitOverride(value) => {
                    RipgrepExecutable::from_override(value.variable(), value.path())
                }
                ExecutableCandidates::SearchPaths(paths) => {
                    RipgrepExecutable::discover_candidates(paths)
                }
            }
            .map_err(|error| Error::Failed(error.to_string()))?;
        Self::new(backend, ripgrep, storage)
    }

    pub fn new(
        backend: Backend,
        ripgrep: RipgrepExecutable,
        storage: Option<Arc<StateRuntime>>,
    ) -> Result<Self, Error> {
        let executable = match backend {
            Backend::Tgrep => Some(tgrep::Executable::resolve(&InstallContext::current())?),
            Backend::Ripgrep => None,
        };
        Ok(Self {
            ripgrep,
            storage,
            state: RwLock::new(State {
                backend,
                executable,
                indexes: Mutex::new(BTreeMap::new()),
                changed_paths: Mutex::new(BTreeMap::new()),
            }),
        })
    }

    /// Updates the same shared service. Existing searches finish before engines are retired;
    /// every caller observes the new selection and observed writes survive the change.
    pub fn configure(&self, backend: Backend) -> Result<(), Error> {
        let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
        if state.backend == backend {
            return Ok(());
        }
        let executable = match backend {
            Backend::Tgrep => Some(tgrep::Executable::resolve(&InstallContext::current())?),
            Backend::Ripgrep => None,
        };
        state
            .indexes
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        state.executable = executable;
        state.backend = backend;
        Ok(())
    }

    /// Records writes synchronously so all consumers see Ash edits even before watcher delivery.
    pub fn paths_changed(&self, root: &Dir, paths: &[PathBuf]) {
        let state = self.state.read().unwrap_or_else(|e| e.into_inner());
        let indexes = state.indexes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = indexes.get(&root.id()) {
            index.search.paths_changed(paths);
        }
        state
            .changed_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(root.id())
            .or_default()
            .extend(paths.iter().cloned());
    }

    pub fn index_status(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<IndexStatus, Error> {
        let state = self.state.read().unwrap_or_else(|e| e.into_inner());
        let index = state
            .indexes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&root.id())
            .cloned();
        match index {
            Some(index) => Ok(status(index.search.status(cancellation)?)),
            None => Ok(IndexStatus {
                enabled: state.backend == Backend::Tgrep,
                ..IndexStatus::default()
            }),
        }
    }

    pub fn rebuild_index(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<IndexStatus, Error> {
        let state = self.state.write().unwrap_or_else(|e| e.into_inner());
        let result = self
            .index_for(&state, root, cancellation)?
            .search
            .rebuild(cancellation)?;
        state
            .changed_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&root.id());
        Ok(status(result))
    }

    fn index_for(
        &self,
        state: &State,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<Arc<Index>, Error> {
        let executable = state
            .executable
            .as_ref()
            .ok_or_else(|| Error::Failed("selected grep engine does not use an index".into()))?;
        let mut indexes = state.indexes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = indexes.get(&root.id()) {
            return Ok(Arc::clone(index));
        }
        let lease = self
            .storage
            .as_ref()
            .map(|s| s.acquire(&root.id(), DirIndexKind::Grep))
            .transpose()?;
        let temporary = if lease.is_none() {
            Some(tempfile::tempdir()?)
        } else {
            None
        };
        let base = lease
            .as_ref()
            .map(|l| l.directory())
            .or_else(|| temporary.as_ref().map(|t| t.path()))
            .expect("index storage");
        let search = tgrep::Session::open(
            executable.clone(),
            root.canonical_path(),
            &base.join(format!("tgrep-{}", tgrep::VERSION)),
            cancellation,
        )?;
        if let Some(paths) = state
            .changed_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&root.id())
        {
            search.paths_changed(&paths.iter().cloned().collect::<Vec<_>>());
        }
        let index = Arc::new(Index {
            search,
            _lease: lease,
            _temporary: temporary,
        });
        indexes.insert(root.id(), Arc::clone(&index));
        Ok(index)
    }
}
impl Search for Service {
    fn search(
        &self,
        dir: &Dir,
        query: &Query,
        cancellation: &CancellationToken,
    ) -> Result<SearchResult, Error> {
        cancellation
            .check()
            .map_err(|s| Error::Cancelled(s.reason().to_string()))?;
        let regex = validate(query)?;
        self.search_disk(dir, query, &regex, cancellation)
    }
}

impl Service {
    /// Searches one coherent task view without putting unsaved text into the shared index.
    pub fn search_with_documents(
        &self,
        dir: &Dir,
        query: &Query,
        documents: &[DocumentContent],
        cancellation: &CancellationToken,
    ) -> Result<SearchResult, Error> {
        let regex = validate(query)?;
        if documents.is_empty() {
            return self.search_disk(dir, query, &regex, cancellation);
        }
        let includes = document_globs(&query.include_patterns)?;
        let excludes = document_globs(&query.exclude_patterns)?;
        let mut disk_query = query.clone();
        disk_query.freshness = Freshness::Current;
        let mut matches = Vec::new();
        let mut limit_hit = false;
        let mut replaced_scope = false;
        let mut documents = documents.iter().collect::<Vec<_>>();
        documents.sort_by(|left, right| left.path.cmp(&right.path));
        for document in documents {
            cancellation
                .check()
                .map_err(|s| Error::Cancelled(s.reason().to_string()))?;
            let relative = document
                .path
                .strip_prefix(dir.canonical_path())
                .map_err(|e| Error::InvalidInput(e.to_string()))?;
            dir.resolve_for_write(relative)
                .map_err(|e| Error::InvalidInput(e.to_string()))?;
            if !relative.starts_with(&query.scope) {
                continue;
            }
            replaced_scope |= relative == query.scope;
            let path = relative.to_string_lossy().replace('\\', "/");
            disk_query.exclude_patterns.push(globset::escape(&path));
            if (!query.include_patterns.is_empty() && !includes.is_match(&path))
                || excludes.is_match(&path)
            {
                continue;
            }
            for (line, text) in document.text.lines().enumerate() {
                let ranges = regex
                    .find_iter(text)
                    .map(|found| MatchRange {
                        start: found.start(),
                        end: found.end(),
                    })
                    .collect::<Vec<_>>();
                if ranges.is_empty() {
                    continue;
                }
                if matches.len() == query.max_results {
                    limit_hit = true;
                    break;
                }
                matches.push(Match {
                    path: relative.to_path_buf(),
                    line_number: line + 1,
                    content: text.into(),
                    ranges,
                });
            }
        }
        // Engines search an explicitly named file even when a glob excludes it.
        // A scope supplied by the editor has no disk contribution, including no matches.
        if !replaced_scope {
            let disk = self.search_disk(dir, &disk_query, &regex, cancellation)?;
            limit_hit |= disk.limit_hit;
            matches.extend(disk.matches);
        }
        matches.sort_by(|left, right| {
            (&left.path, left.line_number).cmp(&(&right.path, right.line_number))
        });
        limit_hit |= matches.len() > query.max_results;
        matches.truncate(query.max_results);
        Ok(SearchResult {
            matches,
            limit_hit,
            freshness: Freshness::Current,
            index_stats: None,
        })
    }

    fn search_disk(
        &self,
        dir: &Dir,
        query: &Query,
        regex: &regex::Regex,
        cancellation: &CancellationToken,
    ) -> Result<SearchResult, Error> {
        let scope = if query.scope.as_os_str().is_empty() {
            dir.canonical_path().to_path_buf()
        } else {
            dir.resolve_existing(&query.scope)
                .map_err(|e| Error::InvalidInput(e.to_string()))?
        };
        if !scope.starts_with(dir.canonical_path()) {
            return Err(Error::InvalidInput(
                "search scope escapes its directory".into(),
            ));
        }
        let state = self.state.read().unwrap_or_else(|e| e.into_inner());
        match state.backend {
            Backend::Ripgrep => {
                crate::ripgrep::search(&self.ripgrep, dir, query, regex.as_str(), cancellation)
            }
            Backend::Tgrep => {
                let index = self.index_for(&state, dir, cancellation)?;
                let result = index.search.search(
                    &tgrep::Query {
                        pattern: regex.as_str(),
                        scope: &query.scope,
                        case_insensitive: false,
                        include: &query
                            .include_patterns
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                        exclude: &query
                            .exclude_patterns
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                        max_results: query.max_results,
                        current: query.freshness == Freshness::Current,
                    },
                    cancellation,
                )?;
                Ok(SearchResult {
                    matches: result
                        .matches
                        .into_iter()
                        .map(|m| {
                            let content = m.content.trim_end_matches('\r').to_owned();
                            let ranges = regex
                                .find_iter(&content)
                                .map(|m| MatchRange {
                                    start: m.start(),
                                    end: m.end(),
                                })
                                .collect();
                            Match {
                                path: m.path,
                                line_number: m.line_number,
                                content,
                                ranges,
                            }
                        })
                        .collect(),
                    limit_hit: result.limit_hit,
                    index_stats: result.index_stats.map(|stats| crate::IndexStats {
                        query_plan: stats.query_plan,
                        raw_candidates: stats.raw_candidates,
                        candidates: stats.candidates,
                        total_files: stats.total_files,
                    }),
                    freshness: if result.indexed {
                        Freshness::Indexed
                    } else {
                        Freshness::Current
                    },
                })
            }
        }
    }
}
fn status(s: tgrep::Status) -> IndexStatus {
    IndexStatus {
        enabled: true,
        active: true,
        indexing: s.indexing,
        ready: s.hidden_complete,
        indexed_file_count: s.indexed_file_count,
        watcher_active: s.watcher_active,
    }
}
pub(crate) fn validate(query: &Query) -> Result<regex::Regex, Error> {
    if query.query.is_empty()
        || query.query.len() > 16384
        || query.query.contains(['\0', '\n', '\r'])
        || query.max_results == 0
        || query.max_results > 5000
        || query.include_patterns.len() > 64
        || query.exclude_patterns.len() > 64
        || !query
            .scope
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(Error::InvalidInput("invalid grep query or scope".into()));
    }
    for pattern in query.include_patterns.iter().chain(&query.exclude_patterns) {
        let p = pattern.replace('\\', "/");
        if p.is_empty()
            || p.len() > 1024
            || p.contains('\0')
            || p.starts_with(['!', '/'])
            || p.split('/').any(|c| c == "..")
            || p.get(1..3).is_some_and(|p| p.starts_with(":/"))
        {
            return Err(Error::InvalidInput("invalid grep glob".into()));
        }
    }
    let pattern = match query.pattern {
        Pattern::Literal => regex::escape(&query.query),
        Pattern::Regex => query.query.clone(),
    };
    let insensitive = match query.case_sensitivity {
        CaseSensitivity::Insensitive => true,
        CaseSensitivity::Sensitive => false,
        CaseSensitivity::Smart => !query.query.chars().any(char::is_uppercase),
    };
    let pattern = if insensitive {
        format!("(?i){pattern}")
    } else {
        pattern
    };
    regex::Regex::new(&pattern).map_err(|e| Error::InvalidInput(e.to_string()))
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

fn document_globs(patterns: &[String]) -> Result<globset::GlobSet, Error> {
    let mut builder = globset::GlobSetBuilder::new();
    for pattern in patterns {
        let path = pattern.replace('\\', "/");
        let path = if path.contains('/') {
            path
        } else {
            format!("**/{path}")
        };
        builder.add(
            globset::GlobBuilder::new(&path)
                .literal_separator(true)
                .build()
                .map_err(|e| Error::InvalidInput(e.to_string()))?,
        );
    }
    builder
        .build()
        .map_err(|e| Error::InvalidInput(e.to_string()))
}
