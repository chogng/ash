use std::fs;
use std::io;
use std::sync::Arc;

#[derive(Debug)]
pub(crate) struct GenerationLease {
    pub(crate) _file: fs::File,
}

/// An open immutable-generation file that keeps its generation lease alive.
#[derive(Debug)]
pub struct OpenGenerationFile {
    file: fs::File,
    _lease: Arc<GenerationLease>,
}

impl OpenGenerationFile {
    pub(crate) fn new(file: fs::File, lease: Arc<GenerationLease>) -> Self {
        Self {
            file,
            _lease: lease,
        }
    }

    pub fn length(&self) -> io::Result<u64> {
        self.file.metadata().map(|metadata| metadata.len())
    }

    pub fn as_file(&self) -> &fs::File {
        &self.file
    }

    pub fn read_exact_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        read_exact_at(&self.file, offset, buffer)
    }
}

#[cfg(unix)]
pub(crate) fn read_exact_at(file: &fs::File, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buffer, offset)
}

#[cfg(windows)]
pub(crate) fn read_exact_at(file: &fs::File, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
    use std::os::windows::fs::FileExt;

    let mut filled = 0;
    while filled < buffer.len() {
        let position = offset
            .checked_add(filled as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "read offset overflow"))?;
        let read = file.seek_read(&mut buffer[filled..], position)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "failed to fill generation file buffer",
            ));
        }
        filled += read;
    }
    Ok(())
}
