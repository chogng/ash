//! Fixed-budget sorting of (gram, document ID) postings for persistent builds.

use crate::trigram;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::File;
use std::io;
use std::io::BufReader;
use std::io::BufWriter;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use tempfile::TempDir;

const BUFFER_BYTES: usize = 64 * 1024 * 1024;
const MERGE_FAN_IN: usize = 32;
type Posting = (u64, u64);

pub(super) struct Sorter {
    lease: File,
    directory: TempDir,
    buffer: Vec<Posting>,
    capacity: usize,
    runs: Vec<PathBuf>,
    next_run: usize,
}

impl Sorter {
    pub(super) fn new(root: &Path) -> io::Result<Self> {
        Self::with_capacity(root, BUFFER_BYTES / std::mem::size_of::<Posting>())
    }

    fn with_capacity(root: &Path, capacity: usize) -> io::Result<Self> {
        // Keep cleanup serialized until the new build has acquired its lease.
        let _cleanup = cleanup_interrupted(root)?;
        let directory = tempfile::Builder::new()
            .prefix(".build-")
            .tempdir_in(root)?;
        let lease = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(directory.path().join("lease"))?;
        fs2::FileExt::lock_exclusive(&lease)?;
        Ok(Self {
            lease,
            directory,
            buffer: Vec::with_capacity(capacity),
            capacity,
            runs: Vec::new(),
            next_run: 0,
        })
    }

    pub(super) fn push(&mut self, id: u32, grams: &[u64]) -> io::Result<()> {
        for gram in grams {
            self.buffer.push((
                trigram::key(*gram),
                trigram::posting(id, trigram::mask(*gram)),
            ));
            if self.buffer.len() == self.capacity {
                self.spill()?;
            }
        }
        Ok(())
    }

    fn run_path(&mut self) -> PathBuf {
        let path = self.directory.path().join(format!("run-{}", self.next_run));
        self.next_run += 1;
        path
    }

    fn spill(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.buffer.sort_unstable();
        self.buffer.dedup();
        let path = self.run_path();
        let mut out = BufWriter::with_capacity(256 * 1024, File::create(&path)?);
        for entry in &self.buffer {
            write_posting(&mut out, *entry)?;
        }
        out.flush()?;
        self.buffer.clear();
        self.runs.push(path);
        Ok(())
    }

    pub(super) fn finish(mut self) -> io::Result<SortedPostings> {
        self.spill()?;
        // Release the sort arena before opening merge buffers.
        self.buffer = Vec::new();
        while self.runs.len() > MERGE_FAN_IN {
            let old = std::mem::take(&mut self.runs);
            for paths in old.chunks(MERGE_FAN_IN) {
                let path = self.run_path();
                let mut out = BufWriter::with_capacity(256 * 1024, File::create(&path)?);
                for entry in Merge::open(paths)? {
                    write_posting(&mut out, entry?)?;
                }
                out.flush()?;
                self.runs.push(path);
                for source in paths {
                    std::fs::remove_file(source)?;
                }
            }
        }
        let merge = Merge::open(&self.runs)?;
        Ok(SortedPostings {
            merge,
            _lease: self.lease,
            directory: self.directory,
        })
    }
}

pub(crate) struct SortedPostings {
    merge: Merge,
    // Close readers and the lease before removing the directory on Windows.
    _lease: File,
    directory: TempDir,
}

impl SortedPostings {
    pub(crate) fn directory(&self) -> &Path {
        self.directory.path()
    }
}

fn cleanup_interrupted(root: &Path) -> io::Result<File> {
    let cleanup_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("build-cleanup.lock"))?;
    fs2::FileExt::lock_exclusive(&cleanup_lock)?;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || !entry.file_name().to_string_lossy().starts_with(".build-")
        {
            continue;
        }
        let lease_path = entry.path().join("lease");
        let metadata = match std::fs::symlink_metadata(&lease_path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if !metadata.is_file() {
            continue;
        }
        let lease = match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lease_path)
        {
            Ok(lease) => lease,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        match fs2::FileExt::try_lock_exclusive(&lease) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                continue;
            }
            Err(error) => return Err(error),
        }
        {
            drop(lease);
            match std::fs::remove_dir_all(entry.path()) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(cleanup_lock)
}

impl Iterator for SortedPostings {
    type Item = io::Result<Posting>;
    fn next(&mut self) -> Option<Self::Item> {
        self.merge.next()
    }
}

struct Merge {
    readers: Vec<BufReader<File>>,
    heap: BinaryHeap<Reverse<(Posting, usize)>>,
    previous: Option<Posting>,
    failed: bool,
}

impl Merge {
    fn open(paths: &[PathBuf]) -> io::Result<Self> {
        let mut readers = Vec::new();
        let mut heap = BinaryHeap::new();
        for (i, path) in paths.iter().enumerate() {
            let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
            if let Some(posting) = read_posting(&mut reader)? {
                heap.push(Reverse((posting, i)));
            }
            readers.push(reader);
        }
        Ok(Self {
            readers,
            heap,
            previous: None,
            failed: false,
        })
    }
}

impl Iterator for Merge {
    type Item = io::Result<Posting>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed {
            return None;
        }
        while let Some(Reverse((entry, source))) = self.heap.pop() {
            match read_posting(&mut self.readers[source]) {
                Ok(Some(next)) => self.heap.push(Reverse((next, source))),
                Ok(None) => {}
                Err(error) => {
                    self.failed = true;
                    return Some(Err(error));
                }
            }
            if self.previous != Some(entry) {
                self.previous = Some(entry);
                return Some(Ok(entry));
            }
        }
        None
    }
}

fn write_posting(writer: &mut impl Write, (gram, id): Posting) -> io::Result<()> {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&gram.to_le_bytes());
    bytes[8..].copy_from_slice(&id.to_le_bytes());
    writer.write_all(&bytes)
}

fn read_posting(reader: &mut impl Read) -> io::Result<Option<Posting>> {
    let mut bytes = [0u8; 16];
    loop {
        match reader.read(&mut bytes[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    reader.read_exact(&mut bytes[1..])?;
    Ok(Some((
        u64::from_le_bytes(bytes[..8].try_into().unwrap()),
        u64::from_le_bytes(bytes[8..].try_into().unwrap()),
    )))
}

#[cfg(test)]
#[path = "sort_tests.rs"]
mod tests;
