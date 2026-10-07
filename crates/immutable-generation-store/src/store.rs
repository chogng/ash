use crate::generation_file::GenerationLease;
use crate::generation_file::OpenGenerationFile;
use crate::generation_file::read_exact_at;
use crate::layout::generation_name;
use crate::layout::parse_generation_name;
use crate::layout::parse_manifest_name;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const BASES_DIRECTORY: &str = "bases";
const LAYERS_DIRECTORY: &str = "layers";
const LEASE_FILE: &str = ".lease";
const LOCK_FILE: &str = "store.lock";
const MANIFESTS_DIRECTORY: &str = "manifests";
const MANIFEST_VERSION: &[u8] = b"ash-immutable-generation-v3\0";

/// A named byte file to publish inside an immutable base or change layer.
#[derive(Clone, Copy)]
pub struct GenerationFile<'a> {
    name: &'a str,
    contents: FileContents<'a>,
}

#[derive(Clone, Copy)]
enum FileContents<'a> {
    Bytes(&'a [u8]),
    File(&'a fs::File),
}

impl<'a> GenerationFile<'a> {
    pub fn new(name: &'a str, contents: &'a [u8]) -> Self {
        Self {
            name,
            contents: FileContents::Bytes(contents),
        }
    }

    /// Streams a prepared file into the publication without loading it into heap.
    /// The source must remain unchanged until publication returns. The staged
    /// bytes are checked against the publication digest before committing.
    pub fn from_file(name: &'a str, file: &'a fs::File) -> Self {
        Self {
            name,
            contents: FileContents::File(file),
        }
    }

    fn length(&self) -> io::Result<u64> {
        match self.contents {
            FileContents::Bytes(bytes) => Ok(bytes.len() as u64),
            FileContents::File(file) => file.metadata().map(|m| m.len()),
        }
    }

    fn visit(&self, mut visit: impl FnMut(&[u8]) -> io::Result<()>) -> io::Result<()> {
        match self.contents {
            FileContents::Bytes(bytes) => visit(bytes),
            FileContents::File(file) => {
                let length = file.metadata()?.len();
                let mut buffer = vec![0u8; 256 * 1024];
                let mut offset = 0u64;
                while offset < length {
                    let count = (length - offset).min(buffer.len() as u64) as usize;
                    read_exact_at(file, offset, &mut buffer[..count])?;
                    visit(&buffer[..count])?;
                    offset += count as u64;
                }
                Ok(())
            }
        }
    }
}

/// The manifest state a writer used while preparing its next snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExpectedCurrent {
    Empty,
    Snapshot(u64),
}

impl ExpectedCurrent {
    fn matches(self, current: Option<Manifest>) -> bool {
        match (self, current) {
            (Self::Empty, None) => true,
            (Self::Snapshot(expected), Some(current)) => expected == current.snapshot,
            _ => false,
        }
    }

    fn snapshot(self) -> Option<u64> {
        match self {
            Self::Empty => None,
            Self::Snapshot(snapshot) => Some(snapshot),
        }
    }
}

/// The commit state observed by a publication attempt.
#[derive(Debug)]
pub enum PublishOutcome {
    Published,
    AlreadyPublished,
    PublishedButDurabilityUnknown { source: io::Error },
}

/// Publication state plus any best-effort stale-generation cleanup failure.
#[derive(Debug)]
pub struct PublishReport {
    pub outcome: PublishOutcome,
    pub cleanup_error: Option<io::Error>,
}

/// A publication failure known to have happened before the manifest commit point.
#[derive(Debug)]
pub enum PublishError {
    Conflict { current: Option<u64> },
    BeforeCommit { source: io::Error },
}

impl fmt::Display for PublishError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict { current } => write!(
                formatter,
                "generation publication conflicts with current snapshot {current:?}"
            ),
            Self::BeforeCommit { source } => {
                write!(
                    formatter,
                    "generation publication failed before commit: {source}"
                )
            }
        }
    }
}

impl Error for PublishError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Conflict { .. } => None,
            Self::BeforeCommit { source } => Some(source),
        }
    }
}

