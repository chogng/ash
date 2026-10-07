use crate::FileInformation;
use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;

pub(super) fn inspect(file: &File) -> io::Result<FileInformation> {
    let metadata = file.metadata()?;
    Ok(FileInformation::new(
        metadata.dev(),
        u128::from(metadata.ino()).to_le_bytes(),
        metadata.nlink(),
    ))
}
