//! Installation receipts and conservative removal shared by the Desktop and CLI hosts.
//!
//! Receipts are per user. Removing a product releases only that installation's
//! ownership; a shared profile remains intact until its last consumer leaves.

mod command;
mod files;
mod upgrade;
#[cfg(windows)]
mod windows;

pub use command::run_command;
pub use command::schedule_cli_removal;
pub use files::remove_owned_tree;

use fs2::FileExt;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Product {
    Desktop,
    Cli,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemovalMode {
    KeepData,
    Purge,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    root: PathBuf,
    user_data: Option<PathBuf>,
    #[serde(default)]
    legacy_user_data: bool,
    // Existing data without receipts may belong to a portable/older consumer.
    // Never infer exclusive ownership merely from an Ash-looking directory name.
    legacy: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    product: Product,
    root: PathBuf,
    launcher_directory: Option<PathBuf>,
    #[serde(default)]
    launcher_sha256: Option<String>,
    profiles: Vec<Profile>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipts {
    schema_version: u8,
    installations: Vec<Installation>,
    #[serde(default)]
    retained_profiles: Vec<Profile>,
}

/// An uninstall result distinguishes protected data from failed cleanup.
/// A caller must not report complete removal when `failures` is non-empty.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReport {
    pub removed: Vec<PathBuf>,
    pub retained: Vec<PathBuf>,
    pub failures: Vec<String>,
}

/// Serializes registration and removal, including the process-stop boundary.
pub struct Registry {
    directory: PathBuf,
    receipts: Receipts,
    _lock: File,
}

pub fn registry_directory() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("ASH_INSTALLATION_REGISTRY") {
        return absolute_path(Path::new(&path));
    }
    default_registry_directory()
}

fn default_registry_directory() -> io::Result<PathBuf> {
    let root =
        dirs::data_local_dir().ok_or_else(|| invalid("user data directory is unavailable"))?;
    Ok(root.join("Ash").join("installation-registry"))
}

impl Registry {
    pub fn open(directory: &Path) -> io::Result<Self> {
        let directory = absolute_path(directory)?;
        files::ensure_directory(&directory)?;
        let lock_path = directory.join("registry.lock");
        files::require_regular_or_missing(&lock_path)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        FileExt::lock_exclusive(&lock)?;
        let path = directory.join("installations.json");
        let receipts = if path.try_exists()? {
            let bytes = files::read_bounded(&path)?;
            let receipts: Receipts = serde_json::from_slice(&bytes).map_err(invalid)?;
            if receipts.schema_version != 1 {
                return Err(invalid("unsupported installation registry"));
            }
            for install in &receipts.installations {
                absolute_path(&install.root)?;
                if let Some(path) = &install.launcher_directory {
                    absolute_path(path)?;
                }
                for profile in &install.profiles {
                    absolute_path(&profile.root)?;
                    if let Some(path) = &profile.user_data {
                        absolute_path(path)?;
                    }
                }
            }
            for profile in &receipts.retained_profiles {
                absolute_path(&profile.root)?;
                if let Some(path) = &profile.user_data {
                    absolute_path(path)?;
                }
            }
            receipts
        } else {
            Receipts {
                schema_version: 1,
                installations: Vec::new(),
                retained_profiles: Vec::new(),
            }
        };
        Ok(Self {
            directory,
            receipts,
            _lock: lock,
        })
    }

