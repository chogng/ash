use flate2::read::GzDecoder;
use fs2::FileExt;
use semver::Version;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const REPOSITORY: &str = "chogng/ash";
const RELEASE_API: &str = "https://api.github.com/repos/chogng/ash/releases/latest";
const INSTALL_MARKER: &str = "install.json";
const CHECKED_AT_PREFIX: &str = "last-update-check";
const UPDATE_STATUS: &str = "update-status.json";
const UPDATE_LOCK: &str = "update.lock";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const SCHEDULE_INTERVAL: Duration = Duration::from_secs(60 * 60);
const MAX_RELEASE_DOCUMENT_BYTES: usize = 256 * 1024;
const MAX_SIGNED_RELEASE_BYTES: usize = 64 * 1024;
const MAX_ARCHIVE_BYTES: usize = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub(super) struct AutomaticUpdater {
    clients: mpsc::Sender<ash_app_server_client::AppServerRequestHandle>,
}

impl AutomaticUpdater {
    pub(super) fn start(
        client: ash_app_server_client::AppServerRequestHandle,
    ) -> Option<(Self, ash_tui::TuiNotices)> {
        ManagedInstall::current().ok()?;
        let (clients, receiver) = mpsc::channel();
        let (notices, notice_receiver) = mpsc::channel();
        thread::Builder::new()
            .name("ash-auto-update".into())
            .spawn(move || automatic_loop(client, receiver, notices))
            .ok()?;
        Some((Self { clients }, ash_tui::TuiNotices::new(notice_receiver)))
    }

    pub(super) fn replace_client(&self, client: ash_app_server_client::AppServerRequestHandle) {
        let _ = self.clients.send(client);
    }
}

