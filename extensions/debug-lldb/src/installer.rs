//! Runtime acquisition belongs to this provider. Shared HTTP supplies transport,
//! while the existing Debug process broker remains the sole adapter launcher.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::num::NonZeroUsize;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

use ash_async_utils::CancellationId;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpBodySink;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::RedirectPolicy;
use ash_http_client::ReqwestHttpClient;
use ash_http_client::ResponseBodyLimit;
use ash_http_client::Timeout;
use ash_http_client::TransportTimeouts;
use external_ext_sdk::window::OutputChannel;
use external_ext_sdk::window::StatusBar;
use external_ext_sdk::window::StatusBarAlignment;
use external_ext_sdk::window::StatusBarCommand;
use external_ext_sdk::window::StatusBarEntry;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use url::Url;

use crate::Messages;

const MAX_DOWNLOAD: usize = 100 * 1024 * 1024;
const MAX_UNPACKED: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 30_000;
const MARKER: &str = "ash-runtime.json";
pub(crate) const INSTALL_COMMAND: &str = "ash.debug-lldb.install";
pub(crate) const CANCEL_COMMAND: &str = "ash.debug-lldb.cancelInstall";

#[derive(Clone, Debug)]
pub(crate) enum InstallError {
    Cancelled,
    Unsupported,
    Busy,
    Integrity,
    Failed(String),
}

impl From<std::io::Error> for InstallError {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    artifacts: BTreeMap<String, ArtifactHash>,
}

#[derive(Deserialize)]
struct ArtifactHash {
    sha256: String,
}

#[derive(Clone)]
pub(crate) struct Artifact {
    pub(crate) version: String,
    pub(crate) platform: String,
    pub(crate) sha256: String,
    pub(crate) url: String,
}

impl Artifact {
    pub(crate) fn current() -> Result<Self, InstallError> {
        let manifest: Manifest = serde_json::from_str(include_str!("../runtime.json"))
            .map_err(|error| InstallError::Failed(error.to_string()))?;
        let os = match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            "linux" => "linux",
            _ => return Err(InstallError::Unsupported),
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return Err(InstallError::Unsupported),
        };
        let platform = format!("{os}-{arch}");
        let hash = manifest
            .artifacts
            .get(&platform)
            .ok_or(InstallError::Unsupported)?;
        Ok(Self {
            url: format!(
                "https://github.com/vadimcn/codelldb/releases/download/v{}/codelldb-{platform}.vsix",
                manifest.version
            ),
            version: manifest.version,
            platform,
            sha256: hash.sha256.clone(),
        })
    }

    fn executable(&self) -> &'static str {
        if self.platform.starts_with("win32-") {
            "extension/adapter/codelldb.exe"
        } else {
            "extension/adapter/codelldb"
        }
    }

    fn library(&self) -> &'static str {
        if self.platform.starts_with("win32-") {
            "extension/lldb/bin/liblldb.dll"
        } else if self.platform.starts_with("darwin-") {
            "extension/lldb/lib/liblldb.dylib"
        } else {
            "extension/lldb/lib/liblldb.so"
        }
    }
}

