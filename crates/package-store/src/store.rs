use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use fs2::FileExt;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

const LEASE_FILE: &str = ".lease";
const LOCK_FILE: &str = "store.lock";
const MANIFESTS_DIRECTORY: &str = "manifests";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const METADATA_FILE: &str = "ash-package.json";
const PACKAGES_DIRECTORY: &str = "packages";
const RETAINED_PACKAGES: usize = 2;
const SHA256_PREFIX: &str = "sha256:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIdentity {
    pub version: String,
    pub target: String,
    pub runtime_kind: String,
    pub build_profile: String,
    pub build_id: String,
}

#[derive(Debug)]
pub struct PublishedPackage {
    pub package_root: PathBuf,
    pub sequence: u64,
    pub cleanup_error: Option<io::Error>,
}

#[derive(Debug)]
pub struct PackageLease {
    _file: File,
}

#[derive(Clone, Debug)]
pub struct PackageStore {
    root: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    sequence: u64,
    package: PackageIdentity,
    directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageMetadata {
    build_id: String,
    build_profile: String,
    files: BTreeMap<String, String>,
    javascript_runtime: JavaScriptRuntime,
    protocol: ProtocolIdentity,
    target: String,
    version: String,
}

#[derive(Deserialize)]
struct JavaScriptRuntime {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolIdentity {
    major: u64,
    schema_hash: String,
}

impl PackageStore {
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let store = Self { root: root.into() };
        fs::create_dir_all(store.manifest_root())?;
        fs::create_dir_all(store.package_root())?;
        require_real_directory(&store.root)?;
        require_real_directory(&store.manifest_root())?;
        require_real_directory(&store.package_root())?;
        store.open_store_lock()?;
        Ok(store)
    }

    pub fn current(&self) -> io::Result<Option<PublishedPackage>> {
        let _lock = self.lock_store_shared()?;
        self.latest_manifest()?
            .map(|manifest| self.published(manifest))
            .transpose()
    }

    pub fn publish(&self, staging: impl AsRef<Path>) -> io::Result<PublishedPackage> {
        let staging = staging.as_ref();
        let metadata = validate_package(staging)?;
        let identity = package_identity(&metadata);
        let build = identity
            .build_id
            .strip_prefix(SHA256_PREFIX)
            .ok_or_else(|| invalid("package buildId is not a SHA-256 identity"))?
            .to_string();
        let _lock = self.lock_store_exclusive()?;
        self.remove_pending_manifests()?;
        if let Some(current) = self.latest_manifest()?
            && current.package == identity
        {
            remove_directory_if_present(staging)?;
            let mut published = self.published(current)?;
            published.cleanup_error = self.cleanup_stale().err();
            return Ok(published);
        }

        let version_root = self.package_root().join(&identity.version);
        fs::create_dir_all(&version_root)?;
        require_real_directory(&version_root)?;
        let package_root = version_root.join(&build);
        if package_root.exists() {
            let existing = validate_package(&package_root)?;
            if package_identity(&existing) != identity {
                return Err(invalid(
                    "package directory identity conflicts with its contents",
                ));
            }
            remove_directory_if_present(staging)?;
        } else {
            write_synced_file(&staging.join(LEASE_FILE), &[])
                .map_err(|error| context("write package lease", error))?;
            sync_directory(staging).map_err(|error| context("sync staging package", error))?;
            fs::rename(staging, &package_root)
                .map_err(|error| context("commit package directory", error))?;
            sync_directory(&version_root)
                .map_err(|error| context("sync package directory", error))?;
        }

        let sequence = self
            .latest_manifest()?
            .map(|manifest| {
                manifest
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| invalid("package manifest sequence is exhausted"))
            })
            .transpose()?
            .unwrap_or(1);
        let version = identity.version.clone();
        let manifest = Manifest {
            format_version: 1,
            sequence,
            package: identity,
            directory: format!("{PACKAGES_DIRECTORY}/{version}/{build}"),
        };
        self.commit_manifest(&manifest)?;
        let cleanup_error = self.cleanup_stale().err();
        Ok(PublishedPackage {
            package_root,
            sequence,
            cleanup_error,
        })
    }

