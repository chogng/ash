use crate::FastRegexError;
use crate::FastRegexSearchStorage;
use crate::binary_codec::Reader;
use crate::binary_codec::write_bytes;
use crate::binary_codec::write_grams;
use crate::binary_codec::write_path;
use crate::disk_index::DiskBaseIndex;
use crate::file_stamp::FileStamp;
use crate::index::IndexState;
use crate::index::IndexedDocument;
use crate::index::SortedPostings;
use crate::trigram;
use crate::trigram::format_digest;
use ash_immutable_generation_store::ExpectedCurrent;
use ash_immutable_generation_store::GenerationFile;
use ash_immutable_generation_store::ImmutableGenerationStore;
use ash_immutable_generation_store::PublishError;
use ash_immutable_generation_store::PublishOutcome;
use ash_immutable_generation_store::PublishReport;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::io::BufWriter;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

pub(crate) const STORE_VERSION: &[u8] = b"ash-fast-regex-v8\0";
const DELTA_FILE: &str = "delta.bin";
const DOCUMENTS_FILE: &str = "documents.bin";
const FORMAT_FILE: &str = "format.bin";
const LOOKUP_FILE: &str = "lookup.bin";
const POSTINGS_FILE: &str = "postings.bin";

pub(crate) fn load(storage: &FastRegexSearchStorage) -> Result<Option<IndexState>, FastRegexError> {
    let FastRegexSearchStorage::Persistent(directory) = storage else {
        return Ok(None);
    };
    let store = open_store(directory)?;
    let Some(snapshot) = store
        .open_current()
        .map_err(|source| store_error(directory, source))?
    else {
        return Ok(None);
    };
    let generation = snapshot.generation();
    let base_generation = snapshot.base_generation();
    let format_path = directory.join(FORMAT_FILE);
    let format = snapshot
        .read_base(FORMAT_FILE)
        .map_err(|source| io_error(&format_path, source))?;
    if !format_is_compatible(&format_path, &format, base_generation)? {
        return Ok(Some(IndexState {
            generation,
            requires_rebuild: true,
            ..IndexState::default()
        }));
    }
    let documents_path = directory.join(DOCUMENTS_FILE);
    let document_bytes = snapshot
        .read_base(DOCUMENTS_FILE)
        .map_err(|source| io_error(&documents_path, source))?;
    let (source_bytes, documents, document_paths, ids) =
        read_documents(&documents_path, &document_bytes, base_generation)?;
    let disk_base = DiskBaseIndex::open(&snapshot, directory, base_generation, ids)?;
    let mut state = IndexState {
        generation,
        base_generation,
        source_bytes,
        documents,
        next_document_id: document_paths.len() as u32,
        document_paths,
        postings: HashMap::new(),
        overlays: BTreeMap::new(),
        dirty_paths: BTreeSet::new(),
        disk_base: Some(Arc::new(disk_base)),
        requires_rebuild: false,
    };
    let delta_path = directory.join(DELTA_FILE);
    let delta = snapshot
        .read_layer(DELTA_FILE)
        .map_err(|source| io_error(&delta_path, source))?;
    apply_delta(&delta_path, &delta, &mut state)?;
    Ok(Some(state))
}

pub(crate) fn persist_sorted(
    directory: &Path,
    state: &IndexState,
    expected_generation: u64,
    mut sorted: SortedPostings,
) -> Result<Option<FastRegexError>, FastRegexError> {
    let mut documents = generation_header(state.generation);
    documents.extend_from_slice(&(state.source_bytes as u64).to_le_bytes());
    documents.extend_from_slice(&(state.documents.len() as u64).to_le_bytes());
    for (path, document) in &state.documents {
        write_path(&mut documents, path);
        documents.extend_from_slice(&(document.source_bytes as u64).to_le_bytes());
        documents.extend_from_slice(&document.stamp.length.to_le_bytes());
        documents.extend_from_slice(&document.stamp.modified_nanos.to_le_bytes());
        documents.extend_from_slice(&document.stamp.change_nanos.to_le_bytes());
        write_bytes(&mut documents, document.revision.as_bytes());
    }

    let (lookup, postings) = write_sorted_files(&mut sorted, state.generation)
        .map_err(|source| io_error(directory, source))?;

    let delta = delta_header(state.generation, state.generation, 0);
    open_store(directory)?
        .publish_base(
            expected_current(expected_generation),
            state.generation,
            &[
                GenerationFile::new(DOCUMENTS_FILE, &documents),
                GenerationFile::new(FORMAT_FILE, &generation_header(state.generation)),
                GenerationFile::from_file(POSTINGS_FILE, &postings),
                GenerationFile::from_file(LOOKUP_FILE, &lookup),
            ],
            &[GenerationFile::new(DELTA_FILE, &delta)],
        )
        .map(|report| publication_error(directory, report))
        .map_err(|source| publish_error(directory, source))
}