/// Facts reported after removing stale manifests and unreferenced generation directories.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CleanupReport {
    pub manifests_removed: usize,
    pub layers_removed: usize,
    pub bases_removed: usize,
}

/// Owns immutable base generations, change-layer snapshots, manifests and process coordination.
#[derive(Clone, Debug)]
pub struct ImmutableGenerationStore {
    root: PathBuf,
}

impl ImmutableGenerationStore {
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let store = Self { root: root.into() };
        fs::create_dir_all(store.base_root())?;
        fs::create_dir_all(store.layer_root())?;
        fs::create_dir_all(store.manifest_root())?;
        store.open_lock()?;
        Ok(store)
    }

    pub fn open_current(&self) -> io::Result<Option<PublishedSnapshot>> {
        let lock = self.lock_shared()?;
        let Some(manifest) = self.latest_manifest()? else {
            return Ok(None);
        };
        let snapshot = self.open_snapshot(manifest)?;
        drop(lock);
        Ok(Some(snapshot))
    }

    pub fn publish_base(
        &self,
        expected_current: ExpectedCurrent,
        snapshot: u64,
        base_files: &[GenerationFile<'_>],
        layer_files: &[GenerationFile<'_>],
    ) -> Result<PublishReport, PublishError> {
        let _lock = self.lock_exclusive().map_err(before_commit)?;
        validate_files(base_files).map_err(before_commit)?;
        validate_files(layer_files).map_err(before_commit)?;
        let next = Manifest {
            snapshot,
            base: snapshot,
            previous: expected_current.snapshot(),
            content_digest: publication_digest(
                PublicationKind::Base,
                expected_current,
                snapshot,
                snapshot,
                base_files,
                layer_files,
            )
            .map_err(before_commit)?,
        };
        let current = self.latest_manifest().map_err(before_commit)?;
        if let Some(report) = self.resolve_existing_or_conflict(expected_current, current, next)? {
            return Ok(report);
        }

        let prepare = || -> io::Result<()> {
            self.remove_pending(snapshot)?;
            self.remove_unpublished_generation(&self.base_directory(snapshot))?;
            self.remove_unpublished_generation(&self.layer_directory(snapshot))?;
            let base = self.write_generation_directory(self.pending_base(snapshot), base_files)?;
            let layer =
                self.write_generation_directory(self.pending_layer(snapshot), layer_files)?;
            verify_staged_digest(
                PublicationKind::Base,
                expected_current,
                next,
                &base,
                &layer,
                base_files,
                layer_files,
            )?;
            reached_publish_stage(PublishStage::GenerationWritten);
            sync_directory(&base)?;
            sync_directory(&layer)?;
            reached_publish_stage(PublishStage::GenerationSynced);
            fs::rename(base, self.base_directory(snapshot))?;
            fs::rename(layer, self.layer_directory(snapshot))?;
            sync_directory(&self.base_root())?;
            sync_directory(&self.layer_root())?;
            self.write_pending_manifest(next)
        };
        if let Err(source) = prepare() {
            return Err(before_commit(self.discard_failed_base(snapshot, source)));
        }
        self.commit_manifest(next)
    }

    pub fn publish_layer(
        &self,
        expected_current: ExpectedCurrent,
        snapshot: u64,
        layer_files: &[GenerationFile<'_>],
    ) -> Result<PublishReport, PublishError> {
        let _lock = self.lock_exclusive().map_err(before_commit)?;
        validate_files(layer_files).map_err(before_commit)?;
        let current = self.latest_manifest().map_err(before_commit)?;
        let Some(current_manifest) = current else {
            return Err(before_commit(io::Error::new(
                io::ErrorKind::NotFound,
                "no base generation is published",
            )));
        };
        let next = Manifest {
            snapshot,
            base: current_manifest.base,
            previous: expected_current.snapshot(),
            content_digest: publication_digest(
                PublicationKind::Layer,
                expected_current,
                snapshot,
                current_manifest.base,
                &[],
                layer_files,
            )
            .map_err(before_commit)?,
        };
        if let Some(report) = self.resolve_existing_or_conflict(expected_current, current, next)? {
            return Ok(report);
        }

        let prepare = || -> io::Result<()> {
            self.remove_pending(snapshot)?;
            self.remove_unpublished_generation(&self.layer_directory(snapshot))?;
            let layer =
                self.write_generation_directory(self.pending_layer(snapshot), layer_files)?;
            verify_staged_digest(
                PublicationKind::Layer,
                expected_current,
                next,
                &layer,
                &layer,
                &[],
                layer_files,
            )?;
            reached_publish_stage(PublishStage::GenerationWritten);
            sync_directory(&layer)?;
            reached_publish_stage(PublishStage::GenerationSynced);
            fs::rename(layer, self.layer_directory(snapshot))?;
            sync_directory(&self.layer_root())?;
            self.write_pending_manifest(next)
        };
        if let Err(source) = prepare() {
            return Err(before_commit(self.discard_failed_layer(snapshot, source)));
        }
        self.commit_manifest(next)
    }

    pub fn cleanup_stale(&self) -> io::Result<CleanupReport> {
        let _lock = self.lock_exclusive()?;
        let current = self.latest_manifest()?;
        self.cleanup_stale_locked(current)
    }

    fn resolve_existing_or_conflict(
        &self,
        expected_current: ExpectedCurrent,
        current: Option<Manifest>,
        next: Manifest,
    ) -> Result<Option<PublishReport>, PublishError> {
        if let Some(current) = current.filter(|current| current.snapshot == next.snapshot) {
            if current == next {
                let outcome = match sync_directory(&self.manifest_root()) {
                    Ok(()) => PublishOutcome::AlreadyPublished,
                    Err(source) => PublishOutcome::PublishedButDurabilityUnknown { source },
                };
                let cleanup_error = matches!(outcome, PublishOutcome::AlreadyPublished)
                    .then(|| self.cleanup_stale_locked(Some(current)).err())
                    .flatten();
                return Ok(Some(PublishReport {
                    outcome,
                    cleanup_error,
                }));
            }
            return Err(PublishError::Conflict {
                current: Some(current.snapshot),
            });
        }
        if !expected_current.matches(current)
            || current.is_some_and(|current| next.snapshot <= current.snapshot)
        {
            return Err(PublishError::Conflict {
                current: current.map(|manifest| manifest.snapshot),
            });
        }
        Ok(None)
    }

    fn commit_manifest(&self, manifest: Manifest) -> Result<PublishReport, PublishError> {
        fs::rename(
            self.pending_manifest(manifest.snapshot),
            self.manifest_path(manifest.snapshot),
        )
        .map_err(before_commit)?;
        reached_publish_stage(PublishStage::ManifestRenamed);
        let outcome = match sync_directory(&self.manifest_root()) {
            Ok(()) => {
                reached_publish_stage(PublishStage::ManifestDirectorySynced);
                PublishOutcome::Published
            }
            Err(source) => PublishOutcome::PublishedButDurabilityUnknown { source },
        };
        let cleanup_error = matches!(outcome, PublishOutcome::Published)
            .then(|| self.cleanup_stale_locked(Some(manifest)).err())
            .flatten();
        Ok(PublishReport {
            outcome,
            cleanup_error,
        })
    }

    fn open_snapshot(&self, manifest: Manifest) -> io::Result<PublishedSnapshot> {
        let base_directory = self.base_directory(manifest.base);
        let layer_directory = self.layer_directory(manifest.snapshot);
        let base_lease = lock_generation(&base_directory)?;
        let layer_lease = lock_generation(&layer_directory)?;
        Ok(PublishedSnapshot {
            snapshot: manifest.snapshot,
            base: manifest.base,
            base_directory,
            layer_directory,
            base_lease,
            _layer_lease: layer_lease,
        })
    }

    fn write_generation_directory(
        &self,
        directory: PathBuf,
        files: &[GenerationFile<'_>],
    ) -> io::Result<PathBuf> {
        fs::create_dir(&directory)?;
        write_synced_file(&directory.join(LEASE_FILE), &[])?;
        for file in files {
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(directory.join(file.name))?;
            file.visit(|bytes| output.write_all(bytes))?;
            output.sync_all()?;
        }
        Ok(directory)
    }

    fn write_pending_manifest(&self, manifest: Manifest) -> io::Result<()> {
        let mut contents = Vec::with_capacity(MANIFEST_VERSION.len() + 57);
        contents.extend_from_slice(MANIFEST_VERSION);
        contents.extend_from_slice(&manifest.snapshot.to_le_bytes());
        contents.extend_from_slice(&manifest.base.to_le_bytes());
        contents.push(u8::from(manifest.previous.is_some()));
        contents.extend_from_slice(&manifest.previous.unwrap_or_default().to_le_bytes());
        contents.extend_from_slice(&manifest.content_digest);
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(self.pending_manifest(manifest.snapshot))?;
        file.write_all(&contents)?;
        reached_publish_stage(PublishStage::PendingManifestWritten);
        file.sync_all()?;
        reached_publish_stage(PublishStage::PendingManifestSynced);
        Ok(())
    }

    fn latest_manifest(&self) -> io::Result<Option<Manifest>> {
        let mut manifests = self.manifests()?;
        let Some((snapshot, path)) = manifests.pop_last() else {
            return Ok(None);
        };
        read_manifest(&path, snapshot).map(Some)
    }

    fn manifests(&self) -> io::Result<BTreeMap<u64, PathBuf>> {
        let mut manifests = BTreeMap::new();
        for entry in fs::read_dir(self.manifest_root())? {
            let entry = entry?;
            let Some(snapshot) = parse_manifest_name(&entry.file_name()) else {
                continue;
            };
            manifests.insert(snapshot, entry.path());
        }
        Ok(manifests)
    }

    fn cleanup_stale_locked(&self, current: Option<Manifest>) -> io::Result<CleanupReport> {
        let mut report = CleanupReport::default();
        let mut retained_layers = current
            .map(|manifest| BTreeSet::from([manifest.snapshot]))
            .unwrap_or_default();
        let mut retained_bases = current
            .map(|manifest| BTreeSet::from([manifest.base]))
            .unwrap_or_default();
        let mut removable_layers = Vec::new();

        for (snapshot, path) in self.manifests()? {
            if current.is_some_and(|current| snapshot == current.snapshot) {
                continue;
            }
            let manifest = read_manifest(&path, snapshot)?;
            let directory = self.layer_directory(snapshot);
            match try_lock_generation_exclusive(&directory)? {
                GenerationLock::Busy => {
                    retained_layers.insert(snapshot);
                    retained_bases.insert(manifest.base);
                }
                GenerationLock::Acquired(lease) => {
                    remove_file_if_present(&path)?;
                    report.manifests_removed += 1;
                    removable_layers.push((snapshot, directory, lease));
                }
            }
        }

        if report.manifests_removed > 0 {
            sync_directory(&self.manifest_root())?;
        }

        for (snapshot, directory, _lease) in removable_layers {
            if remove_directory_if_present(&directory)? {
                report.layers_removed += 1;
            }
            retained_layers.remove(&snapshot);
        }

        for entry in fs::read_dir(self.layer_root())? {
            let entry = entry?;
            let Some(snapshot) = parse_generation_name(&entry.file_name()) else {
                continue;
            };
            if retained_layers.contains(&snapshot) {
                continue;
            }
            if let GenerationLock::Acquired(_lease) = try_lock_generation_exclusive(&entry.path())?
                && remove_directory_if_present(&entry.path())?
            {
                report.layers_removed += 1;
            }
        }

        for entry in fs::read_dir(self.base_root())? {
            let entry = entry?;
            let Some(base) = parse_generation_name(&entry.file_name()) else {
                continue;
            };
            if retained_bases.contains(&base) {
                continue;
            }
            if let GenerationLock::Acquired(_lease) = try_lock_generation_exclusive(&entry.path())?
                && remove_directory_if_present(&entry.path())?
            {
                report.bases_removed += 1;
            }
        }

        if report.layers_removed > 0 {
            sync_directory(&self.layer_root())?;
        }
        if report.bases_removed > 0 {
            sync_directory(&self.base_root())?;
        }
        Ok(report)
    }

    fn remove_pending(&self, snapshot: u64) -> io::Result<()> {
        remove_directory_if_present(&self.pending_base(snapshot))?;
        remove_directory_if_present(&self.pending_layer(snapshot))?;
        remove_file_if_present(&self.pending_manifest(snapshot))?;
        Ok(())
    }

    fn discard_failed_base(&self, snapshot: u64, source: io::Error) -> io::Error {
        let cleanup = (|| -> io::Result<()> {
            self.remove_pending(snapshot)?;
            self.remove_unpublished_generation(&self.base_directory(snapshot))?;
            self.remove_unpublished_generation(&self.layer_directory(snapshot))?;
            sync_directory(&self.base_root())?;
            sync_directory(&self.layer_root())?;
            sync_directory(&self.manifest_root())
        })();
        combine_prepare_and_cleanup_errors(source, cleanup.err())
    }

    fn discard_failed_layer(&self, snapshot: u64, source: io::Error) -> io::Error {
        let cleanup = (|| -> io::Result<()> {
            self.remove_pending(snapshot)?;
            self.remove_unpublished_generation(&self.layer_directory(snapshot))?;
            sync_directory(&self.layer_root())?;
            sync_directory(&self.manifest_root())
        })();
        combine_prepare_and_cleanup_errors(source, cleanup.err())
    }

    fn remove_unpublished_generation(&self, directory: &Path) -> io::Result<()> {
        match try_lock_generation_exclusive(directory)? {
            GenerationLock::Acquired(_lease) => {
                remove_directory_if_present(directory)?;
                Ok(())
            }
            GenerationLock::Busy => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "unpublished generation is still leased",
            )),
        }
    }

    fn open_lock(&self) -> io::Result<fs::File> {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join(LOCK_FILE))
    }

    fn lock_shared(&self) -> io::Result<fs::File> {
        let file = self.open_lock()?;
        fs2::FileExt::lock_shared(&file)?;
        Ok(file)
    }

    fn lock_exclusive(&self) -> io::Result<fs::File> {
        let file = self.open_lock()?;
        fs2::FileExt::lock_exclusive(&file)?;
        Ok(file)
    }

    fn base_root(&self) -> PathBuf {
        self.root.join(BASES_DIRECTORY)
    }

    fn layer_root(&self) -> PathBuf {
        self.root.join(LAYERS_DIRECTORY)
    }

    fn manifest_root(&self) -> PathBuf {
        self.root.join(MANIFESTS_DIRECTORY)
    }

    fn base_directory(&self, generation: u64) -> PathBuf {
        self.base_root().join(generation_name(generation))
    }

    fn layer_directory(&self, generation: u64) -> PathBuf {
        self.layer_root().join(generation_name(generation))
    }

    fn pending_base(&self, generation: u64) -> PathBuf {
        self.base_root()
            .join(format!(".pending-{}", generation_name(generation)))
    }

    fn pending_layer(&self, generation: u64) -> PathBuf {
        self.layer_root()
            .join(format!(".pending-{}", generation_name(generation)))
    }

    fn manifest_path(&self, generation: u64) -> PathBuf {
        self.manifest_root()
            .join(format!("{}.manifest", generation_name(generation)))
    }

    fn pending_manifest(&self, generation: u64) -> PathBuf {
        self.manifest_root()
            .join(format!(".pending-{}.manifest", generation_name(generation)))
    }
}

