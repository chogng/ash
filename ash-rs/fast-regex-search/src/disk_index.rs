use crate::FastRegexError;
use crate::ngram::bigram_frequency_digest;
use crate::storage::STORE_VERSION;
use crate::storage::corrupt;
use crate::storage::header_length;
use crate::storage::io_error;
use crate::storage::read_u32;
use crate::storage::read_u64;
use ash_immutable_generation_store::OpenGenerationFile;
use ash_immutable_generation_store::PublishedSnapshot;
use memmap2::Mmap;
use memmap2::MmapOptions;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

pub(crate) struct DiskBaseIndex {
    lookup: Mmap,
    _lookup_file: OpenGenerationFile,
    postings: OpenGenerationFile,
    postings_path: PathBuf,
    postings_len: u64,
    paths: Vec<PathBuf>,
}

impl DiskBaseIndex {
    pub(crate) fn open(
        snapshot: &PublishedSnapshot,
        storage_path: &Path,
        generation: u64,
        paths: Vec<PathBuf>,
    ) -> Result<Self, FastRegexError> {
        let lookup_path = storage_path.join("lookup.bin");
        let postings_path = storage_path.join("postings.bin");
        let lookup_file = snapshot
            .open_base("lookup.bin")
            .map_err(|source| io_error(&lookup_path, source))?;
        let lookup = map_lookup(&lookup_file, &lookup_path)?;
        validate_generation_header(&lookup_path, &lookup, generation)?;
        let (postings, postings_len) = open_generation_file(snapshot, &postings_path, generation)?;
        validate_disk_lookup(&lookup_path, &lookup, postings_len)?;
        Ok(Self {
            lookup,
            _lookup_file: lookup_file,
            postings,
            postings_path,
            postings_len,
            paths,
        })
    }

    pub(crate) fn intersect_postings(
        &self,
        grams: &[u64],
        excluded_paths: &BTreeSet<PathBuf>,
    ) -> Result<BTreeSet<PathBuf>, FastRegexError> {
        let mut spans = Vec::with_capacity(grams.len());
        for gram in grams {
            let Some(span) = self.posting_span(*gram) else {
                return Ok(BTreeSet::new());
            };
            spans.push(span);
        }
        spans.sort_by_key(|(_, count)| *count);
        let Some((first_start, first_count)) = spans.first().copied() else {
            return Ok(BTreeSet::new());
        };
        let mut ids = self.read_posting(first_start, first_count)?;
        for (start, count) in spans.into_iter().skip(1) {
            let posting = self.read_posting(start, count)?;
            ids.retain(|id| posting.binary_search(id).is_ok());
            if ids.is_empty() {
                break;
            }
        }
        Ok(ids
            .into_iter()
            .filter_map(|id| self.paths.get(id as usize))
            .filter(|path| !excluded_paths.contains(*path))
            .cloned()
            .collect())
    }

    fn posting_span(&self, gram: u64) -> Option<(u64, usize)> {
        let entry_count = read_u64(&self.lookup, header_length())? as usize;
        let entries_offset = header_length() + 8;
        let target = gram;
        let mut left = 0usize;
        let mut right = entry_count;
        while left < right {
            let middle = left + (right - left) / 2;
            let offset = entries_offset + middle * 20;
            let key = read_u64(&self.lookup, offset)?;
            match key.cmp(&target) {
                std::cmp::Ordering::Less => left = middle + 1,
                std::cmp::Ordering::Greater => right = middle,
                std::cmp::Ordering::Equal => {
                    let posting_offset = read_u64(&self.lookup, offset + 8)?;
                    let count = read_u32(&self.lookup, offset + 16)? as usize;
                    let start = header_length() as u64 + posting_offset;
                    return Some((start, count));
                }
            }
        }
        None
    }

