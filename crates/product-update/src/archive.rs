use crate::PackageFormat;
use crate::UpdateError;
use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Component;
use std::path::Path;

const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Extracts a verified archive with the same path, entry and size constraints for every host.
pub fn extract_package(
    archive: &Path,
    format: PackageFormat,
    destination: &Path,
) -> Result<(), UpdateError> {
    match format {
        PackageFormat::TarGz => extract_tar_gz(archive, destination),
        PackageFormat::Zip => extract_zip(archive, destination),
        PackageFormat::MacOsPackage
        | PackageFormat::LinuxAppImage
        | PackageFormat::WindowsMsi
        | PackageFormat::WindowsExe => Err("update package has an unsupported format".into()),
    }
    .map_err(UpdateError::new)
}

fn extract_tar_gz(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut unpacked = 0u64;
    let mut paths = BTreeSet::new();
    for (index, entry) in archive
        .entries()
        .map_err(|error| error.to_string())?
        .enumerate()
    {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err("update archive contains too many entries".into());
        }
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        if !safe_relative_path(&path) || !paths.insert(path.clone()) {
            return Err(format!(
                "update archive entry escapes or repeats the package: {}",
                path.display()
            ));
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(format!(
                "update archive entry has an unsupported type: {}",
                path.display()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or("unpacked update package exceeds the size limit")?;
        entry
            .unpack_in(destination)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut directory = file.try_clone().map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("update archive contains too many entries".into());
    }
    // ZipArchive indexes by name and silently collapses exact duplicate central-directory records.
    // Count the original records before extraction so that its index cannot conceal duplicates.
    directory
        .seek(SeekFrom::Start(archive.central_directory_start()))
        .map_err(|error| error.to_string())?;
    let mut count = 0;
    loop {
        let mut signature = [0; 4];
        directory
            .read_exact(&mut signature)
            .map_err(|error| error.to_string())?;
        if signature != *b"PK\x01\x02" {
            break;
        }
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err("update archive contains too many entries".into());
        }
        let mut header = [0; 42];
        directory
            .read_exact(&mut header)
            .map_err(|error| error.to_string())?;
        let variable_length: i64 = [24, 26, 28]
            .into_iter()
            .map(|offset| i64::from(u16::from_le_bytes([header[offset], header[offset + 1]])))
            .sum();
        directory
            .seek(SeekFrom::Current(variable_length))
            .map_err(|error| error.to_string())?;
    }
    if count != archive.len() {
        return Err("update archive contains duplicate or inconsistent directory entries".into());
    }
    let mut unpacked = 0u64;
    let mut paths = BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| format!("update archive entry path is invalid: {}", entry.name()))?
            .to_owned();
        if !safe_relative_path(&path) || !paths.insert(path.clone()) {
            return Err(format!(
                "update archive entry escapes or repeats the package: {}",
                path.display()
            ));
        }
        if entry.is_symlink() || entry.encrypted() {
            return Err(format!(
                "update archive entry has an unsupported type: {}",
                path.display()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or("unpacked update package exceeds the size limit")?;
        let output = destination.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(output).map_err(|error| error.to_string())?;
            continue;
        }
        if !entry.is_file() {
            return Err(format!(
                "update archive entry has an unsupported type: {}",
                path.display()
            ));
        }
        fs::create_dir_all(
            output
                .parent()
                .ok_or("update archive entry has no parent")?,
        )
        .map_err(|error| error.to_string())?;
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| error.to_string())?;
        let size = entry.size();
        #[cfg(unix)]
        let mode = entry.unix_mode();
        let copied = std::io::copy(&mut entry.take(size + 1), &mut target)
            .map_err(|error| error.to_string())?;
        if copied != size {
            return Err(format!(
                "update archive entry is truncated: {}",
                path.display()
            ));
        }
        target.flush().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &output,
                fs::Permissions::from_mode(if mode & 0o111 == 0 { 0o644 } else { 0o755 }),
            )
            .map_err(|error| error.to_string())?;
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
