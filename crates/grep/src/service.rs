use crate::Backend;
use crate::CaseSensitivity;
use crate::DocumentContent;
use crate::Error;
use crate::Freshness;
use crate::FuzzyFileMatch;
use crate::FuzzyFileMatches;
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
use std::path::Component;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::Weak;
use std::time::Duration;

/// Shared engine selection, repository storage, and independent directory registrations.
pub struct Service {
    ripgrep: RipgrepExecutable,
    storage: Option<Arc<StateRuntime>>,
    state: RwLock<State>,
    configuration: Mutex<()>,
    repositories: Mutex<BTreeMap<PathBuf, Weak<IndexStorage>>>,
}
struct State {
    backend: Backend,
    executable: Option<tgrep::Executable>,
    changing: bool,
    indexes: BTreeMap<DirId, Arc<DirectoryIndex>>,
}
struct Index {
    search: tgrep::Session,
    _storage: Arc<IndexStorage>,
}
struct IndexStorage {
    _lease: Option<DirIndexLease>,
    _temporary: Option<tempfile::TempDir>,
}

struct DirectoryIndex {
    root: PathBuf,
    state: Mutex<DirectoryState>,
    changed: Condvar,
}
struct DirectoryState {
    admission: Admission,
    index: IndexPhase,
    active: usize,
}
#[derive(PartialEq)]
enum Admission {
    Open,
    Draining,
    Closed,
}
enum IndexPhase {
    Vacant,
    Opening,
    Ready(Arc<Index>),
}
struct DirectoryUse {
    directory: Arc<DirectoryIndex>,
}
struct IndexUse {
    // Release the session reference before notifying a waiting directory drain.
    index: Arc<Index>,
    _directory: DirectoryUse,
}
struct OpeningLifetime {
    _storage: Arc<IndexStorage>,
    _directory: DirectoryUse,
}