    fn commit_manifest(&self, manifest: &Manifest) -> io::Result<()> {
        let path = self.manifest_path(manifest.sequence);
        let pending = path.with_extension("json.pending");
        let contents = serde_json::to_vec_pretty(manifest).map_err(invalid)?;
        write_synced_file(&pending, &contents)?;
        fs::rename(&pending, &path)?;
        sync_directory(&self.manifest_root())
    }

    fn cleanup_stale(&self) -> io::Result<()> {
        self.remove_pending_manifests()?;
        let manifests = self.manifests()?;
        let retained = manifests
            .keys()
            .rev()
            .take(RETAINED_PACKAGES)
            .copied()
            .collect::<BTreeSet<_>>();
        let mut retained_directories = BTreeSet::new();
        for sequence in &retained {
            let manifest = read_manifest(&manifests[sequence], *sequence)?;
            retained_directories.insert(manifest.directory);
        }
        for (sequence, path) in manifests {
            if retained.contains(&sequence) {
                continue;
            }
            let manifest = read_manifest(&path, sequence)?;
            if retained_directories.contains(&manifest.directory) {
                fs::remove_file(&path)?;
                continue;
            }
            let package = self.root.join(&manifest.directory);
            let Some(_lease) = PackageLease::try_exclusive(&package)? else {
                continue;
            };
            fs::remove_file(&path)?;
            remove_directory_if_present(&package)?;
        }
        let referenced = self
            .manifests()?
            .into_iter()
            .map(|(sequence, path)| {
                read_manifest(&path, sequence).map(|manifest| manifest.directory)
            })
            .collect::<io::Result<BTreeSet<_>>>()?;
        for version in fs::read_dir(self.package_root())? {
            let version = version?;
            if !version.file_type()?.is_dir() {
                continue;
            }
            let version_name = version.file_name().to_string_lossy().into_owned();
            for entry in fs::read_dir(version.path())? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let directory = format!("{PACKAGES_DIRECTORY}/{version_name}/{name}");
                if !is_sha256(&name) || referenced.contains(&directory) {
                    continue;
                }
                let package = entry.path();
                if let Some(_lease) = PackageLease::try_exclusive(&package)? {
                    remove_directory_if_present(&package)?;
                }
            }
            remove_empty_directory(&version.path())?;
        }
        sync_directory(&self.manifest_root())?;
        sync_directory(&self.package_root())
    }

    fn remove_pending_manifests(&self) -> io::Result<()> {
        for entry in fs::read_dir(self.manifest_root())? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let name = name.as_bytes();
            if name.len() == 33
                && &name[20..] == b".json.pending"
                && name[..20].iter().all(u8::is_ascii_digit)
            {
                fs::remove_file(entry.path())?;
            }
        }
        sync_directory(&self.manifest_root())
    }

    fn published(&self, manifest: Manifest) -> io::Result<PublishedPackage> {
        let package_root = self.root.join(&manifest.directory);
        require_real_directory(&package_root)?;
        Ok(PublishedPackage {
            package_root,
            sequence: manifest.sequence,
            cleanup_error: None,
        })
    }

    fn latest_manifest(&self) -> io::Result<Option<Manifest>> {
        let manifests = self.manifests()?;
        let Some((&sequence, path)) = manifests.last_key_value() else {
            return Ok(None);
        };
        read_manifest(path, sequence).map(Some)
    }

    fn manifests(&self) -> io::Result<BTreeMap<u64, PathBuf>> {
        let mut manifests = BTreeMap::new();
        for entry in fs::read_dir(self.manifest_root())? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(sequence) = name.strip_suffix(".json").and_then(|name| {
                (name.len() == 20)
                    .then(|| name.parse::<u64>().ok())
                    .flatten()
            }) else {
                continue;
            };
            manifests.insert(sequence, entry.path());
        }
        Ok(manifests)
    }

    fn manifest_path(&self, sequence: u64) -> PathBuf {
        self.manifest_root().join(format!("{sequence:020}.json"))
    }

    fn manifest_root(&self) -> PathBuf {
        self.root.join(MANIFESTS_DIRECTORY)
    }

    fn package_root(&self) -> PathBuf {
        self.root.join(PACKAGES_DIRECTORY)
    }

    fn open_store_lock(&self) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join(LOCK_FILE))
    }

    fn lock_store_shared(&self) -> io::Result<File> {
        let file = self.open_store_lock()?;
        FileExt::lock_shared(&file)?;
        Ok(file)
    }

    fn lock_store_exclusive(&self) -> io::Result<File> {
        let file = self.open_store_lock()?;
        FileExt::lock_exclusive(&file)?;
        Ok(file)
    }
}