pub(crate) fn persist_delta(
    storage: &FastRegexSearchStorage,
    state: &IndexState,
    expected_generation: u64,
) -> Result<Option<FastRegexError>, FastRegexError> {
    let FastRegexSearchStorage::Persistent(directory) = storage else {
        return Ok(None);
    };
    let mut bytes = delta_header(
        state.base_generation,
        state.generation,
        state.dirty_paths.len(),
    );
    for path in &state.dirty_paths {
        write_path(&mut bytes, path);
        let Some(document) = state.documents.get(path) else {
            bytes.push(0);
            continue;
        };
        bytes.push(1);
        bytes.extend_from_slice(&(document.source_bytes as u64).to_le_bytes());
        bytes.extend_from_slice(&document.stamp.length.to_le_bytes());
        bytes.extend_from_slice(&document.stamp.modified_nanos.to_le_bytes());
        bytes.extend_from_slice(&document.stamp.change_nanos.to_le_bytes());
        write_bytes(&mut bytes, document.revision.as_bytes());
        write_grams(&mut bytes, &document.grams);
    }
    open_store(directory)?
        .publish_layer(
            expected_current(expected_generation),
            state.generation,
            &[GenerationFile::new(DELTA_FILE, &bytes)],
        )
        .map(|report| publication_error(directory, report))
        .map_err(|source| publish_error(directory, source))
}

fn apply_delta(path: &Path, bytes: &[u8], state: &mut IndexState) -> Result<(), FastRegexError> {
    let mut reader = Reader::new(path, bytes);
    if !reader.take(STORE_VERSION.len())?.eq(STORE_VERSION) || reader.take(32)? != format_digest() {
        return Err(corrupt(path));
    }
    let base_generation = reader.u64()?;
    let current_generation = reader.u64()?;
    let changed_count = reader.usize()?;
    if base_generation != state.base_generation || current_generation != state.generation {
        return Err(corrupt(path));
    }
    if changed_count > reader.remaining().len() / 5 {
        return Err(corrupt(path));
    }
    for _ in 0..changed_count {
        let changed_path = reader.path()?;
        if !is_safe_relative_path(&changed_path) {
            return Err(corrupt(path));
        }
        remove_stored_document(state, &changed_path);
        match reader.u8()? {
            0 => {}
            1 => {
                let document = IndexedDocument {
                    id: 0,
                    source_bytes: reader.usize()?,
                    stamp: FileStamp {
                        length: reader.u64()?,
                        modified_nanos: reader.u64()?,
                        change_nanos: reader.u64()?,
                    },
                    revision: reader.string()?,
                    grams: reader.grams()?,
                };
                insert_stored_document(state, changed_path.clone(), document);
            }
            _ => return Err(corrupt(path)),
        }
        state.dirty_paths.insert(changed_path);
    }
    reader.finish()?;
    state.generation = current_generation;
    Ok(())
}

fn remove_stored_document(state: &mut IndexState, path: &Path) {
    let Some(document) = state.documents.remove(path) else {
        return;
    };
    state.source_bytes = state.source_bytes.saturating_sub(document.source_bytes);
    state.document_paths.remove(&document.id);
    remove_stored_postings(&mut state.postings, document.id, &document.grams);
}

fn remove_stored_postings(postings: &mut HashMap<u64, Vec<u64>>, id: u32, grams: &[u64]) {
    for gram in grams {
        if let Some(ids) = postings.get_mut(&trigram::key(*gram)) {
            if let Ok(position) =
                ids.binary_search_by_key(&id, |entry| trigram::document_id(*entry))
            {
                ids.remove(position);
            }
            if ids.is_empty() {
                postings.remove(&trigram::key(*gram));
            }
        }
    }
}

