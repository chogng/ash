use crate::ContentDigest;
use ash_file_identity::FileInformation;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Exact bounded bytes captured from one admissible single-link regular file.
pub(crate) struct VerifiedFileSnapshot {
    pub(crate) bytes: Vec<u8>,
    pub(crate) content_digest: ContentDigest,
}

/// Phase in which a verified file snapshot could not be captured.
pub(crate) enum FileSnapshotFailure {
    Unavailable,
    Changed,
}

/// Reads one bounded file while binding path observations to the handle used for the read.
pub(crate) fn read_verified_file_snapshot(
    path: &Path,
    maximum_bytes: u64,
) -> Result<VerifiedFileSnapshot, FileSnapshotFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|_| FileSnapshotFailure::Unavailable)?;
    let information =
        FileInformation::from_path(path).map_err(|_| FileSnapshotFailure::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || information.has_multiple_links()
        || metadata.len() > maximum_bytes
    {
        return Err(FileSnapshotFailure::Unavailable);
    }

    let mut file = File::open(path).map_err(|_| FileSnapshotFailure::Unavailable)?;
    let opened = FileInformation::from_file(&file).map_err(|_| FileSnapshotFailure::Unavailable)?;
    if !opened.same_file_as(information) || opened.has_multiple_links() {
        return Err(FileSnapshotFailure::Changed);
    }

    let capacity = usize::try_from(metadata.len()).map_err(|_| FileSnapshotFailure::Unavailable)?;
    let read_limit = maximum_bytes
        .checked_add(1)
        .ok_or(FileSnapshotFailure::Unavailable)?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref()
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|_| FileSnapshotFailure::Unavailable)?;

    let observed = fs::symlink_metadata(path).map_err(|_| FileSnapshotFailure::Changed)?;
    let observed_information =
        FileInformation::from_path(path).map_err(|_| FileSnapshotFailure::Changed)?;
    if bytes.len() as u64 > maximum_bytes
        || observed.file_type().is_symlink()
        || !observed.is_file()
        || observed.len() != bytes.len() as u64
        || !observed_information.same_file_as(opened)
        || observed_information.has_multiple_links()
    {
        return Err(FileSnapshotFailure::Changed);
    }

    Ok(VerifiedFileSnapshot {
        content_digest: ContentDigest::sha256(&bytes),
        bytes,
    })
}