impl PackageLease {
    pub fn acquire(package_root: impl AsRef<Path>) -> io::Result<Self> {
        let file = open_lease(&package_root.as_ref().join(LEASE_FILE))?;
        FileExt::lock_shared(&file)?;
        Ok(Self { _file: file })
    }

    fn try_exclusive(package_root: &Path) -> io::Result<Option<Self>> {
        let file = open_lease(&package_root.join(LEASE_FILE))?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(error) if is_lock_contention(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

pub fn acquire_package_lease_for_executable(
    executable: impl AsRef<Path>,
) -> io::Result<Option<PackageLease>> {
    let executable = fs::canonicalize(executable)?;
    let Some(package_root) = executable.parent().and_then(Path::parent) else {
        return Ok(None);
    };
    let lease = package_root.join(LEASE_FILE);
    if !lease.exists() {
        return Ok(None);
    }
    PackageLease::acquire(package_root).map(Some)
}

fn package_identity(metadata: &PackageMetadata) -> PackageIdentity {
    PackageIdentity {
        version: metadata.version.clone(),
        target: metadata.target.clone(),
        runtime_kind: metadata.javascript_runtime.kind.clone(),
        build_profile: metadata.build_profile.clone(),
        build_id: metadata.build_id.clone(),
    }
}

fn validate_package(root: &Path) -> io::Result<PackageMetadata> {
    require_real_directory(root)?;
    let metadata_bytes = read_bounded_file(&root.join(METADATA_FILE), MAX_METADATA_BYTES)?;
    let metadata: PackageMetadata = serde_json::from_slice(&metadata_bytes).map_err(invalid)?;
    let mut identity: Value = serde_json::from_slice(&metadata_bytes).map_err(invalid)?;
    let fields = identity
        .as_object_mut()
        .ok_or_else(|| invalid("package metadata is not an object"))?;
    fields.remove("buildId");
    fields.remove("files");
    validate_version(&metadata.version)?;
    validate_segment(&metadata.target, "target")?;
    validate_segment(&metadata.javascript_runtime.kind, "runtime kind")?;
    validate_segment(&metadata.build_profile, "build profile")?;
    if metadata.protocol.major == 0 || metadata.protocol.major > u64::from(u32::MAX) {
        return Err(invalid("package protocol version is invalid"));
    }
    let schema_hash = metadata.protocol.schema_hash.strip_prefix(SHA256_PREFIX);
    if schema_hash.is_none_or(|hash| hash.len() != 64)
        || !schema_hash
            .unwrap_or_default()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid("package protocol schema hash is invalid"));
    }
    let files = regular_files(root)?;
    let expected = metadata.files.keys().cloned().collect::<BTreeSet<_>>();
    let observed = files.keys().cloned().collect::<BTreeSet<_>>();
    if expected != observed {
        return Err(invalid(
            "package file manifest does not match the directory",
        ));
    }
    for (path, file) in &files {
        let digest = file_sha256(file)?;
        if metadata.files.get(path) != Some(&digest) {
            return Err(invalid(format!(
                "package file digest does not match: {path}"
            )));
        }
    }
    let expected_build_id = package_build_id(identity, &metadata.files)?;
    if metadata.build_id != expected_build_id {
        return Err(invalid(
            "package build identity does not match its complete file manifest",
        ));
    }
    Ok(metadata)
}

fn package_build_id(mut identity: Value, files: &BTreeMap<String, String>) -> io::Result<String> {
    let mut digest = Sha256::new();
    digest.update(b"ash-package-build-v2\0");
    identity.sort_all_objects();
    digest.update(serde_json::to_vec(&identity).map_err(invalid)?);
    digest.update(b"\0");
    for (path, file_digest) in files {
        update_field(&mut digest, path);
        update_field(&mut digest, file_digest);
    }
    Ok(format!("{SHA256_PREFIX}{:x}", digest.finalize()))
}

fn update_field(digest: &mut Sha256, value: &str) {
    digest.update(value.as_bytes());
    digest.update(b"\0");
}

fn regular_files(root: &Path) -> io::Result<BTreeMap<String, PathBuf>> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut BTreeMap<String, PathBuf>,
    ) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(invalid(format!(
                    "package contains a symbolic path: {}",
                    path.display()
                )));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file() {
                let relative = path.strip_prefix(root).map_err(invalid)?;
                if relative == Path::new(METADATA_FILE) || relative == Path::new(LEASE_FILE) {
                    continue;
                }
                if relative
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
                {
                    return Err(invalid("package file path is not canonical"));
                }
                files.insert(relative.to_string_lossy().replace('\\', "/"), path);
            } else {
                return Err(invalid(format!(
                    "package contains an unsupported file: {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn file_sha256(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn read_bounded_file(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err(invalid(format!(
            "file is not a bounded regular file: {}",
            path.display()
        )));
    }
    fs::read(path)
}

