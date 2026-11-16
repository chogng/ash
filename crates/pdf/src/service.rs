use crate::EngineRequest;
use crate::MAX_CHUNK_BYTES;
use crate::MAX_FILE_BYTES;
use crate::PdfAnnotationEdit;
use crate::PdfError;
use crate::PdfOutput;
use crate::PdfPage;
use crate::worker;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

/// Owns bounded, connection-local PDF working snapshots. Only authorized bytes enter;
/// source paths and exports stay private to this domain. Project enumeration never
/// opens PDFium documents. Native documents and page caches are both independently bounded.
pub struct PdfService {
    executable: PathBuf,
    documents: Mutex<BTreeMap<(u64, String), Arc<Document>>>,
}

struct Document {
    expected: usize,
    cancelled: AtomicBool,
    state: Mutex<DocumentState>,
}

struct DocumentState {
    // Drop the worker before its backing files, including on Windows.
    worker: worker::Handle,
    directory: tempfile::TempDir,
    source: PathBuf,
    uploaded: usize,
    revision: u32,
    sequence: u64,
    pages: VecDeque<CachedPage>,
}

struct CachedPage {
    dimension: u32,
    metadata: PdfPage,
    image: PathBuf,
}

impl DocumentState {
    fn new() -> Result<Self, PdfError> {
        let directory = tempfile::Builder::new()
            .prefix("ash-pdf-")
            .tempdir()
            .map_err(failed)?;
        let source = directory.path().join("source-0.pdf");
        File::create(&source).map_err(failed)?;
        Ok(Self {
            worker: worker::handle()?,
            directory,
            source,
            uploaded: 0,
            revision: 0,
            sequence: 0,
            pages: VecDeque::new(),
        })
    }
}

impl Drop for DocumentState {
    fn drop(&mut self) {
        worker::release(&self.worker);
    }
}

impl PdfService {
    pub fn is_available(&self) -> bool {
        crate::engine::library_path().is_ok()
    }

    pub fn new(executable: PathBuf) -> Self {
        Self {
            executable,
            documents: Mutex::default(),
        }
    }

    pub fn open(&self, owner: u64, id: &str, size: usize) -> Result<(), PdfError> {
        if id.is_empty() || id.len() > 128 || !(1..=MAX_FILE_BYTES).contains(&size) {
            return Err(PdfError::Invalid);
        }
        let mut documents = self.documents.lock().map_err(failed)?;
        if documents.contains_key(&(owner, id.into())) {
            return Err(PdfError::Conflict);
        }
        if documents.len() >= 16 {
            return Err(PdfError::Capacity);
        }
        let own: Vec<_> = documents
            .iter()
            .filter(|((candidate, _), _)| *candidate == owner)
            .collect();
        if own.len() >= 8
            || own
                .iter()
                .map(|(_, document)| document.expected)
                .sum::<usize>()
                + size
                > 256 * 1024 * 1024
        {
            return Err(PdfError::Capacity);
        }
        documents.insert(
            (owner, id.into()),
            Arc::new(Document {
                expected: size,
                cancelled: AtomicBool::new(false),
                state: Mutex::new(DocumentState::new()?),
            }),
        );
        Ok(())
    }