    /// Registers an installed product and, on first use, its actual profile paths.
    pub fn register(
        &mut self,
        product: Product,
        root: &Path,
        launcher: Option<&Path>,
        profile: Option<(&Path, Option<&Path>)>,
    ) -> io::Result<()> {
        let root = files::real_directory(root)?;
        let launcher = launcher.map(files::real_directory).transpose()?;
        let launcher_sha256 = {
            #[cfg(windows)]
            {
                if let Some(directory) = &launcher {
                    let adapter = directory.join("ash-launcher.exe");
                    let selected = command::selected_cli_package(&root)?.join("bin/ash.exe");
                    if adapter.exists() {
                        let digest = files::file_hash(&adapter)?;
                        (digest == files::file_hash(&selected)?).then_some(digest)
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            #[cfg(not(windows))]
            {
                None
            }
        };
        let profile = profile
            .map(|(path, user_data)| -> io::Result<_> {
                let path = absolute_path(path)?;
                let user_data = user_data.map(absolute_path).transpose()?;
                let known = self
                    .receipts
                    .installations
                    .iter()
                    .flat_map(|install| &install.profiles)
                    .chain(&self.receipts.retained_profiles)
                    .find(|profile| profile.root == path);
                let legacy = paths_overlap(&path, &root)
                    || known.map_or(path.exists(), |profile| profile.legacy);
                // A newly selected backend profile does not establish ownership
                // of an older Electron data directory used alongside it.
                let legacy_user_data = user_data.as_ref().is_some_and(|data| {
                    self.receipts
                        .installations
                        .iter()
                        .flat_map(|install| &install.profiles)
                        .chain(&self.receipts.retained_profiles)
                        .find(|profile| profile.user_data.as_ref() == Some(data))
                        .map_or(data.exists(), |profile| profile.legacy_user_data)
                });
                Ok(Profile {
                    root: path,
                    user_data,
                    legacy_user_data,
                    legacy,
                })
            })
            .transpose()?;
        let install = match self
            .receipts
            .installations
            .iter_mut()
            .find(|install| install.root == root && install.product == product)
        {
            Some(install) => install,
            None => {
                self.receipts.installations.push(Installation {
                    product,
                    root,
                    launcher_directory: launcher.clone(),
                    launcher_sha256: launcher_sha256.clone(),
                    profiles: Vec::new(),
                });
                self.receipts
                    .installations
                    .last_mut()
                    .expect("just inserted")
            }
        };
        if launcher.is_some() {
            install.launcher_directory = launcher;
        }
        if install.launcher_sha256.is_none() {
            install.launcher_sha256 = launcher_sha256;
        }
        if let Some(profile) = profile {
            if let Some(previous) = install.profiles.iter_mut().find(|previous| {
                previous.root == profile.root && previous.user_data == profile.user_data
            }) {
                previous.legacy = profile.legacy;
                previous.legacy_user_data = profile.legacy_user_data;
            } else {
                install.profiles.push(profile);
            }
        }
        self.save()
    }

    fn save(&self) -> io::Result<()> {
        ash_utils_path::write_atomically(
            &self.directory.join("installations.json"),
            &serde_json::to_vec_pretty(&self.receipts).map_err(invalid)?,
        )
    }

    fn use_lock(&self, root: &Path) -> io::Result<File> {
        let id = format!(
            "{:x}",
            Sha256::digest(root.as_os_str().to_string_lossy().as_bytes())
        );
        let path = self.directory.join(format!("use-{id}.lock"));
        files::require_regular_or_missing(&path)?;
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
    }

    fn operation_path(&self, root: &Path) -> PathBuf {
        let id = format!(
            "{:x}",
            Sha256::digest(root.as_os_str().to_string_lossy().as_bytes())
        );
        self.directory.join(format!("operation-{id}.json"))
    }

    fn require_launchable(&self, root: &Path) -> io::Result<()> {
        if self.operation_path(root).try_exists()? {
            return Err(invalid(
                "installation maintenance is unfinished; complete uninstallation or reinstall Ash",
            ));
        }
        Ok(())
    }

    fn finish_operation(&self, root: &Path) -> io::Result<()> {
        let path = self.operation_path(root);
        files::require_regular_or_missing(&path)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Stops exclusive backends before touching data. Shared and legacy profiles
    /// are reported, never stopped or recursively erased by another product.
    fn remove(
        &mut self,
        product: Product,
        root: &Path,
        mode: RemovalMode,
        mut stop: impl FnMut(&Path) -> io::Result<()>,
    ) -> io::Result<RemovalReport> {
        let root = files::real_directory(root)?;
        let Some(index) = self
            .receipts
            .installations
            .iter()
            .position(|install| install.root == root && install.product == product)
        else {
            return Err(invalid(
                "installation has no ownership receipt; register it before removal",
            ));
        };
        let install = self.receipts.installations[index].clone();
        let active = self.use_lock(&root)?;
        active
            .try_lock_exclusive()
            .map_err(|_| invalid("close Ash before uninstalling this installation"))?;
        let mut report = RemovalReport::default();
        for profile in &install.profiles {
            let shared = self
                .receipts
                .installations
                .iter()
                .enumerate()
                .any(|(other, install)| {
                    other != index && profile_overlaps_installation(profile, install)
                });
            if shared || profile.legacy {
                report.retained.push(profile.root.clone());
                if let Some(data) = &profile.user_data {
                    report.retained.push(data.clone());
                }
                continue;
            }
            stop(&profile.root)?;
            let key_marker = profile.root.join(".uninstall-keyring-pending");
            let secrets = profile.root.join("secrets");
            let keyring = if mode == RemovalMode::Purge
                && (key_marker.exists() || (secrets.exists() && files::eligible(&secrets)?))
            {
                files::require_regular_or_missing(&key_marker)?;
                ash_utils_path::write_atomically(&key_marker, b"ash-profile-key-v1\n")?;
                Some(
                    ash_keyring_store::KeyringSecretStore::for_profile(&profile.root)
                        .map_err(invalid)?,
                )
            } else {
                None
            };
            files::clean_profile(&profile.root, mode, &mut report)?;
            if let Some(keyring) = keyring {
                if !profile.root.join("secrets").exists() {
                    ash_secrets::ProfileSecretStore::delete_encryption_key(&keyring)
                        .map_err(invalid)?;
                    std::fs::remove_file(&key_marker)?;
                    report.retained.retain(|path| path != &key_marker);
                    if std::fs::read_dir(&profile.root)?.next().is_none() {
                        std::fs::remove_dir(&profile.root)?;
                    }
                }
            }
            if let Some(data) = &profile.user_data {
                let shared_data =
                    self.receipts
                        .installations
                        .iter()
                        .enumerate()
                        .any(|(other, install)| {
                            other != index
                                && install
                                    .profiles
                                    .iter()
                                    .any(|candidate| candidate.user_data.as_ref() == Some(data))
                        });
                if shared_data || profile.legacy_user_data {
                    report.retained.push(data.clone());
                } else {
                    files::clean_user_data(data, mode, &mut report)?;
                }
            }
        }
        Ok(report)
    }

    // Commit only after product-file removal succeeds. A crash or native
    // uninstaller failure must leave enough ownership information for retry.
    fn release(&mut self, product: Product, root: &Path) -> io::Result<()> {
        if let Some(index) = self
            .receipts
            .installations
            .iter()
            .position(|install| install.product == product && install.root == root)
        {
            let install = self.receipts.installations.remove(index);
            for profile in install.profiles {
                if !profile.legacy
                    && (profile.root.exists()
                        || profile.user_data.as_ref().is_some_and(|data| data.exists()))
                {
                    self.receipts.retained_profiles.retain(|previous| {
                        previous.root != profile.root || previous.user_data != profile.user_data
                    });
                    self.receipts.retained_profiles.push(profile);
                }
            }
            self.save()?;
        }
        Ok(())
    }
}

fn absolute_path(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(invalid(
            "installation paths must be absolute, non-root paths without traversal",
        ));
    }
    if dirs::home_dir().as_deref() == Some(path) {
        return Err(invalid("the user home cannot be an installation data root"));
    }
    if let Some(ancestor) = path.ancestors().find(|ancestor| ancestor.exists()) {
        files::real_directory(ancestor)?;
    }
    ash_utils_home_dir::resolve_path(path)
}

fn invalid(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn profile_overlaps_installation(profile: &Profile, installation: &Installation) -> bool {
    std::iter::once(&profile.root)
        .chain(profile.user_data.iter())
        .any(|path| {
            paths_overlap(path, &installation.root)
                || installation.profiles.iter().any(|candidate| {
                    paths_overlap(path, &candidate.root)
                        || candidate
                            .user_data
                            .as_ref()
                            .is_some_and(|data| paths_overlap(path, data))
                })
        })
}

#[cfg(test)]
#[path = "installation_tests.rs"]
mod tests;