fn insert_stored_document(state: &mut IndexState, path: PathBuf, mut document: IndexedDocument) {
    let id = state.next_document_id;
    state.next_document_id = state.next_document_id.saturating_add(1);
    document.id = id;
    for gram in &document.grams {
        state
            .postings
            .entry(trigram::key(*gram))
            .or_default()
            .push(trigram::posting(id, trigram::mask(*gram)));
    }
    state.source_bytes = state.source_bytes.saturating_add(document.source_bytes);
    state.document_paths.insert(id, path.clone());
    state.documents.insert(path, document);
}

fn write_sorted_files(
    sorted: &mut SortedPostings,
    generation: u64,
) -> io::Result<(fs::File, fs::File)> {
    let lookup_path = sorted.directory().join(LOOKUP_FILE);
    let postings_path = sorted.directory().join(POSTINGS_FILE);
    let mut lookup = BufWriter::with_capacity(256 * 1024, fs::File::create(&lookup_path)?);
    let mut postings = BufWriter::with_capacity(256 * 1024, fs::File::create(&postings_path)?);
    lookup.write_all(&generation_header(generation))?;
    lookup.write_all(&0u64.to_le_bytes())?;
    postings.write_all(&generation_header(generation))?;
    let mut current = None;
    let mut ids = Vec::new();
    let mut offset = 0u64;
    let mut entries = 0u64;
    for entry in sorted.by_ref() {
        let (gram, id) = entry?;
        if current.is_some_and(|previous| previous != gram) {
            write_posting_entry(&mut lookup, &mut postings, current.unwrap(), offset, &ids)?;
            offset += 4 + ids.len() as u64 * 5;
            entries += 1;
            ids.clear();
        }
        current = Some(gram);
        ids.push(id);
    }
    if let Some(gram) = current {
        write_posting_entry(&mut lookup, &mut postings, gram, offset, &ids)?;
        entries += 1;
    }
    lookup.seek(SeekFrom::Start(header_length() as u64))?;
    lookup.write_all(&entries.to_le_bytes())?;
    lookup.flush()?;
    postings.flush()?;
    Ok((fs::File::open(lookup_path)?, fs::File::open(postings_path)?))
}

fn write_posting_entry(
    lookup: &mut impl Write,
    postings: &mut impl Write,
    gram: u64,
    offset: u64,
    ids: &[u64],
) -> io::Result<()> {
    postings.write_all(&(ids.len() as u32).to_le_bytes())?;
    for entry in ids {
        postings.write_all(&trigram::document_id(*entry).to_le_bytes())?;
        postings.write_all(&[trigram::mask(*entry)])?;
    }
    lookup.write_all(&gram.to_le_bytes())?;
    lookup.write_all(&offset.to_le_bytes())?;
    lookup.write_all(&(ids.len() as u32).to_le_bytes())
}

type LoadedDocuments = (
    usize,
    BTreeMap<PathBuf, IndexedDocument>,
    BTreeMap<u32, PathBuf>,
    Vec<PathBuf>,
);

fn read_documents(
    path: &Path,
    bytes: &[u8],
    generation: u64,
) -> Result<LoadedDocuments, FastRegexError> {
    let bytes = read_generation_bytes(path, bytes, generation)?;
    let mut reader = Reader::new(path, bytes);
    let source_bytes = reader.usize()?;
    let document_count = reader.usize()?;
    if document_count > reader.remaining().len() / 40 {
        return Err(corrupt(path));
    }
    let mut documents = BTreeMap::new();
    let mut document_paths = BTreeMap::new();
    let mut ids = Vec::with_capacity(document_count);
    for id in 0..document_count {
        let path = reader.path()?;
        if !is_safe_relative_path(&path) {
            return Err(corrupt(reader.source_path()));
        }
        let document_source_bytes = reader.usize()?;
        let stamp = FileStamp {
            length: reader.u64()?,
            modified_nanos: reader.u64()?,
            change_nanos: reader.u64()?,
        };
        let revision = reader.string()?;
        if documents.contains_key(&path) {
            return Err(corrupt(reader.source_path()));
        }
        let id = u32::try_from(id).map_err(|_| corrupt(reader.source_path()))?;
        ids.push(path.clone());
        document_paths.insert(id, path.clone());
        documents.insert(
            path,
            IndexedDocument {
                id,
                revision,
                source_bytes: document_source_bytes,
                stamp,
                grams: Vec::new(),
            },
        );
    }
    reader.finish()?;
    let measured_source_bytes = documents.values().try_fold(0usize, |total, document| {
        total.checked_add(document.source_bytes)
    });
    if measured_source_bytes != Some(source_bytes) {
        return Err(corrupt(reader.source_path()));
    }
    Ok((source_bytes, documents, document_paths, ids))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let value = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_le_bytes(value))
}

