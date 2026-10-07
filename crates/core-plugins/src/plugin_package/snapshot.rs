use crate::PluginError;
use crate::PluginErrorKind;
use ash_file_identity::FileInformation;
use ash_plugin::LocalPluginPackage;
use std::fs;
use std::path::Path;
use std::time::Duration;

const MAX_LOCAL_SNAPSHOT_ATTEMPTS: usize = 3;
const LOCAL_SNAPSHOT_RETRY_DELAY: Duration = Duration::from_millis(20);

pub(super) fn create_stable_local_snapshot_with_observer(
    selected: &LocalPluginPackage,
    source: &Path,
    staging: &Path,
    after_snapshot: &mut impl FnMut(usize, &Path),
) -> Result<LocalPluginPackage, PluginError> {
    for attempt in 1..=MAX_LOCAL_SNAPSHOT_ATTEMPTS {
        reset_staging(staging)?;
        match copy_package_tree(source, staging) {
            Ok(()) => {}
            Err(error) if error.kind() == PluginErrorKind::SourceUnavailable => {
                pause_before_retry(attempt);
                continue;
            }
            Err(error) => return Err(error),
        }
        after_snapshot(attempt, staging);
        let snapshot = match LocalPluginPackage::load_with_digest_algorithm(
            staging,
            selected.digest_algorithm(),
        ) {
            Ok(snapshot) => snapshot,
            Err(snapshot_error) => {
                match LocalPluginPackage::load_with_digest_algorithm(
                    source,
                    selected.digest_algorithm(),
                ) {
                    Ok(current) if same_selected_identity(selected, &current) => {
                        pause_before_retry(attempt);
                        continue;
                    }
                    Ok(_) => return Err(selected_identity_changed()),
                    Err(_) => return Err(snapshot_error),
                }
            }
        };
        if !same_selected_identity(selected, &snapshot) {
            return Err(selected_identity_changed());
        }
        match LocalPluginPackage::load_with_digest_algorithm(source, selected.digest_algorithm()) {
            Ok(current)
                if same_selected_identity(selected, &current)
                    && current.package_digest() == snapshot.package_digest() =>
            {
                return Ok(snapshot);
            }
            Ok(current) if !same_selected_identity(selected, &current) => {
                return Err(selected_identity_changed());
            }
            Ok(_) => pause_before_retry(attempt),
            Err(error) if error.kind() == PluginErrorKind::SourceUnavailable => {
                pause_before_retry(attempt);
            }
            Err(error) => return Err(error),
        }
    }
    Err(PluginError::new(
        PluginErrorKind::SourceUnavailable,
        "Plugin source did not stabilize while a package snapshot was being created",
    ))
}

fn same_selected_identity(selected: &LocalPluginPackage, observed: &LocalPluginPackage) -> bool {
    selected.manifest().id == observed.manifest().id
        && selected.manifest().version == observed.manifest().version
}

fn selected_identity_changed() -> PluginError {
    PluginError::new(
        PluginErrorKind::PackageConflict,
        "Plugin source changed the selected identity while it was being installed",
    )
}

fn pause_before_retry(attempt: usize) {
    if attempt < MAX_LOCAL_SNAPSHOT_ATTEMPTS {
        std::thread::sleep(LOCAL_SNAPSHOT_RETRY_DELAY);
    }
}

fn reset_staging(staging: &Path) -> Result<(), PluginError> {
    if staging.exists() {
        fs::remove_dir_all(staging).map_err(snapshot_io)?;
    }
    fs::create_dir(staging).map_err(snapshot_io)
}

fn copy_package_tree(source: &Path, target: &Path) -> Result<(), PluginError> {
    let mut entries = fs::read_dir(source)
        .map_err(snapshot_io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(snapshot_io)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = entry.file_type().map_err(snapshot_io)?;
        let destination = target.join(entry.file_name());
        let inspected = fs::symlink_metadata(entry.path()).map_err(snapshot_io)?;
        if metadata.is_symlink()
            || inspected.file_type().is_symlink()
            || (!metadata.is_dir() && !metadata.is_file())
        {
            return Err(PluginError::new(
                PluginErrorKind::PackageUnsafe,
                "Plugin package changed to contain an unsafe entry during installation",
            ));
        }
        if metadata.is_dir() {
            fs::create_dir(&destination).map_err(snapshot_io)?;
            copy_package_tree(&entry.path(), &destination)?;
        } else {
            let inspected_information =
                FileInformation::from_path(entry.path()).map_err(snapshot_io)?;
            if inspected_information.has_multiple_links() {
                return Err(PluginError::new(
                    PluginErrorKind::PackageUnsafe,
                    "Plugin package changed to contain a hard-linked file during installation",
                ));
            }
            copy_file(&entry.path(), &destination, &inspected_information)?;
        }
    }
    Ok(())
}

fn copy_file(source: &Path, target: &Path, inspected: &FileInformation) -> Result<(), PluginError> {
    let mut input = fs::File::open(source).map_err(snapshot_io)?;
    let opened = input.metadata().map_err(snapshot_io)?;
    let opened_information = FileInformation::from_file(&input).map_err(snapshot_io)?;
    if opened_information.has_multiple_links() {
        return Err(PluginError::new(
            PluginErrorKind::PackageUnsafe,
            "Plugin package changed to contain a hard-linked file during installation",
        ));
    }
    if !opened.is_file() || !opened_information.same_file_as(*inspected) {
        return Err(PluginError::new(
            PluginErrorKind::SourceUnavailable,
            "Plugin package entry changed while its snapshot was being created",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(target).map_err(snapshot_io)?;
    std::io::copy(&mut input, &mut output).map_err(snapshot_io)?;
    output.sync_all().map_err(snapshot_io)
}

fn snapshot_io(_: impl std::fmt::Display) -> PluginError {
    PluginError::new(
        PluginErrorKind::SourceUnavailable,
        "Plugin package snapshot operation failed",
    )
}