enum State {
    Idle,
    Installing {
        root: PathBuf,
        cancellation: CancellationSource,
        lifetime: Lifetime,
        waiters: usize,
    },
    Ready {
        root: PathBuf,
        executable: PathBuf,
    },
    Failed {
        root: PathBuf,
        error: InstallError,
    },
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Lifetime {
    Manual,
    Launches,
}

struct LaunchWaiter {
    installer: Arc<Installer>,
    job: Option<CancellationId>,
}

impl Drop for LaunchWaiter {
    fn drop(&mut self) {
        let mut state = self
            .installer
            .state
            .lock()
            .expect("installer state is not poisoned");
        if let State::Installing {
            cancellation,
            lifetime,
            waiters,
            ..
        } = &mut *state
            && self.job == Some(cancellation.id())
        {
            *waiters = waiters.saturating_sub(1);
            if *waiters == 0 && *lifetime == Lifetime::Launches {
                cancellation.cancel();
            }
        }
    }
}

/// One window's preparation lifetime. A filesystem lock coordinates other windows
/// and processes without sharing their editor state or cancellation authority.
pub(crate) struct Installer {
    state: Mutex<State>,
    changed: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
    status: StatusBar,
    output: OutputChannel,
    messages: Messages,
}

impl Installer {
    pub(crate) fn new(status: StatusBar, output: OutputChannel, messages: Messages) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::Idle),
            changed: Condvar::new(),
            worker: Mutex::new(None),
            status,
            output,
            messages,
        })
    }

    pub(crate) fn start(self: &Arc<Self>, root: PathBuf) -> Result<(), InstallError> {
        self.begin(root, Lifetime::Manual).map(|_| ())
    }

    fn begin(
        self: &Arc<Self>,
        root: PathBuf,
        owner: Lifetime,
    ) -> Result<Option<CancellationId>, InstallError> {
        let mut worker = self
            .worker
            .lock()
            .expect("installer worker is not poisoned");
        {
            let mut state = self.state.lock().expect("installer state is not poisoned");
            match &mut *state {
                State::Installing {
                    root: current,
                    cancellation,
                    lifetime,
                    waiters,
                } if *current == root => {
                    match owner {
                        Lifetime::Manual => *lifetime = Lifetime::Manual,
                        Lifetime::Launches => *waiters += 1,
                    }
                    return Ok(Some(cancellation.id()));
                }
                State::Installing { .. } => return Err(InstallError::Busy),
                State::Ready {
                    root: current,
                    executable,
                } if *current == root
                    && executable.is_file()
                    && runtime_library_exists(executable) =>
                {
                    return Ok(None);
                }
                State::Idle | State::Ready { .. } | State::Failed { .. } => {}
            }
        }
        if let Some(previous) = worker.take() {
            let _ = previous.join();
        }
        let source = CancellationSource::new();
        let job = source.id();
        *self.state.lock().expect("installer state is not poisoned") = State::Installing {
            root: root.clone(),
            cancellation: source.clone(),
            lifetime: owner,
            waiters: match owner {
                Lifetime::Manual => 0,
                Lifetime::Launches => 1,
            },
        };
        let this = Arc::clone(self);
        *worker = Some(std::thread::spawn(move || {
            let result = Artifact::current().and_then(|artifact| {
                prepare_runtime(
                    &root,
                    &artifact,
                    &DownloadClient::default(),
                    &source.token(),
                    &|progress| this.report(progress),
                )
            });
            match &result {
                Ok(_) => {
                    let _ = this.status.set_entries(Vec::new());
                    let _ = this.output.append_line(&this.messages.installed);
                }
                Err(InstallError::Cancelled) => {
                    let _ = this.status.set_entries(Vec::new());
                    let _ = this.output.append_line(&this.messages.cancelled);
                }
                Err(error) => {
                    let message = this.messages.install_error(error).message;
                    let _ = this.output.append_line(&message);
                    let _ = this.status.set_entries(vec![this.entry(
                        this.messages.retry.clone(),
                        message,
                        INSTALL_COMMAND,
                    )]);
                }
            }
            *this.state.lock().expect("installer state is not poisoned") = match result {
                Ok(executable) => State::Ready { root, executable },
                Err(error) => State::Failed { root, error },
            };
            this.changed.notify_all();
        }));
        Ok(Some(job))
    }

    pub(crate) fn ensure(
        self: &Arc<Self>,
        root: PathBuf,
        token: &external_ext_sdk::CancellationToken,
    ) -> Result<PathBuf, external_ext_sdk::ExtensionError> {
        let job = self
            .begin(root.clone(), Lifetime::Launches)
            .map_err(|error| self.messages.install_error(&error))?;
        // Only the last waiting launch cancels its preparation. An explicit
        // pre-download command has an independent activation-owned lifetime.
        let _waiter = LaunchWaiter {
            installer: Arc::clone(self),
            job,
        };
        loop {
            if let Err(error) = token.check_cancelled() {
                return Err(error);
            }
            let state = self.state.lock().expect("installer state is not poisoned");
            match &*state {
                State::Ready {
                    root: current,
                    executable,
                } if *current == root => return Ok(executable.clone()),
                State::Failed {
                    root: current,
                    error,
                } if *current == root => return Err(self.messages.install_error(error)),
                State::Installing { root: current, .. } if *current == root => {
                    drop(
                        self.changed
                            .wait_timeout(state, Duration::from_millis(50))
                            .expect("installer state is not poisoned"),
                    );
                }
                State::Idle
                | State::Installing { .. }
                | State::Ready { .. }
                | State::Failed { .. } => {
                    return Err(self.messages.install_error(&InstallError::Busy));
                }
            }
        }
    }

    pub(crate) fn cancel(&self) {
        if let State::Installing { cancellation, .. } =
            &*self.state.lock().expect("installer state is not poisoned")
        {
            cancellation.cancel();
        }
    }

    pub(crate) fn shutdown(&self) {
        self.cancel();
        if let Some(worker) = self
            .worker
            .lock()
            .expect("installer worker is not poisoned")
            .take()
        {
            let _ = worker.join();
        }
    }

    fn report(&self, progress: Progress) {
        let text = match progress {
            Progress::Waiting => self.messages.waiting.clone(),
            Progress::Downloading(bytes) => self
                .messages
                .downloading
                .replace("{0}", &format!("{:.1}", bytes as f64 / 1048576.0)),
            Progress::Verifying => self.messages.verifying.clone(),
            Progress::Unpacking => self.messages.unpacking.clone(),
        };
        let _ = self.status.set_entries(vec![self.entry(
            text.clone(),
            self.messages.cancel_hint.clone(),
            CANCEL_COMMAND,
        )]);
        let _ = self.output.append_line(text);
    }

    fn entry(&self, text: String, tooltip: String, command: &str) -> StatusBarEntry {
        StatusBarEntry {
            id: "lldb.install".into(),
            aria_label: Some(format!("{text}. {tooltip}")),
            text,
            tooltip: Some(tooltip),
            alignment: StatusBarAlignment::Left,
            priority: 100.into(),
            command: Some(StatusBarCommand {
                command: command.into(),
                arguments: Vec::new(),
            }),
        }
    }
}