fn automatic_loop(
    mut client: ash_app_server_client::AppServerRequestHandle,
    clients: mpsc::Receiver<ash_app_server_client::AppServerRequestHandle>,
    notices: mpsc::Sender<String>,
) {
    loop {
        if let Ok(policy) = client
            .read_config()
            .map_err(|error| error.to_string())
            .and_then(|config| ash_tui::update_policy(&config.tui))
            && policy != ash_tui::UpdatePolicy::Never
        {
            match run(UpdateMode::Automatic, policy, &HttpTransport) {
                Ok(UpdateOutcome::Installed { current, .. }) => {
                    let _ = notices.send(format!(
                        "Ash {current} is ready · restart to use the update"
                    ));
                    return;
                }
                Err(_) => {
                    let _ = notices.send(
                        "Automatic update failed · run `ash update --status` for details".into(),
                    );
                }
                Ok(UpdateOutcome::Current(_) | UpdateOutcome::SkippedRecentCheck) => {}
            }
        }
        match clients.recv_timeout(SCHEDULE_INTERVAL) {
            Ok(next) => client = next,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

pub(super) fn run_manual(arguments: Vec<String>) -> Result<(), String> {
    if arguments.as_slice() == ["--status"] {
        return print_status();
    }
    let channel = match arguments.as_slice() {
        [] => ash_tui::UpdatePolicy::Latest,
        [option, value] if option == "--channel" && value == "latest" => {
            ash_tui::UpdatePolicy::Latest
        }
        [option, value] if option == "--channel" && value == "stable" => {
            ash_tui::UpdatePolicy::Stable
        }
        _ => return Err("usage: ash update [--channel latest|stable] [--status]".into()),
    };
    match run(UpdateMode::Manual, channel, &HttpTransport)? {
        UpdateOutcome::Current(version) => println!("Ash is up to date ({version})"),
        UpdateOutcome::Installed { previous, current } => {
            println!("Updated Ash from {previous} to {current}; restart Ash to use it")
        }
        UpdateOutcome::SkippedRecentCheck => unreachable!("manual checks do not use the cache"),
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UpdateMode {
    Automatic,
    Manual,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum UpdateOutcome {
    Current(Version),
    Installed { previous: Version, current: Version },
    SkippedRecentCheck,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMarker {
    schema_version: u8,
    repository: String,
}

#[derive(Debug)]
struct ManagedInstall {
    root: PathBuf,
    package: PathBuf,
    versions: PathBuf,
    update_public_key: ash_product_update::UpdatePublicKey,
}

impl ManagedInstall {
    fn current() -> Result<Self, String> {
        let executable =
            fs::canonicalize(std::env::current_exe().map_err(|error| {
                format!("could not locate the running Ash executable: {error}")
            })?)
            .map_err(|error| format!("could not resolve the running Ash executable: {error}"))?;
        Self::detect(&executable)
    }

    fn detect(executable: &Path) -> Result<Self, String> {
        let executable = fs::canonicalize(executable)
            .map_err(|error| format!("could not resolve the Ash executable: {error}"))?;
        let binary_directory = executable
            .parent()
            .filter(|path| path.file_name().is_some_and(|name| name == "bin"))
            .ok_or_else(managed_install_required)?;
        let package = binary_directory
            .parent()
            .ok_or_else(managed_install_required)?;
        let versions = package.parent().ok_or_else(managed_install_required)?;
        if versions.file_name().is_none_or(|name| name != "versions") {
            return Err(managed_install_required());
        }
        let root = versions
            .parent()
            .ok_or_else(managed_install_required)?
            .to_owned();
        let marker: InstallMarker = serde_json::from_slice(
            &fs::read(root.join(INSTALL_MARKER)).map_err(|_| managed_install_required())?,
        )
        .map_err(|_| managed_install_required())?;
        if marker.schema_version != 1 || marker.repository != REPOSITORY {
            return Err(managed_install_required());
        }
        let install = Self {
            root,
            package: package.to_owned(),
            versions: versions.to_owned(),
            update_public_key: read_update_public_key(package)?,
        };
        install.require_selected_package()?;
        Ok(install)
    }

    fn require_selected_package(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            let selected = fs::canonicalize(self.root.join("current"))
                .map_err(|error| format!("could not resolve the selected Ash version: {error}"))?;
            if selected != self.package {
                return Err(
                    "the running Ash version is pinned and cannot update the managed launcher"
                        .into(),
                );
            }
        }
        #[cfg(windows)]
        {
            let selected = fs::read_to_string(self.root.join("current"))
                .map_err(|error| format!("could not read the selected Ash version: {error}"))?;
            if self.versions.join(selected.trim()) != self.package {
                return Err(
                    "the running Ash version is pinned and cannot update the managed launcher"
                        .into(),
                );
            }
        }
        Ok(())
    }

    fn select(&self, package: &Path) -> Result<(), String> {
        let name = package
            .file_name()
            .ok_or_else(|| "installed package has no version directory name".to_owned())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let next = self.root.join(".current-next");
            let _ = fs::remove_file(&next);
            symlink(Path::new("versions").join(name), &next)
                .map_err(|error| format!("could not prepare the Ash version pointer: {error}"))?;
            fs::rename(&next, self.root.join("current"))
                .map_err(|error| format!("could not select the new Ash version: {error}"))?;
        }
        #[cfg(windows)]
        {
            let next = self.root.join("current.next");
            fs::write(&next, name.to_string_lossy().as_bytes())
                .map_err(|error| format!("could not prepare the Ash version pointer: {error}"))?;
            let current = self.root.join("current");
            fs::remove_file(&current)
                .map_err(|error| format!("could not replace the Ash version pointer: {error}"))?;
            fs::rename(&next, current)
                .map_err(|error| format!("could not select the new Ash version: {error}"))?;
        }
        Ok(())
    }
}

fn managed_install_required() -> String {
    "automatic updates require the versioned Ash-managed installation; install with scripts/code/install.sh or scripts/code/install.ps1".into()
}

fn run(
    mode: UpdateMode,
    policy: ash_tui::UpdatePolicy,
    transport: &dyn Transport,
) -> Result<UpdateOutcome, String> {
    let install = ManagedInstall::current()?;
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|error| format!("invalid installed Ash version: {error}"))?;
    let result = run_for_install(
        &install,
        current.clone(),
        current_target()?,
        policy,
        mode,
        transport,
    );
    if !matches!(result, Ok(UpdateOutcome::SkippedRecentCheck)) {
        let status = UpdateStatus::from_result(current, policy, &result)?;
        write_status(&install.root, &status)?;
    }
    result
}

fn run_for_install(
    install: &ManagedInstall,
    current: Version,
    target: &str,
    policy: ash_tui::UpdatePolicy,
    mode: UpdateMode,
    transport: &dyn Transport,
) -> Result<UpdateOutcome, String> {
    if mode == UpdateMode::Automatic && checked_recently(&install.root, policy)? {
        return Ok(UpdateOutcome::SkippedRecentCheck);
    }
    let _lock = UpdateLock::acquire(&install.root)?;
    clean_staging(&install.versions)?;
    let resolved = resolve_release(install.update_public_key, target, policy, transport)?;
    let latest = resolved.release.version.clone();
    if latest <= current {
        record_check(&install.root, policy)?;
        return Ok(UpdateOutcome::Current(current));
    }
    let expected_digest = resolved.release.package.sha256;
    let staging = install
        .versions
        .join(format!(".update-package-{}", std::process::id()));
    fs::create_dir(&staging)
        .map_err(|error| format!("could not create update staging: {error}"))?;
    let archive_path = install.versions.join(format!(
        ".update-archive-{}-{}",
        std::process::id(),
        resolved.release.package.file_name
    ));
    let result = (|| {
        let downloaded =
            transport.fetch_file(&resolved.archive_url, &archive_path, MAX_ARCHIVE_BYTES)?;
        if downloaded.size != resolved.release.package.size || downloaded.sha256 != expected_digest
        {
            return Err("downloaded Ash package does not match its SHA-256 checksum".into());
        }
        extract_package(&archive_path, resolved.release.package.format, &staging)?;
        let metadata = validate_package(&staging, &latest, target)?;
        let id = format!(
            "{}-{}",
            latest,
            metadata
                .build_id
                .strip_prefix("sha256:")
                .and_then(|value| value.get(..16))
                .ok_or_else(|| "package buildId is invalid".to_owned())?
        );
        let installed = install.versions.join(id);
        if installed.exists() {
            validate_package(&installed, &latest, target)?;
            fs::remove_dir_all(&staging)
                .map_err(|error| format!("could not remove duplicate update staging: {error}"))?;
        } else {
            fs::rename(&staging, &installed).map_err(|error| {
                format!("could not publish the downloaded Ash version: {error}")
            })?;
        }
        install.select(&installed)?;
        record_check(&install.root, policy)?;
        Ok(UpdateOutcome::Installed {
            previous: current,
            current: latest,
        })
    })();
    let _ = fs::remove_file(&archive_path);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

struct ResolvedRelease {
    release: ash_product_update::VerifiedRelease,
    archive_url: String,
}

fn resolve_release(
    public_key: ash_product_update::UpdatePublicKey,
    target: &str,
    policy: ash_tui::UpdatePolicy,
    transport: &dyn Transport,
) -> Result<ResolvedRelease, String> {
    match policy {
        ash_tui::UpdatePolicy::Latest => {
            let github: Release =
                serde_json::from_slice(&transport.fetch(RELEASE_API, MAX_RELEASE_DOCUMENT_BYTES)?)
                    .map_err(|error| format!("invalid GitHub release response: {error}"))?;
            let signed_name = format!("ash-code-{target}.update.json");
            let signed_asset = github.asset(&signed_name)?;
            let release = ash_product_update::verify_release(
                &transport.fetch(&signed_asset.browser_download_url, MAX_SIGNED_RELEASE_BYTES)?,
                public_key,
                &ash_product_update::ExpectedRelease {
                    product: ash_product_update::UpdateProduct::AshCode,
                    policy,
                    target: target.into(),
                },
            )
            .map_err(|error| error.to_string())?;
            if release.version != github.version()? || release.release_identity != github.tag_name {
                return Err("signed update version does not match the GitHub release tag".into());
            }
            let archive = github.asset(&release.package.file_name)?;
            if archive.size != release.package.size
                || archive.browser_download_url != release.package.url
            {
                return Err("signed update size does not match the GitHub release asset".into());
            }
            Ok(ResolvedRelease {
                release,
                archive_url: archive.browser_download_url.clone(),
            })
        }
        ash_tui::UpdatePolicy::Stable => {
            let descriptor_url = format!(
                "https://github.com/{REPOSITORY}/releases/download/ash-code-stable/ash-code-stable-{target}.update.json"
            );
            let release = ash_product_update::verify_release(
                &transport.fetch(&descriptor_url, MAX_SIGNED_RELEASE_BYTES)?,
                public_key,
                &ash_product_update::ExpectedRelease {
                    product: ash_product_update::UpdateProduct::AshCode,
                    policy,
                    target: target.into(),
                },
            )
            .map_err(|error| error.to_string())?;
            let expected_url = format!(
                "https://github.com/{REPOSITORY}/releases/download/{}/{}",
                release.release_identity, release.package.file_name
            );
            if release.package.url != expected_url {
                return Err("signed stable update URL does not match its release identity".into());
            }
            Ok(ResolvedRelease {
                release,
                archive_url: expected_url,
            })
        }
        ash_tui::UpdatePolicy::Never => {
            Err("the never update policy does not select a release".into())
        }
    }
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    schema_version: u8,
    attempted_at: u64,
    current_version: String,
    policy: ash_tui::UpdatePolicy,
    result: StatusResult,
}

impl UpdateStatus {
    fn from_result(
        current: Version,
        policy: ash_tui::UpdatePolicy,
        result: &Result<UpdateOutcome, String>,
    ) -> Result<Self, String> {
        let result = match result {
            Ok(UpdateOutcome::Current(_)) => StatusResult::Current,
            Ok(UpdateOutcome::Installed { current, .. }) => StatusResult::Installed {
                version: current.to_string(),
            },
            Ok(UpdateOutcome::SkippedRecentCheck) => {
                unreachable!("skipped checks do not replace the last update status")
            }
            Err(message) => StatusResult::Failed {
                message: message.clone(),
            },
        };
        Ok(Self {
            schema_version: 1,
            attempted_at: unix_time()?,
            current_version: current.to_string(),
            policy,
            result,
        })
    }
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
enum StatusResult {
    Current,
    Installed { version: String },
    Failed { message: String },
}

fn write_status(root: &Path, status: &UpdateStatus) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(status)
        .map_err(|error| format!("could not encode update status: {error}"))?;
    fs::write(root.join(UPDATE_STATUS), contents)
        .map_err(|error| format!("could not write update status: {error}"))
}

fn print_status() -> Result<(), String> {
    let install = ManagedInstall::current()?;
    let current = env!("CARGO_PKG_VERSION");
    let path = install.root.join(UPDATE_STATUS);
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            println!("Ash update status\nCurrent version: {current}\nLast attempt: never");
            return Ok(());
        }
        Err(error) => return Err(format!("could not read update status: {error}")),
    };
    let status: UpdateStatus = serde_json::from_slice(&contents)
        .map_err(|error| format!("update status is invalid: {error}"))?;
    if status.schema_version != 1 {
        return Err("update status version is unsupported".into());
    }
    let age = unix_time()?.saturating_sub(status.attempted_at);
    let result = match status.result {
        StatusResult::Current => "up to date".to_owned(),
        StatusResult::Installed { version } => format!("installed {version}; restart required"),
        StatusResult::Failed { message } => format!("failed: {message}"),
    };
    println!(
        "Ash update status\nCurrent version: {current}\nPolicy: {}\nLast attempt: {} ago\nResult: {result}",
        policy_label(status.policy),
        elapsed_label(age),
    );
    Ok(())
}

fn policy_label(policy: ash_tui::UpdatePolicy) -> &'static str {
    match policy {
        ash_tui::UpdatePolicy::Latest => "latest",
        ash_tui::UpdatePolicy::Stable => "stable",
        ash_tui::UpdatePolicy::Never => "never",
    }
}

fn elapsed_label(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 60 * 60 {
        format!("{}m", seconds / 60)
    } else if seconds < 24 * 60 * 60 {
        format!("{}h", seconds / (60 * 60))
    } else {
        format!("{}d", seconds / (24 * 60 * 60))
    }
}

fn clean_staging(versions: &Path) -> Result<(), String> {
    for entry in fs::read_dir(versions)
        .map_err(|error| format!("could not inspect the Ash version store: {error}"))?
    {
        let entry = entry.map_err(|error| format!("could not inspect update staging: {error}"))?;
        if !entry.file_name().to_string_lossy().starts_with(".update-") {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|error| format!("could not inspect stale update staging: {error}"))?;
        if kind.is_dir() {
            fs::remove_dir_all(entry.path())
                .map_err(|error| format!("could not clear stale update staging: {error}"))?;
        } else if kind.is_file() {
            fs::remove_file(entry.path())
                .map_err(|error| format!("could not clear stale update archive: {error}"))?;
        } else {
            return Err(
                "the Ash version store contains an unsupported update staging entry".into(),
            );
        }
    }
    Ok(())
}

fn checked_recently(root: &Path, policy: ash_tui::UpdatePolicy) -> Result<bool, String> {
    let path = check_path(root, policy)?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("could not read the update check time: {error}")),
    };
    let checked = contents
        .trim()
        .parse::<u64>()
        .map_err(|_| "the update check time is invalid".to_owned())?;
    let now = unix_time()?;
    Ok(now.saturating_sub(checked) < CHECK_INTERVAL.as_secs())
}