fn combine_prepare_and_cleanup_errors(source: io::Error, cleanup: Option<io::Error>) -> io::Error {
    let Some(cleanup) = cleanup else {
        return source;
    };
    io::Error::new(
        source.kind(),
        format!("{source}; removing the unpublished generation also failed: {cleanup}"),
    )
}

/// A consistent base generation and change-layer snapshot selected under the store lock.
pub struct PublishedSnapshot {
    snapshot: u64,
    base: u64,
    base_directory: PathBuf,
    layer_directory: PathBuf,
    base_lease: Arc<GenerationLease>,
    _layer_lease: Arc<GenerationLease>,
}

impl PublishedSnapshot {
    pub fn generation(&self) -> u64 {
        self.snapshot
    }

    pub fn base_generation(&self) -> u64 {
        self.base
    }

    pub fn read_base(&self, name: &str) -> io::Result<Vec<u8>> {
        validate_name(name)?;
        fs::read(self.base_directory.join(name))
    }

    pub fn read_layer(&self, name: &str) -> io::Result<Vec<u8>> {
        validate_name(name)?;
        fs::read(self.layer_directory.join(name))
    }

    pub fn open_base(&self, name: &str) -> io::Result<OpenGenerationFile> {
        validate_name(name)?;
        let file = fs::File::open(self.base_directory.join(name))?;
        Ok(OpenGenerationFile::new(file, Arc::clone(&self.base_lease)))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Manifest {
    snapshot: u64,
    base: u64,
    previous: Option<u64>,
    content_digest: [u8; 32],
}

#[derive(Clone, Copy)]
enum PublicationKind {
    Base = 1,
    Layer = 2,
}

enum GenerationLock {
    Acquired(Option<fs::File>),
    Busy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublishStage {
    GenerationWritten,
    GenerationSynced,
    PendingManifestWritten,
    PendingManifestSynced,
    ManifestRenamed,
    ManifestDirectorySynced,
}

#[cfg(test)]
fn reached_publish_stage(stage: PublishStage) {
    let Some(configured) = std::env::var_os("ASH_IMMUTABLE_STORE_ABORT_STAGE") else {
        return;
    };
    if configured == stage.name() {
        std::process::abort();
    }
}

#[cfg(not(test))]
fn reached_publish_stage(_stage: PublishStage) {}

#[cfg(test)]
impl PublishStage {
    fn name(self) -> &'static str {
        match self {
            Self::GenerationWritten => "generation-written",
            Self::GenerationSynced => "generation-synced",
            Self::PendingManifestWritten => "pending-manifest-written",
            Self::PendingManifestSynced => "pending-manifest-synced",
            Self::ManifestRenamed => "manifest-renamed",
            Self::ManifestDirectorySynced => "manifest-directory-synced",
        }
    }
}

fn publication_digest(
    kind: PublicationKind,
    expected_current: ExpectedCurrent,
    snapshot: u64,
    base: u64,
    base_files: &[GenerationFile<'_>],
    layer_files: &[GenerationFile<'_>],
) -> io::Result<[u8; 32]> {
    let mut digest = Sha256::new();
    digest.update(MANIFEST_VERSION);
    digest.update([kind as u8]);
    digest.update([u8::from(expected_current.snapshot().is_some())]);
    digest.update(
        expected_current
            .snapshot()
            .unwrap_or_default()
            .to_le_bytes(),
    );
    digest.update(snapshot.to_le_bytes());
    digest.update(base.to_le_bytes());
    update_files_digest(&mut digest, 1, base_files)?;
    update_files_digest(&mut digest, 2, layer_files)?;
    Ok(digest.finalize().into())
}

fn update_files_digest(
    digest: &mut Sha256,
    role: u8,
    files: &[GenerationFile<'_>],
) -> io::Result<()> {
    let mut files = files.iter().collect::<Vec<_>>();
    files.sort_unstable_by_key(|file| file.name);
    digest.update([role]);
    digest.update((files.len() as u64).to_le_bytes());
    for file in files {
        digest.update((file.name.len() as u64).to_le_bytes());
        digest.update(file.name.as_bytes());
        digest.update(file.length()?.to_le_bytes());
        file.visit(|bytes| {
            digest.update(bytes);
            Ok(())
        })?;
    }
    Ok(())
}

fn verify_staged_digest(
    kind: PublicationKind,
    expected: ExpectedCurrent,
    next: Manifest,
    base: &Path,
    layer: &Path,
    base_files: &[GenerationFile<'_>],
    layer_files: &[GenerationFile<'_>],
) -> io::Result<()> {
    if !base_files
        .iter()
        .chain(layer_files)
        .any(|f| matches!(f.contents, FileContents::File(_)))
    {
        return Ok(());
    }
    let open = |root: &Path, files: &[GenerationFile<'_>]| {
        files
            .iter()
            .map(|f| fs::File::open(root.join(f.name)))
            .collect::<io::Result<Vec<_>>>()
    };
    let base_handles = open(base, base_files)?;
    let layer_handles = open(layer, layer_files)?;
    let staged_base = base_files
        .iter()
        .zip(&base_handles)
        .map(|(f, h)| GenerationFile::from_file(f.name, h))
        .collect::<Vec<_>>();
    let staged_layer = layer_files
        .iter()
        .zip(&layer_handles)
        .map(|(f, h)| GenerationFile::from_file(f.name, h))
        .collect::<Vec<_>>();
    let actual = publication_digest(
        kind,
        expected,
        next.snapshot,
        next.base,
        &staged_base,
        &staged_layer,
    )?;
    if actual != next.content_digest {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "generation input changed while being published",
        ));
    }
    Ok(())
}

fn before_commit(source: io::Error) -> PublishError {
    PublishError::BeforeCommit { source }
}

fn lock_generation(directory: &Path) -> io::Result<Arc<GenerationLease>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join(LEASE_FILE))?;
    fs2::FileExt::lock_shared(&file)?;
    Ok(Arc::new(GenerationLease { _file: file }))
}

fn try_lock_generation_exclusive(directory: &Path) -> io::Result<GenerationLock> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join(LEASE_FILE))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(GenerationLock::Acquired(None));
        }
        Err(error) => return Err(error),
    };
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(GenerationLock::Acquired(Some(file))),
        Err(error) if is_lock_contention(&error) => Ok(GenerationLock::Busy),
        Err(error) => Err(error),
    }
}