    pub fn append(
        &self,
        owner: u64,
        id: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Result<usize, PdfError> {
        let document = self.document(owner, id)?;
        let mut state = document.state.lock().map_err(failed)?;
        if document.cancelled.load(Ordering::Acquire) {
            return Err(PdfError::Cancelled);
        }
        if bytes.is_empty()
            || bytes.len() > MAX_CHUNK_BYTES
            || state.uploaded != offset
            || offset + bytes.len() > document.expected
            || state.revision != 0
        {
            return Err(PdfError::Invalid);
        }
        OpenOptions::new()
            .append(true)
            .open(&state.source)
            .map_err(failed)?
            .write_all(bytes)
            .map_err(failed)?;
        state.uploaded += bytes.len();
        Ok(state.uploaded)
    }

    pub fn page(
        &self,
        owner: u64,
        id: &str,
        revision: u32,
        page: u32,
        dimension: u32,
        edit: Option<PdfAnnotationEdit>,
    ) -> Result<PdfPage, PdfError> {
        let document = self.document(owner, id)?;
        let mut state = document.state.lock().map_err(failed)?;
        if state.revision != revision {
            return Err(PdfError::Conflict);
        }
        if page == 0 || !(256..=2048).contains(&dimension) || state.uploaded != document.expected {
            return Err(PdfError::Invalid);
        }
        if document.cancelled.load(Ordering::Acquire) {
            return Err(PdfError::Cancelled);
        }
        if edit.is_none() {
            if let Some(index) = state
                .pages
                .iter()
                .position(|cached| cached.metadata.page == page && cached.dimension == dimension)
            {
                let cached = state.pages.remove(index).ok_or(PdfError::NotFound)?;
                let result = cached.metadata.clone();
                state.pages.push_back(cached);
                return Ok(result);
            }
        }
        self.perform(&mut state, page, dimension, PdfOutput::Image, edit, &|| {
            document.cancelled.load(Ordering::Acquire)
        })
    }

    fn perform(
        &self,
        state: &mut DocumentState,
        page: u32,
        dimension: u32,
        output: PdfOutput,
        edit: Option<PdfAnnotationEdit>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<PdfPage, PdfError> {
        state.sequence = state.sequence.checked_add(1).ok_or(PdfError::Capacity)?;
        let image = state
            .directory
            .path()
            .join(format!("page-{}.png", state.sequence));
        let modified = edit.as_ref().map(|_| {
            state
                .directory
                .path()
                .join(format!("source-{}.pdf", state.sequence))
        });
        let request = EngineRequest {
            source: state.source.clone(),
            image: image.clone(),
            modified: modified.clone(),
            page,
            dimension,
            output,
            edit,
        };
        let result = worker::run(&state.worker, &self.executable, &request, cancelled);
        // Failed edits may have changed native memory. Discard that helper and all
        // uncommitted artifacts; reopening always uses the last committed snapshot.
        let result = match result {
            Ok(result) if !cancelled() => result,
            other => {
                worker::release(&state.worker);
                let _ = std::fs::remove_file(&image);
                if let Some(path) = modified {
                    let _ = std::fs::remove_file(path);
                }
                return Err(other.err().unwrap_or(PdfError::Cancelled));
            }
        };
        let mut metadata = result.page;
        let image_size = if matches!(output, PdfOutput::Image) {
            std::fs::metadata(&image).map_err(failed)?.len() as usize
        } else {
            0
        };
        if image_size != metadata.image_size || image_size > 16 * 1024 * 1024 {
            worker::release(&state.worker);
            return Err(PdfError::Failed("Invalid PDF worker image".into()));
        }
        if let Some(path) = modified {
            // Closing the old native reader before removing its source is required on
            // Windows. Read-only page navigation retains its reader and avoids reparsing.
            worker::release(&state.worker);
            let size = std::fs::metadata(&path).map_err(failed)?.len() as usize;
            if size != metadata.file_size || size > MAX_FILE_BYTES {
                return Err(PdfError::Failed("Invalid PDF worker document".into()));
            }
            std::fs::remove_file(&state.source).map_err(failed)?;
            state.source = path;
            state.revision = state.revision.checked_add(1).ok_or(PdfError::Capacity)?;
            for cached in state.pages.drain(..) {
                let _ = std::fs::remove_file(cached.image);
            }
        }
        metadata.revision = state.revision;
        if matches!(output, PdfOutput::Image) {
            state.pages.push_back(CachedPage {
                dimension,
                metadata: metadata.clone(),
                image,
            });
            // Two rendered pages per open document; PNG bytes remain on disk. Never
            // retain a bitmap or DOM layer for each page of a thousand-page document.
            while state.pages.len() > 2 {
                if let Some(cached) = state.pages.pop_front() {
                    let _ = std::fs::remove_file(cached.image);
                }
            }
        }
        Ok(metadata)
    }

    /// Reads bounded chunks without reconstructing the complete source or PNG in memory.
    pub fn read(
        &self,
        owner: u64,
        id: &str,
        revision: u32,
        image: bool,
        image_sha256: Option<&str>,
        offset: usize,
        maximum: usize,
    ) -> Result<(Vec<u8>, bool), PdfError> {
        if !(1..=MAX_CHUNK_BYTES).contains(&maximum) {
            return Err(PdfError::Invalid);
        }
        let document = self.document(owner, id)?;
        let state = document.state.lock().map_err(failed)?;
        if document.cancelled.load(Ordering::Acquire) {
            return Err(PdfError::Cancelled);
        }
        if state.revision != revision {
            return Err(PdfError::Conflict);
        }
        let path = if image {
            &state
                .pages
                .iter()
                .find(|page| Some(page.metadata.image_sha256.as_str()) == image_sha256)
                .ok_or(PdfError::Conflict)?
                .image
        } else {
            &state.source
        };
        let mut file = File::open(path).map_err(failed)?;
        let length = file.metadata().map_err(failed)?.len() as usize;
        if offset > length {
            return Err(PdfError::Invalid);
        }
        file.seek(SeekFrom::Start(offset as u64)).map_err(failed)?;
        let mut bytes = vec![0; maximum.min(length - offset)];
        file.read_exact(&mut bytes).map_err(failed)?;
        let eof = offset + bytes.len() == length;
        Ok((bytes, eof))
    }

    /// Cancellation is published before waiting for the state lock or helper shutdown.
    pub fn close(&self, owner: u64, id: &str) {
        let document = self
            .documents
            .lock()
            .ok()
            .and_then(|mut documents| documents.remove(&(owner, id.into())));
        if let Some(document) = document {
            document.cancelled.store(true, Ordering::Release);
        }
    }

    pub fn close_owner(&self, owner: u64) {
        let removed = if let Ok(mut documents) = self.documents.lock() {
            let keys: Vec<_> = documents
                .keys()
                .filter(|(candidate, _)| *candidate == owner)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| documents.remove(&key))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for document in &removed {
            document.cancelled.store(true, Ordering::Release);
        }
    }

    fn document(&self, owner: u64, id: &str) -> Result<Arc<Document>, PdfError> {
        self.documents
            .lock()
            .map_err(failed)?
            .get(&(owner, id.into()))
            .cloned()
            .ok_or(PdfError::NotFound)
    }

    /// Processes an authorized saved snapshot. Text-only Agent reads skip rasterization,
    /// PNG encoding and character positioning while retaining text and annotation evidence.
    pub fn process(
        &self,
        bytes: &[u8],
        page: u32,
        output: PdfOutput,
        edit: Option<PdfAnnotationEdit>,
        cancelled: impl Fn() -> bool,
    ) -> Result<(PdfPage, Vec<u8>, Option<Vec<u8>>), PdfError> {
        if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
            return Err(PdfError::Invalid);
        }
        if cancelled() {
            return Err(PdfError::Cancelled);
        }
        let mut state = DocumentState::new()?;
        std::fs::write(&state.source, bytes).map_err(failed)?;
        let modified = edit.is_some();
        let metadata = self.perform(&mut state, page, 1600, output, edit, &cancelled)?;
        let image = state
            .pages
            .back()
            .map(|page| std::fs::read(&page.image).map_err(failed))
            .transpose()?
            .unwrap_or_default();
        let bytes = if modified {
            Some(std::fs::read(&state.source).map_err(failed)?)
        } else {
            None
        };
        Ok((metadata, image, bytes))
    }
}

impl Drop for PdfService {
    fn drop(&mut self) {
        if let Ok(documents) = self.documents.get_mut() {
            for document in documents.values() {
                document.cancelled.store(true, Ordering::Release);
            }
        }
    }
}

fn failed(error: impl std::fmt::Display) -> PdfError {
    PdfError::Failed(error.to_string())
}