fn record_check(root: &Path, policy: ash_tui::UpdatePolicy) -> Result<(), String> {
    fs::write(check_path(root, policy)?, unix_time()?.to_string())
        .map_err(|error| format!("could not record the update check time: {error}"))
}

fn check_path(root: &Path, policy: ash_tui::UpdatePolicy) -> Result<PathBuf, String> {
    match policy {
        ash_tui::UpdatePolicy::Latest | ash_tui::UpdatePolicy::Stable => {
            Ok(root.join(format!("{CHECKED_AT_PREFIX}-{}", policy_label(policy))))
        }
        ash_tui::UpdatePolicy::Never => {
            Err("the never update policy has no check timestamp".into())
        }
    }
}

fn unix_time() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| format!("system clock is before the Unix epoch: {error}"))
}

struct UpdateLock {
    file: File,
}

impl UpdateLock {
    fn acquire(root: &Path) -> Result<Self, String> {
        let path = root.join(UPDATE_LOCK);
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|error| format!("could not open the Ash update lock: {error}"))?;
        file.try_lock_exclusive()
            .map_err(|error| format!("another Ash update is active: {error}"))?;
        Ok(Self { file })
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<ReleaseAsset>,
}

impl Release {
    fn version(&self) -> Result<Version, String> {
        Version::parse(self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name))
            .map_err(|error| format!("GitHub release tag is not a semantic version: {error}"))
    }

    fn asset(&self, name: &str) -> Result<&ReleaseAsset, String> {
        self.assets
            .iter()
            .find(|asset| asset.name == name)
            .ok_or_else(|| format!("GitHub release is missing {name}"))
    }
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DownloadedFile {
    sha256: [u8; 32],
    size: u64,
}