fn is_lock_contention(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // LockFileEx reports overlapping locks held by this process as ERROR_LOCK_VIOLATION.
        return error.raw_os_error() == Some(33);
    }
    #[cfg(not(windows))]
    false
}

fn validate_files(files: &[GenerationFile<'_>]) -> io::Result<()> {
    let mut names = BTreeSet::new();
    for file in files {
        validate_name(file.name)?;
        if !names.insert(file.name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "generation file names must be unique",
            ));
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> io::Result<()> {
    let mut components = Path::new(name).components();
    if name == LEASE_FILE
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "generation file name must be one normal path component",
        ));
    }
    Ok(())
}

fn read_manifest(path: &Path, expected_snapshot: u64) -> io::Result<Manifest> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.read_to_end(&mut bytes)?;
    if bytes.len() != MANIFEST_VERSION.len() + 57 || !bytes.starts_with(MANIFEST_VERSION) {
        return Err(corrupt_manifest());
    }
    let snapshot = read_u64(&bytes, MANIFEST_VERSION.len()).ok_or_else(corrupt_manifest)?;
    let base = read_u64(&bytes, MANIFEST_VERSION.len() + 8).ok_or_else(corrupt_manifest)?;
    let previous_value =
        read_u64(&bytes, MANIFEST_VERSION.len() + 17).ok_or_else(corrupt_manifest)?;
    let previous = match bytes.get(MANIFEST_VERSION.len() + 16) {
        Some(0) if previous_value == 0 => None,
        Some(1) => Some(previous_value),
        _ => return Err(corrupt_manifest()),
    };
    let content_digest = bytes
        .get(MANIFEST_VERSION.len() + 25..MANIFEST_VERSION.len() + 57)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(corrupt_manifest)?;
    if snapshot != expected_snapshot
        || base > snapshot
        || previous.is_some_and(|previous| previous >= snapshot)
    {
        return Err(corrupt_manifest());
    }
    Ok(Manifest {
        snapshot,
        base,
        previous,
        content_digest,
    })
}

fn corrupt_manifest() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "generation manifest is corrupt")
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?,
    ))
}

fn write_synced_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?
        .sync_all()
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory durability is unsupported on this platform",
    ))
}

fn remove_directory_if_present(path: &Path) -> io::Result<bool> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_file_if_present(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