    fn read_posting(&self, start: u64, expected_count: usize) -> Result<Vec<u32>, FastRegexError> {
        let ids_bytes = expected_count
            .checked_mul(4)
            .ok_or_else(|| corrupt(&self.postings_path))?;
        let byte_count = ids_bytes
            .checked_add(4)
            .ok_or_else(|| corrupt(&self.postings_path))?;
        let end = start
            .checked_add(byte_count as u64)
            .ok_or_else(|| corrupt(&self.postings_path))?;
        if end > self.postings_len {
            return Err(corrupt(&self.postings_path));
        }
        let mut bytes = vec![0; byte_count];
        self.postings
            .read_exact_at(start, &mut bytes)
            .map_err(|source| io_error(&self.postings_path, source))?;
        if read_u32(&bytes, 0) != Some(expected_count as u32) {
            return Err(corrupt(&self.postings_path));
        }
        let mut ids = Vec::with_capacity(expected_count);
        for index in 0..expected_count {
            let id = read_u32(&bytes, 4 + index * 4).ok_or_else(|| corrupt(&self.postings_path))?;
            if id as usize >= self.paths.len() || ids.last().is_some_and(|previous| *previous >= id)
            {
                return Err(corrupt(&self.postings_path));
            }
            ids.push(id);
        }
        Ok(ids)
    }
}

fn validate_disk_lookup(
    path: &Path,
    lookup: &[u8],
    postings_len: u64,
) -> Result<(), FastRegexError> {
    let entry_count = read_u64(lookup, header_length()).ok_or_else(|| corrupt(path))? as usize;
    let entries_offset = header_length() + 8;
    let lookup_end = entries_offset
        .checked_add(entry_count.checked_mul(20).ok_or_else(|| corrupt(path))?)
        .ok_or_else(|| corrupt(path))?;
    if lookup_end != lookup.len() {
        return Err(corrupt(path));
    }
    let mut previous = None;
    for index in 0..entry_count {
        let offset = entries_offset + index * 20;
        let key = read_u64(lookup, offset).ok_or_else(|| corrupt(path))?;
        if previous.is_some_and(|previous| previous >= key) {
            return Err(corrupt(path));
        }
        previous = Some(key);
        let posting_offset = read_u64(lookup, offset + 8).ok_or_else(|| corrupt(path))?;
        let expected_count = u64::from(read_u32(lookup, offset + 16).ok_or_else(|| corrupt(path))?);
        let posting_start = (header_length() as u64)
            .checked_add(posting_offset)
            .ok_or_else(|| corrupt(path))?;
        let posting_end = posting_start
            .checked_add(4)
            .and_then(|end| end.checked_add(expected_count.checked_mul(4)?))
            .ok_or_else(|| corrupt(path))?;
        if posting_end > postings_len {
            return Err(corrupt(path));
        }
    }
    Ok(())
}

fn open_generation_file(
    snapshot: &PublishedSnapshot,
    path: &Path,
    generation: u64,
) -> Result<(OpenGenerationFile, u64), FastRegexError> {
    let file = snapshot
        .open_base("postings.bin")
        .map_err(|source| io_error(path, source))?;
    let length = file.length().map_err(|source| io_error(path, source))?;
    let mut header = vec![0; header_length()];
    file.read_exact_at(0, &mut header)
        .map_err(|source| io_error(path, source))?;
    validate_generation_header(path, &header, generation)?;
    Ok((file, length))
}

fn map_lookup(file: &OpenGenerationFile, path: &Path) -> Result<Mmap, FastRegexError> {
    let length = file.length().map_err(|source| io_error(path, source))?;
    if length == 0 {
        return Err(corrupt(path));
    }
    let length = usize::try_from(length).map_err(|_| corrupt(path))?;
    let mapping =
        map_immutable_file(file.as_file(), length).map_err(|source| io_error(path, source))?;
    if file.length().map_err(|source| io_error(path, source))? != length as u64 {
        return Err(corrupt(path));
    }
    Ok(mapping)
}

#[allow(unsafe_code)]
fn map_immutable_file(file: &fs::File, length: usize) -> io::Result<Mmap> {
    // SAFETY: This crate maps only a published immutable-generation file. OpenGenerationFile
    // retains the generation lease for the lifetime of DiskBaseIndex, so cleanup cannot remove
    // the file while the mapping is reachable, and generation files are never modified in place.
    unsafe { MmapOptions::new().len(length).map(file) }
}

fn validate_generation_header(
    path: &Path,
    bytes: &[u8],
    generation: u64,
) -> Result<(), FastRegexError> {
    if bytes.len() < header_length()
        || &bytes[..STORE_VERSION.len()] != STORE_VERSION
        || bytes[STORE_VERSION.len()..STORE_VERSION.len() + 32] != bigram_frequency_digest()
        || read_u64(bytes, STORE_VERSION.len() + 32) != Some(generation)
    {
        return Err(corrupt(path));
    }
    Ok(())
}