fn runtime_library_exists(executable: &Path) -> bool {
    Artifact::current().ok().is_some_and(|artifact| {
        executable
            .parent()
            .and_then(Path::parent)
            .is_some_and(|extension| {
                extension
                    .join(
                        artifact
                            .library()
                            .strip_prefix("extension/")
                            .expect("library is package-relative"),
                    )
                    .is_file()
            })
    })
}

#[derive(Clone, Copy)]
pub(crate) enum Progress {
    Waiting,
    Downloading(u64),
    Verifying,
    Unpacking,
}

/// Cache hits never initialize network or proxy configuration. This is also
/// used by the executable's development/offline preparation entry point.
#[derive(Default)]
pub(crate) struct DownloadClient(OnceLock<Result<ReqwestHttpClient, HttpClientError>>);

impl DownloadClient {
    fn client(&self) -> Result<&ReqwestHttpClient, HttpClientError> {
        self.0
            .get_or_init(|| {
                let network = OutboundNetworkSnapshot::new(
                    HttpClientConfig::new()
                        .with_redirect_policy(RedirectPolicy::Reject)
                        .with_streaming_response_body_limit(
                            ResponseBodyLimit::new(NonZeroUsize::new(MAX_DOWNLOAD).unwrap())
                                .expect("fixed download limit is valid"),
                        )
                        .with_timeouts(TransportTimeouts::new(
                            Timeout::After(Duration::from_secs(20)),
                            Timeout::After(Duration::from_secs(30)),
                            Timeout::Disabled,
                            Timeout::After(Duration::from_secs(240)),
                        )),
                )?;
                ReqwestHttpClient::with_network(network)
            })
            .as_ref()
            .map_err(Clone::clone)
    }
}