fn require_real_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid(format!(
            "path is not a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn read_manifest(path: &Path, sequence: u64) -> io::Result<Manifest> {
    let manifest: Manifest =
        serde_json::from_slice(&read_bounded_file(path, MAX_MANIFEST_BYTES)?).map_err(invalid)?;
    validate_version(&manifest.package.version)?;
    validate_segment(&manifest.package.target, "target")?;
    validate_segment(&manifest.package.runtime_kind, "runtime kind")?;
    validate_segment(&manifest.package.build_profile, "build profile")?;
    let expected_directory = manifest
        .package
        .build_id
        .strip_prefix(SHA256_PREFIX)
        .filter(|build| is_sha256(build))
        .map(|build| format!("{PACKAGES_DIRECTORY}/{}/{build}", manifest.package.version));
    if manifest.format_version != 1
        || manifest.sequence != sequence
        || expected_directory.as_deref() != Some(&manifest.directory)
    {
        return Err(invalid("package manifest is invalid"));
    }
    Ok(manifest)
}

fn validate_segment(value: &str, name: &str) -> io::Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(invalid(format!("package {name} is invalid")));
    }
    Ok(())
}

fn validate_version(value: &str) -> io::Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
        || !value.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(invalid("package version is invalid"));
    }
    Ok(())
}

fn remove_empty_directory(path: &Path) -> io::Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == io::ErrorKind::DirectoryNotEmpty
                || error.kind() == io::ErrorKind::NotFound =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn write_synced_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

fn remove_directory_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn open_lease(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;

    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

#[cfg(not(windows))]
fn open_lease(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).write(true).open(path)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory durability is unsupported on this platform",
    ))
}

fn invalid(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn context(operation: &str, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{operation}: {error}"))
}

fn is_lock_contention(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock || cfg!(windows) && error.raw_os_error() == Some(33)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