pub(crate) fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let value = bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(u64::from_le_bytes(value))
}

pub(crate) fn header_length() -> usize {
    STORE_VERSION.len() + 32 + 8
}

fn read_generation_bytes<'a>(
    path: &Path,
    bytes: &'a [u8],
    generation: u64,
) -> Result<&'a [u8], FastRegexError> {
    if bytes.len() < header_length()
        || &bytes[..STORE_VERSION.len()] != STORE_VERSION
        || bytes[STORE_VERSION.len()..STORE_VERSION.len() + 32] != format_digest()
        || read_u64(bytes, STORE_VERSION.len() + 32) != Some(generation)
    {
        return Err(corrupt(path));
    }
    Ok(&bytes[header_length()..])
}

fn format_is_compatible(
    path: &Path,
    bytes: &[u8],
    generation: u64,
) -> Result<bool, FastRegexError> {
    if !bytes.starts_with(STORE_VERSION) {
        return Ok(false);
    }
    if bytes.len() != header_length() {
        return Err(corrupt(path));
    }
    if bytes[STORE_VERSION.len()..STORE_VERSION.len() + 32] != format_digest() {
        return Ok(false);
    }
    if read_u64(bytes, STORE_VERSION.len() + 32) != Some(generation) {
        return Err(corrupt(path));
    }
    Ok(true)
}

fn generation_header(generation: u64) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(header_length());
    bytes.extend_from_slice(STORE_VERSION);
    bytes.extend_from_slice(&format_digest());
    bytes.extend_from_slice(&generation.to_le_bytes());
    bytes
}

fn delta_header(base_generation: u64, generation: u64, changed_count: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(STORE_VERSION.len() + 32 + 24);
    bytes.extend_from_slice(STORE_VERSION);
    bytes.extend_from_slice(&format_digest());
    bytes.extend_from_slice(&base_generation.to_le_bytes());
    bytes.extend_from_slice(&generation.to_le_bytes());
    bytes.extend_from_slice(&(changed_count as u64).to_le_bytes());
    bytes
}

fn open_store(directory: &Path) -> Result<ImmutableGenerationStore, FastRegexError> {
    ImmutableGenerationStore::open(directory).map_err(|source| store_error(directory, source))
}

fn store_error(path: &Path, source: std::io::Error) -> FastRegexError {
    if source.kind() == std::io::ErrorKind::InvalidData {
        corrupt(path)
    } else {
        io_error(path, source)
    }
}

fn expected_current(generation: u64) -> ExpectedCurrent {
    if generation == 0 {
        ExpectedCurrent::Empty
    } else {
        ExpectedCurrent::Snapshot(generation)
    }
}

fn publish_error(path: &Path, error: PublishError) -> FastRegexError {
    match error {
        PublishError::Conflict { current } => FastRegexError::PublishConflict { current },
        PublishError::BeforeCommit { source } => store_error(path, source),
    }
}

fn publication_error(path: &Path, report: PublishReport) -> Option<FastRegexError> {
    match report.outcome {
        PublishOutcome::PublishedButDurabilityUnknown { source } => {
            Some(FastRegexError::PublishedButDurabilityUnknown {
                path: path.to_path_buf(),
                source,
            })
        }
        PublishOutcome::Published | PublishOutcome::AlreadyPublished => {
            report.cleanup_error.map(|source| FastRegexError::Cleanup {
                path: path.to_path_buf(),
                source,
            })
        }
    }
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

pub(crate) fn corrupt(path: &Path) -> FastRegexError {
    FastRegexError::CorruptIndex(path.to_path_buf())
}

pub(crate) fn io_error(path: &Path, source: std::io::Error) -> FastRegexError {
    FastRegexError::Io {
        path: path.to_path_buf(),
        source,
    }
}