impl HttpClient for DownloadClient {
    fn execute(
        &self,
        request: &HttpRequest,
    ) -> Result<ash_http_client::HttpResponse, HttpClientError> {
        self.client()?.execute(request)
    }
    fn execute_streaming_with_cancellation(
        &self,
        request: &HttpRequest,
        token: &CancellationToken,
        sink: &mut dyn HttpBodySink,
    ) -> Result<ash_http_client::HttpResponse, HttpClientError> {
        self.client()?
            .execute_streaming_with_cancellation(request, token, sink)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installed {
    archive_sha256: String,
    files: Vec<InstalledFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstalledFile {
    path: String,
    size: u64,
    sha256: Option<String>,
}

pub(crate) fn prepare_runtime(
    root: &Path,
    artifact: &Artifact,
    http: &dyn HttpClient,
    token: &CancellationToken,
    progress: &dyn Fn(Progress),
) -> Result<PathBuf, InstallError> {
    check(token)?;
    let root = if root.is_dir() {
        dunce::canonicalize(root)?
    } else {
        root.to_path_buf()
    };
    let existing = root.join(&artifact.version).join(&artifact.platform);
    // A complete prefilled cache also works from a read-only offline deployment.
    if installed_is_valid(&existing, artifact, token)? {
        return Ok(existing.join(artifact.executable()));
    }
    fs::create_dir_all(&root)?;
    let root = dunce::canonicalize(root)?;
    let version = root.join(&artifact.version);
    fs::create_dir_all(&version)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(version.join(format!("{}.lock", artifact.platform)))?;
    let mut announced = false;
    loop {
        check(token)?;
        match fs2::FileExt::try_lock_exclusive(&lock) {
            Ok(()) => break,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || cfg!(windows) && error.raw_os_error() == Some(33) =>
            {
                if !announced {
                    progress(Progress::Waiting);
                    announced = true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.into()),
        }
    }
    let directory = version.join(&artifact.platform);
    if installed_is_valid(&directory, artifact, token)? {
        return Ok(directory.join(artifact.executable()));
    }
    let archive = version.join(format!("codelldb-{}.vsix", artifact.platform));
    let pending_prefix = format!(".install-{}-", artifact.platform);
    for entry in fs::read_dir(&version)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(&pending_prefix)
            && entry.file_type()?.is_dir()
        {
            // The platform lock proves that no live installer owns this staging directory.
            fs::remove_dir_all(entry.path())?;
        }
    }
    let staging = tempfile::Builder::new()
        .prefix(&pending_prefix)
        .tempdir_in(&version)?;
    if !archive.is_file() || hash_file(&archive, token)? != artifact.sha256 {
        progress(Progress::Downloading(0));
        let temporary = staging.path().join("download.vsix");
        let mut sink = Download {
            file: File::create(&temporary)?,
            hash: Sha256::new(),
            bytes: 0,
            last_report: Instant::now(),
            token,
            progress,
        };
        let response = download(http, &artifact.url, token, &mut sink)?;
        if !(200..300).contains(&response.status()) {
            return Err(InstallError::Failed(format!("HTTP {}", response.status())));
        }
        check(token)?;
        progress(Progress::Verifying);
        if format!("{:x}", sink.hash.finalize()) != artifact.sha256 {
            return Err(InstallError::Integrity);
        }
        sink.file.sync_all()?;
        drop(sink.file);
        if archive.exists() {
            fs::remove_file(&archive)?;
        }
        fs::rename(temporary, &archive)?;
    }
    progress(Progress::Unpacking);
    let unpacked = staging.path().join("runtime");
    fs::create_dir(&unpacked)?;
    let files = unpack(&archive, &unpacked, artifact, token)?;
    if !unpacked.join(artifact.executable()).is_file()
        || !unpacked.join(artifact.library()).is_file()
    {
        return Err(InstallError::Failed(
            "runtime is missing its adapter or LLDB library".into(),
        ));
    }
    let marker = serde_json::to_vec(&Installed {
        archive_sha256: artifact.sha256.clone(),
        files,
    })
    .map_err(|error| InstallError::Failed(error.to_string()))?;
    let mut file = File::create(unpacked.join(MARKER))?;
    file.write_all(&marker)?;
    file.sync_all()?;
    drop(file);
    check(token)?;
    // Retire only this exact incomplete installation, under the same version lock.
    // Older versions may still have active adapters and are deliberately retained.
    if directory.exists() {
        fs::rename(&directory, staging.path().join("incomplete"))?;
    }
    fs::rename(&unpacked, &directory)?;
    Ok(directory.join(artifact.executable()))
}

fn installed_is_valid(
    directory: &Path,
    artifact: &Artifact,
    token: &CancellationToken,
) -> Result<bool, InstallError> {
    let marker = directory.join(MARKER);
    let Ok(metadata) = fs::symlink_metadata(&marker) else {
        return Ok(false);
    };
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Ok(false);
    }
    let Ok(installed) = serde_json::from_slice::<Installed>(&fs::read(marker)?) else {
        return Ok(false);
    };
    if installed.archive_sha256 != artifact.sha256
        || installed.files.is_empty()
        || installed.files.len() > MAX_ENTRIES
    {
        return Ok(false);
    }
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for file in &installed.files {
        check(token)?;
        let critical = file.path == artifact.executable() || file.path == artifact.library();
        if !safe_path(&file.path)
            || !paths.insert(file.path.to_lowercase())
            || critical != file.sha256.is_some()
            || file.sha256.as_ref().is_some_and(|hash| {
                hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Ok(false);
        }
        total = match total.checked_add(file.size) {
            Some(total) if total <= MAX_UNPACKED => total,
            _ => return Ok(false),
        };
        let path = directory.join(&file.path);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return Ok(false);
        };
        if !metadata.is_file() || metadata.len() != file.size {
            return Ok(false);
        }
        if let Some(expected) = &file.sha256 {
            if hash_file(&path, token)? != *expected {
                return Ok(false);
            }
        }
    }
    Ok(installed
        .files
        .iter()
        .any(|file| file.path == artifact.executable())
        && installed
            .files
            .iter()
            .any(|file| file.path == artifact.library()))
}

fn unpack(
    archive: &Path,
    destination: &Path,
    artifact: &Artifact,
    token: &CancellationToken,
) -> Result<Vec<InstalledFile>, InstallError> {
    let mut archive = zip::ZipArchive::new(File::open(archive)?)
        .map_err(|error| InstallError::Failed(error.to_string()))?;
    if archive.len() > MAX_ENTRIES {
        return Err(InstallError::Failed(
            "runtime archive has too many entries".into(),
        ));
    }
    let mut total = 0u64;
    let mut paths = BTreeSet::new();
    let mut files = Vec::new();
    for index in 0..archive.len() {
        check(token)?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| InstallError::Failed(error.to_string()))?;
        let name = entry.name().trim_end_matches('/').to_string();
        if !safe_path(&name)
            || !paths.insert(name.to_lowercase())
            || entry.is_symlink()
            || entry.encrypted()
            || entry
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err(InstallError::Failed(
                "runtime archive contains an unsafe entry".into(),
            ));
        }
        total = total
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED)
            .ok_or_else(|| {
                InstallError::Failed("unpacked runtime exceeds its size limit".into())
            })?;
        let path = destination.join(&name);
        if entry.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        if !entry.is_file() {
            return Err(InstallError::Failed(
                "runtime archive contains a special file".into(),
            ));
        }
        fs::create_dir_all(path.parent().expect("validated path has a parent"))?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        let mut copied = 0u64;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            check(token)?;
            let count = entry.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            copied += count as u64;
            if copied > entry.size() {
                return Err(InstallError::Failed(
                    "runtime entry exceeds its declared size".into(),
                ));
            }
            file.write_all(&buffer[..count])?;
            if name == artifact.executable() || name == artifact.library() {
                hash.update(&buffer[..count]);
            }
        }
        if copied != entry.size() {
            return Err(InstallError::Failed("runtime archive is truncated".into()));
        }
        file.flush()?;
        #[cfg(unix)]
        if entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        }
        files.push(InstalledFile {
            path: name.clone(),
            size: copied,
            sha256: (name == artifact.executable() || name == artifact.library())
                .then(|| format!("{:x}", hash.finalize())),
        });
    }
    Ok(files)
}