impl DirectoryIndex {
    fn new(root: &Dir) -> Self {
        Self {
            root: dunce::simplified(root.canonical_path()).to_path_buf(),
            state: Mutex::new(DirectoryState {
                admission: Admission::Open,
                index: IndexPhase::Vacant,
                active: 0,
            }),
            changed: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> Result<DirectoryUse, Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.admission != Admission::Open {
            return Err(Error::Failed(
                "directory search registration is being released".into(),
            ));
        }
        state.active += 1;
        Ok(DirectoryUse {
            directory: Arc::clone(self),
        })
    }

    fn close(&self, cancellation: &CancellationToken) -> Result<(), Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.admission == Admission::Draining {
            cancelled(cancellation)?;
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(25))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        cancelled(cancellation)?;
        if state.admission == Admission::Closed {
            return Ok(());
        }
        state.admission = Admission::Draining;
        while state.active != 0 {
            if let Err(error) = cancelled(cancellation) {
                state.admission = Admission::Open;
                self.changed.notify_all();
                return Err(error);
            }
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(25))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        let index = std::mem::replace(&mut state.index, IndexPhase::Vacant);
        drop(state);
        let (result, retained) = match index {
            IndexPhase::Ready(index) => {
                let mut index = Arc::try_unwrap(index)
                    .unwrap_or_else(|_| panic!("drained directory retained a search reference"));
                let result = index.search.close(cancellation).map_err(Error::from);
                // Keep the storage lease and registration if detachment needs a retry.
                let retained = result.is_err().then(|| Arc::new(index));
                (result, retained)
            }
            IndexPhase::Vacant => (Ok(()), None),
            IndexPhase::Opening => unreachable!("opening directory has an active caller"),
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = retained {
            state.index = IndexPhase::Ready(index);
            state.admission = Admission::Open;
        } else {
            state.admission = Admission::Closed;
        }
        self.changed.notify_all();
        result
    }
}
impl Drop for DirectoryUse {
    fn drop(&mut self) {
        let mut state = self
            .directory
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        self.directory.changed.notify_all();
    }
}
impl DirectoryUse {
    fn retain(&self) -> Self {
        let mut state = self
            .directory
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.active += 1;
        Self {
            directory: Arc::clone(&self.directory),
        }
    }
}

fn cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    cancellation
        .check()
        .map_err(|reason| Error::Cancelled(reason.reason().to_string()))
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
                changing: false,
                indexes: BTreeMap::new(),
            }),
            configuration: Mutex::new(()),
            repositories: Mutex::new(BTreeMap::new()),
        })
    }

    /// Applies the new backend after admitted queries finish and their registrations detach.
    /// Concurrent reconfiguration is serialized without retaining the global lookup lock during I/O.
    pub fn configure(&self, backend: Backend) -> Result<(), Error> {
        let _configuration = self.configuration.lock().unwrap_or_else(|e| e.into_inner());
        if self.state.read().unwrap_or_else(|e| e.into_inner()).backend == backend {
            return Ok(());
        }
        let executable = match backend {
            Backend::Tgrep => Some(tgrep::Executable::resolve(&InstallContext::current())?),
            Backend::Ripgrep => None,
        };
        let indexes = {
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            state.changing = true;
            state.indexes.values().cloned().collect::<Vec<_>>()
        };
        let cancellation = ash_async_utils::CancellationSource::new();
        let result = indexes
            .iter()
            .try_for_each(|index| index.close(&cancellation.token()));
        let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
        state.changing = false;
        // Successfully closed registrations must be reopened even if another detach failed.
        state.indexes.retain(|_, index| {
            index
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .admission
                != Admission::Closed
        });
        result?;
        state.executable = executable;
        state.backend = backend;
        Ok(())
    }

    /// Records writes synchronously so all consumers see Ash edits even before watcher delivery.
    pub fn paths_changed(&self, root: &Dir, paths: &[PathBuf]) {
        let directory = self
            .state
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .indexes
            .get(&root.id())
            .cloned();
        if let Some(directory) = directory {
            let state = directory.state.lock().unwrap_or_else(|e| e.into_inner());
            if let IndexPhase::Ready(index) = &state.index {
                // A cancelled drain can resume this registration, so retain writes while waiting.
                index.search.paths_changed(paths);
            }
        }
    }

    /// Keeps this directory registration alive while its engine scores the canonical catalog.
    pub fn indexed_fuzzy(
        &self,
        dir: &Dir,
        query: &str,
        max_results: usize,
        cancellation: &CancellationToken,
    ) -> Result<Option<FuzzyFileMatches>, Error> {
        cancelled(cancellation)?;
        if query.len() > 1024 || query.contains('\0') || !(1..=5000).contains(&max_results) {
            return Err(Error::InvalidInput(
                "invalid fuzzy file query or limit".into(),
            ));
        }
        let Some(index) = self.index_for(dir, cancellation)? else {
            return Ok(None);
        };
        let found = index
            .index
            .search
            .file_fuzzy(query, max_results, cancellation)?;
        Ok(Some(FuzzyFileMatches {
            matches: found
                .matches
                .into_iter()
                .map(|matched| FuzzyFileMatch {
                    score: matched.score,
                    path: matched.path,
                    indices: matched.indices,
                })
                .collect(),
            total_match_count: found.total_match_count,
            scanned_file_count: found.scanned_file_count,
        }))
    }

    /// Drains only this canonical directory before filesystem removal, observing cancellation.
    /// Its retained identity permits cleanup retries after the checkout has been removed.
    pub fn release_directory(
        &self,
        canonical_root: &std::path::Path,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        cancelled(cancellation)?;
        let registered = {
            let state = self.state.read().unwrap_or_else(|e| e.into_inner());
            state
                .indexes
                .iter()
                .find(|(_, index)| index.root == dunce::simplified(canonical_root))
                .map(|(id, index)| (id.clone(), Arc::clone(index)))
        };
        if let Some((id, index)) = registered {
            index.close(cancellation)?;
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            if state
                .indexes
                .get(&id)
                .is_some_and(|current| Arc::ptr_eq(current, &index))
            {
                state.indexes.remove(&id);
            }
        }
        Ok(())
    }

    fn registered_index(&self, root: &Dir) -> Result<(Backend, Option<IndexUse>), Error> {
        let state = self.state.read().unwrap_or_else(|e| e.into_inner());
        let Some(directory) = state.indexes.get(&root.id()) else {
            return Ok((state.backend, None));
        };
        let usage = directory.acquire()?;
        let index = {
            let state = directory.state.lock().unwrap_or_else(|e| e.into_inner());
            match &state.index {
                IndexPhase::Ready(index) => Some(Arc::clone(index)),
                IndexPhase::Vacant | IndexPhase::Opening => None,
            }
        };
        Ok((
            state.backend,
            index.map(|index| IndexUse {
                index,
                _directory: usage,
            }),
        ))
    }

    pub fn index_status(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<IndexStatus, Error> {
        cancelled(cancellation)?;
        let (backend, index) = self.registered_index(root)?;
        match index {
            Some(index) => Ok(status(index.index.search.status(cancellation)?)),
            None => Ok(IndexStatus {
                enabled: backend == Backend::Tgrep,
                ..IndexStatus::default()
            }),
        }
    }

    pub fn rebuild_index(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<IndexStatus, Error> {
        let index = self
            .index_for(root, cancellation)?
            .ok_or_else(|| Error::Failed("selected grep engine does not use an index".into()))?;
        Ok(status(index.index.search.rebuild(cancellation)?))
    }

    /// Clears repository-owned search storage after its worktree registrations are released.
    pub fn clear_index(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<ash_state::ClearOutcome, Error> {
        let Some(storage) = &self.storage else {
            return Ok(ash_state::ClearOutcome::AlreadyAbsent);
        };
        let executable = tgrep::Executable::resolve(&InstallContext::current())?;
        let identity = executable.directory_identity(root.canonical_path(), cancellation)?;
        let directory = Dir::open_local(identity).map_err(|e| Error::Failed(e.to_string()))?;
        storage
            .clear_index(&directory.id(), DirIndexKind::Grep)
            .map_err(Into::into)
    }

    fn index_for(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<Option<IndexUse>, Error> {
        cancelled(cancellation)?;
        let (executable, usage) = {
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            if state.changing {
                return Err(Error::Failed("search backend is being reconfigured".into()));
            }
            let executable = match state.backend {
                Backend::Ripgrep => return Ok(None),
                Backend::Tgrep => state.executable.clone().expect("indexed executable"),
            };
            let directory = state
                .indexes
                .entry(root.id())
                .or_insert_with(|| Arc::new(DirectoryIndex::new(root)));
            (executable, directory.acquire()?)
        };
        let directory = &usage.directory;
        let mut state = directory.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            cancelled(cancellation)?;
            match &state.index {
                IndexPhase::Ready(index) => {
                    let index = Arc::clone(index);
                    drop(state);
                    return Ok(Some(IndexUse {
                        index,
                        _directory: usage,
                    }));
                }
                IndexPhase::Vacant => {
                    state.index = IndexPhase::Opening;
                    break;
                }
                IndexPhase::Opening => {
                    state = directory
                        .changed
                        .wait_timeout(state, Duration::from_millis(25))
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
        }
        drop(state);
        let result = self.open_index(&executable, root, cancellation, &usage);
        let mut state = directory.state.lock().unwrap_or_else(|e| e.into_inner());
        state.index = match &result {
            Ok(index) => IndexPhase::Ready(Arc::clone(index)),
            Err(_) => IndexPhase::Vacant,
        };
        directory.changed.notify_all();
        drop(state);
        result.map(|index| {
            Some(IndexUse {
                index,
                _directory: usage,
            })
        })
    }

    fn open_index(
        &self,
        executable: &tgrep::Executable,
        root: &Dir,
        cancellation: &CancellationToken,
        usage: &DirectoryUse,
    ) -> Result<Arc<Index>, Error> {
        let identity = executable.directory_identity(root.canonical_path(), cancellation)?;
        let mut repositories = self.repositories.lock().unwrap_or_else(|e| e.into_inner());
        repositories.retain(|_, storage| storage.strong_count() != 0);
        let storage = if let Some(storage) = repositories.get(&identity).and_then(Weak::upgrade) {
            storage
        } else {
            let directory = Dir::open_local(&identity).map_err(|e| Error::Failed(e.to_string()))?;
            let lease = self
                .storage
                .as_ref()
                .map(|s| s.acquire(&directory.id(), DirIndexKind::Grep))
                .transpose()?;
            let temporary = if lease.is_none() {
                Some(tempfile::tempdir()?)
            } else {
                None
            };
            let storage = Arc::new(IndexStorage {
                _lease: lease,
                _temporary: temporary,
            });
            // Registrations own leases; this lookup must not keep an unused repository in use.
            repositories.insert(identity, Arc::downgrade(&storage));
            storage
        };
        drop(repositories);
        let base = storage
            ._lease
            .as_ref()
            .map(|l| l.directory())
            .or_else(|| storage._temporary.as_ref().map(|t| t.path()))
            .expect("index storage");
        let search = tgrep::Session::open_with_lifetime(
            executable.clone(),
            root.canonical_path(),
            &base.join(format!("tgrep-{}", tgrep::VERSION)),
            cancellation,
            OpeningLifetime {
                _storage: Arc::clone(&storage),
                _directory: usage.retain(),
            },
        )?;
        Ok(Arc::new(Index {
            search,
            _storage: storage,
        }))
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
        let mut matches: Vec<Match> = Vec::new();
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
            let text = &document.text;
            let starts: Vec<usize> = std::iter::once(0)
                .chain(text.match_indices('\n').map(|(index, _)| index + 1))
                .collect();
            for found in regex.find_iter(text) {
                if found.is_empty() {
                    continue;
                }
                let first = starts.partition_point(|start| *start <= found.start()) - 1;
                let last = starts.partition_point(|start| *start < found.end()) - 1;
                let end = starts.get(last + 1).copied().unwrap_or(text.len());
                let preview = text[starts[first]..end].trim_end_matches(['\r', '\n']);
                let end = if found.end() > starts[first] + preview.len() {
                    end
                } else {
                    starts[first] + preview.len()
                };
                let content = &text[starts[first]..end];
                let range = MatchRange {
                    start: found.start() - starts[first],
                    end: found.end() - starts[first],
                };
                if let Some(previous) = matches.last_mut()
                    && previous.path == relative
                    && previous.line_number == first + 1
                    && previous.content == content
                {
                    previous.ranges.push(range);
                    continue;
                }
                if matches.len() == query.max_results {
                    limit_hit = true;
                    break;
                }
                matches.push(Match {
                    path: relative.to_path_buf(),
                    line_number: first + 1,
                    content: content.into(),
                    ranges: vec![range],
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
        match self.index_for(dir, cancellation)? {
            None => crate::ripgrep::search(&self.ripgrep, dir, query, regex.as_str(), cancellation),
            Some(index) => {
                let result = index.index.search.search(
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
        ready: s.ready,
        indexed_file_count: s.indexed_file_count,
        watcher_active: s.watcher_active,
    }
}
pub(crate) fn validate(query: &Query) -> Result<regex::Regex, Error> {
    if query.query.is_empty()
        || query.query.len() > 16384
        || query.query.contains('\0')
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
        Pattern::Literal => regex::escape(&query.query.replace("\r\n", "\n").replace('\r', "\n"))
            .replace('\n', r"\r?\n"),
        Pattern::Regex => query
            .query
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', r"\r?\n"),
    };
    let insensitive = match query.case_sensitivity {
        CaseSensitivity::Insensitive => true,
        CaseSensitivity::Sensitive => false,
        CaseSensitivity::Smart => !query.query.chars().any(char::is_uppercase),
    };
    let pattern = if insensitive {
        format!("(?mRi){pattern}")
    } else {
        format!("(?mR){pattern}")
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