trait Transport {
    fn fetch(&self, url: &str, maximum: usize) -> Result<Vec<u8>, String>;

    fn fetch_file(&self, url: &str, path: &Path, maximum: usize) -> Result<DownloadedFile, String> {
        let bytes = self.fetch(url, maximum)?;
        fs::write(path, &bytes)
            .map_err(|error| format!("could not write downloaded update: {error}"))?;
        Ok(DownloadedFile {
            sha256: Sha256::digest(&bytes).into(),
            size: bytes.len() as u64,
        })
    }
}

struct HttpTransport;

impl Transport for HttpTransport {
    fn fetch(&self, url: &str, maximum: usize) -> Result<Vec<u8>, String> {
        let response = ureq::get(url)
            .set("Accept", "application/vnd.github+json")
            .set("User-Agent", "ash-code-updater")
            .call()
            .map_err(|error| format!("could not download {url}: {error}"))?;
        let mut reader = response.into_reader().take(maximum as u64 + 1);
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|error| format!("could not read {url}: {error}"))?;
        if bytes.len() > maximum {
            return Err(format!("download from {url} exceeds {maximum} bytes"));
        }
        Ok(bytes)
    }

    fn fetch_file(&self, url: &str, path: &Path, maximum: usize) -> Result<DownloadedFile, String> {
        let response = ureq::get(url)
            .set("Accept", "application/octet-stream")
            .set("User-Agent", "ash-code-updater")
            .call()
            .map_err(|error| format!("could not download {url}: {error}"))?;
        let mut reader = response.into_reader().take(maximum as u64 + 1);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| format!("could not create update archive: {error}"))?;
        let mut digest = Sha256::new();
        let mut total = 0usize;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("could not read {url}: {error}"))?;
            if read == 0 {
                break;
            }
            total += read;
            if total > maximum {
                return Err(format!("download from {url} exceeds {maximum} bytes"));
            }
            digest.update(&buffer[..read]);
            file.write_all(&buffer[..read])
                .map_err(|error| format!("could not write update archive: {error}"))?;
        }
        file.sync_all()
            .map_err(|error| format!("could not flush update archive: {error}"))?;
        Ok(DownloadedFile {
            sha256: digest.finalize().into(),
            size: total as u64,
        })
    }
}