fn safe_path(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':', '\0'])
        && Path::new(name)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn download(
    http: &dyn HttpClient,
    initial: &str,
    token: &CancellationToken,
    sink: &mut dyn HttpBodySink,
) -> Result<ash_http_client::HttpResponse, InstallError> {
    let mut url = Url::parse(initial).map_err(|error| InstallError::Failed(error.to_string()))?;
    for _ in 0..6 {
        check(token)?;
        // Release URLs are pinned by this package. Every redirect must stay on
        // GitHub's HTTPS asset hosts; no workspace setting can select a URL.
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port_or_known_default() != Some(443)
            || !matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                        | "github-releases.githubusercontent.com"
                )
            )
        {
            return Err(InstallError::Failed(
                "runtime download redirected outside GitHub's HTTPS asset hosts".into(),
            ));
        }
        let request = HttpRequest::new(
            HttpMethod::Get,
            url.as_str(),
            vec![HttpHeader::new("User-Agent", "Ash-CodeLLDB")],
            Vec::new(),
        )
        .map_err(|error| InstallError::Failed(error.to_string()))?;
        let response = http
            .execute_streaming_with_cancellation(&request, token, sink)
            .map_err(|error| {
                if token.is_cancelled() {
                    InstallError::Cancelled
                } else {
                    InstallError::Failed(error.to_string())
                }
            })?;
        if !matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let location = response
            .headers()
            .iter()
            .find(|header| header.name().eq_ignore_ascii_case("location"))
            .ok_or_else(|| {
                InstallError::Failed("runtime download redirect has no location".into())
            })?;
        url = url
            .join(location.value())
            .map_err(|error| InstallError::Failed(error.to_string()))?;
    }
    Err(InstallError::Failed(
        "runtime download has too many redirects".into(),
    ))
}

fn hash_file(path: &Path, token: &CancellationToken) -> Result<String, InstallError> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        check(token)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn check(token: &CancellationToken) -> Result<(), InstallError> {
    token.check().map_err(|_| InstallError::Cancelled)
}

struct Download<'a> {
    file: File,
    hash: Sha256,
    bytes: u64,
    last_report: Instant,
    token: &'a CancellationToken,
    progress: &'a dyn Fn(Progress),
}

impl HttpBodySink for Download<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        self.token
            .check()
            .map_err(|_| HttpClientError::Transport("download cancelled".into()))?;
        self.bytes += chunk.len() as u64;
        if self.bytes > MAX_DOWNLOAD as u64 {
            return Err(HttpClientError::ResponseTooLarge);
        }
        self.file
            .write_all(chunk)
            .map_err(|error| HttpClientError::Transport(error.to_string()))?;
        self.hash.update(chunk);
        if self.last_report.elapsed() >= Duration::from_millis(250) {
            (self.progress)(Progress::Downloading(self.bytes));
            self.last_report = Instant::now();
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "installer_tests.rs"]
mod tests;