fn decode_sha256(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("SHA-256 value must contain 64 hexadecimal characters".into());
    }
    let mut decoded = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(pair).expect("ASCII hex pairs remain UTF-8");
        decoded[index] = u8::from_str_radix(text, 16)
            .map_err(|_| "SHA-256 value contains a non-hexadecimal character".to_owned())?;
    }
    Ok(decoded)
}

fn extract_package(
    archive: &Path,
    format: ash_product_update::PackageFormat,
    destination: &Path,
) -> Result<(), String> {
    match format {
        ash_product_update::PackageFormat::TarGz => extract_tar_gz(archive, destination),
        ash_product_update::PackageFormat::Zip => extract_zip(archive, destination),
        _ => Err("Ash Code update package has an unsupported format".into()),
    }
}

fn extract_tar_gz(archive: &Path, destination: &Path) -> Result<(), String> {
    let file =
        File::open(archive).map_err(|error| format!("could not open update archive: {error}"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let mut unpacked = 0u64;
    for entry in archive
        .entries()
        .map_err(|error| format!("could not read update archive: {error}"))?
    {
        let mut entry = entry.map_err(|error| format!("could not read archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("archive entry path is invalid: {error}"))?
            .into_owned();
        if !safe_relative_path(&path) {
            return Err(format!(
                "archive entry escapes the package root: {}",
                path.display()
            ));
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(format!(
                "archive entry has unsupported type: {}",
                path.display()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or_else(|| "unpacked Ash package exceeds the size limit".to_owned())?;
        entry
            .unpack_in(destination)
            .map_err(|error| format!("could not unpack {}: {error}", path.display()))?;
    }
    Ok(())
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file =
        File::open(archive).map_err(|error| format!("could not open update archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("could not read update archive: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("update archive contains too many entries".into());
    }
    let mut unpacked = 0u64;
    let mut paths = BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("could not read archive entry: {error}"))?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| format!("archive entry path is invalid: {}", entry.name()))?
            .to_owned();
        if !safe_relative_path(&path) || !paths.insert(path.clone()) {
            return Err(format!(
                "archive entry escapes or repeats the package root: {}",
                path.display()
            ));
        }
        if entry.is_symlink() || entry.encrypted() {
            return Err(format!(
                "archive entry has unsupported type: {}",
                path.display()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or_else(|| "unpacked Ash package exceeds the size limit".to_owned())?;
        let output = destination.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("could not create {}: {error}", path.display()))?;
            continue;
        }
        if !entry.is_file() {
            return Err(format!(
                "archive entry has unsupported type: {}",
                path.display()
            ));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| format!("could not create {}: {error}", path.display()))?;
        let expected = entry.size();
        #[cfg(unix)]
        let unix_mode = entry.unix_mode();
        let copied = std::io::copy(&mut entry.take(expected + 1), &mut target)
            .map_err(|error| format!("could not unpack {}: {error}", path.display()))?;
        if copied != expected {
            return Err(format!("archive entry is truncated: {}", path.display()));
        }
        target
            .flush()
            .map_err(|error| format!("could not flush {}: {error}", path.display()))?;
        #[cfg(unix)]
        if let Some(mode) = unix_mode {
            use std::os::unix::fs::PermissionsExt;
            let installed_mode = if mode & 0o111 == 0 { 0o644 } else { 0o755 };
            fs::set_permissions(&output, fs::Permissions::from_mode(installed_mode)).map_err(
                |error| format!("could not set {} permissions: {error}", path.display()),
            )?;
        }
    }
    Ok(())
}

fn safe_relative_path(path: &Path) -> bool {
    let mut components = path.components();
    components
        .next()
        .is_some_and(|component| matches!(component, Component::Normal(_)))
        && components.all(|component| matches!(component, Component::Normal(_)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageMetadata {
    layout_version: u8,
    version: String,
    target: String,
    build_id: String,
    files: BTreeMap<String, String>,
    components: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct InstalledPackageMetadata {
    components: BTreeMap<String, serde_json::Value>,
}

fn read_update_public_key(package: &Path) -> Result<ash_product_update::UpdatePublicKey, String> {
    let metadata: InstalledPackageMetadata = serde_json::from_slice(
        &fs::read(package.join("ash-package.json"))
            .map_err(|error| format!("could not read installed package metadata: {error}"))?,
    )
    .map_err(|error| format!("installed package metadata is invalid: {error}"))?;
    let value = metadata
        .components
        .get("cli")
        .and_then(|component| component.get("updatePublicKey"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "installed package has no update public key".to_owned())?;
    ash_product_update::UpdatePublicKey::from_hex(value)
        .map_err(|_| "installed package update public key is invalid".to_owned())
}

fn validate_package(
    package: &Path,
    expected_version: &Version,
    expected_target: &str,
) -> Result<PackageMetadata, String> {
    let metadata_path = package.join("ash-package.json");
    let metadata: PackageMetadata = serde_json::from_slice(
        &fs::read(&metadata_path)
            .map_err(|error| format!("downloaded package has no metadata: {error}"))?,
    )
    .map_err(|error| format!("downloaded package metadata is invalid: {error}"))?;
    if metadata.layout_version != 2
        || metadata.version != expected_version.to_string()
        || metadata.target != expected_target
        || !metadata.components.contains_key("cli")
    {
        return Err("downloaded package identity does not match this Ash release".into());
    }
    let build_digest = metadata
        .build_id
        .strip_prefix("sha256:")
        .ok_or_else(|| "package buildId is invalid".to_owned())?;
    decode_sha256(build_digest).map_err(|_| "package buildId is invalid".to_owned())?;
    let mut actual = BTreeSet::new();
    collect_files(package, package, &mut actual)?;
    actual.remove("ash-package.json");
    actual.remove(".lease");
    let expected = metadata.files.keys().cloned().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err("downloaded package file set does not match its metadata".into());
    }
    for (relative, expected_digest) in &metadata.files {
        let path = package.join(relative);
        let actual_digest = file_sha256(&path)?;
        if actual_digest != *expected_digest {
            return Err(format!(
                "downloaded package file failed validation: {relative}"
            ));
        }
    }
    let executable = package
        .join("bin")
        .join(if cfg!(windows) { "ash.exe" } else { "ash" });
    if !executable.is_file() {
        return Err("downloaded package has no Ash CLI executable".into());
    }
    let executable_relative = if cfg!(windows) {
        "bin/ash.exe"
    } else {
        "bin/ash"
    };
    let component_digest = metadata
        .components
        .get("cli")
        .and_then(|component| component.get("binarySha256"))
        .and_then(serde_json::Value::as_str);
    if component_digest != metadata.files.get(executable_relative).map(String::as_str) {
        return Err("downloaded package CLI identity does not match its file manifest".into());
    }
    read_update_public_key(package)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable
            .metadata()
            .map_err(|error| format!("could not inspect downloaded Ash executable: {error}"))?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("downloaded Ash CLI is not executable".into());
        }
    }
    Ok(metadata)
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("could not inspect downloaded package: {error}"))?
    {
        let entry = entry.map_err(|error| format!("could not inspect package entry: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("could not inspect package entry type: {error}"))?;
        let path = entry.path();
        if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
            return Err(format!(
                "downloaded package contains an unsupported entry: {}",
                path.display()
            ));
        }
        if kind.is_dir() {
            collect_files(root, &path, files)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .expect("walked package entries remain below the package root")
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(relative);
        }
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn current_target() -> Result<&'static str, String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok("x86_64-apple-darwin")
    } else if cfg!(all(
        target_os = "linux",
        target_env = "gnu",
        target_arch = "aarch64"
    )) {
        Ok("aarch64-unknown-linux-gnu")
    } else if cfg!(all(
        target_os = "linux",
        target_env = "gnu",
        target_arch = "x86_64"
    )) {
        Ok("x86_64-unknown-linux-gnu")
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Ok("aarch64-pc-windows-msvc")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("x86_64-pc-windows-msvc")
    } else {
        Err("automatic updates are not published for this platform".into())
    }
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
