use std::fs;
use std::io;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use ash_utils_path::CanonicalContainmentError;
use ash_utils_path::CanonicalPathRoot;

use crate::AgentImportDiagnostic;
use crate::AgentImportDiagnosticCode as Code;
use crate::AgentImportError;
use crate::AgentImportLocation;
use crate::ImportItemKind;
use crate::agent_paths::ExpectedEntryKind;

pub(crate) const MAX_FILE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_SOURCE_BYTES: usize = 16 * MAX_FILE_BYTES;
pub(crate) const MAX_DIRECTORY_ENTRIES: usize = 1024;
pub(crate) const MAX_SOURCE_ENTRIES: usize = 4096;
pub(crate) const MAX_PATH_DEPTH: usize = 16;
pub(crate) const MAX_DOCUMENT_DEPTH: usize = 64;
pub(crate) const MAX_DOCUMENT_NODES: usize = 65_536;

/// Checked reads, traversal budgets and isolated diagnostics for one selected source root.
pub(crate) struct Source {
    pub(crate) location: AgentImportLocation,
    root: CanonicalPathRoot,
    pub(crate) diagnostics: Vec<AgentImportDiagnostic>,
    bytes_read: usize,
    entries_read: usize,
}

pub(crate) struct Document<T> {
    pub(crate) path: PathBuf,
    pub(crate) value: T,
}

pub(crate) struct Directory {
    pub(crate) path: PathBuf,
    pub(crate) entries: Vec<Entry>,
}

pub(crate) struct Entry {
    pub(crate) relative_path: PathBuf,
    pub(crate) path: PathBuf,
    pub(crate) kind: ExpectedEntryKind,
}

impl Source {
    pub(crate) fn new(location: AgentImportLocation) -> Result<Self, AgentImportError> {
        let root = crate::inspect_path::validate_import_root(&location)?;
        Ok(Self {
            location,
            root,
            diagnostics: Vec::new(),
            bytes_read: 0,
            entries_read: 0,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        self.root.path()
    }

    pub(crate) fn diagnose(&mut self, path: &Path, kind: ImportItemKind, code: Code) {
        self.diagnostics.push(AgentImportDiagnostic::new(
            &self.location,
            kind,
            path.to_path_buf(),
            code,
        ));
    }

    pub(crate) fn read<T>(
        &mut self,
        path: &Path,
        kind: ImportItemKind,
        parse: impl FnOnce(&str) -> Result<T, Code>,
    ) -> Option<Document<T>> {
        let result = self.read_text(path).and_then(|document| {
            document
                .map(|document| {
                    Ok(Document {
                        path: document.path,
                        value: parse(&document.value)?,
                    })
                })
                .transpose()
        });
        match result {
            Ok(document) => document,
            Err(code) => {
                self.diagnose(path, kind, code);
                None
            }
        }
    }

    fn read_text(&mut self, relative: &Path) -> Result<Option<Document<String>>, Code> {
        let Some(path) = self.checked_path(relative, ExpectedEntryKind::File)? else {
            return Ok(None);
        };
        let file = fs::File::open(&path).map_err(|_| Code::MetadataUnavailable)?;
        let metadata = file.metadata().map_err(|_| Code::MetadataUnavailable)?;
        if !metadata.is_file() {
            return Err(Code::UnexpectedFileType);
        }
        let limit = MAX_FILE_BYTES.min(MAX_SOURCE_BYTES.saturating_sub(self.bytes_read));
        if metadata.len() > limit as u64 {
            return Err(Code::LimitExceeded);
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Code::MetadataUnavailable)?;
        self.bytes_read = self.bytes_read.saturating_add(bytes.len());
        if bytes.len() > limit {
            return Err(Code::LimitExceeded);
        }
        let value = String::from_utf8(bytes).map_err(|_| Code::InvalidContent)?;
        Ok(Some(Document { path, value }))
    }

    pub(crate) fn directory(&mut self, path: &Path, kind: ImportItemKind) -> Option<Directory> {
        match self.read_directory(path, kind) {
            Ok(directory) => directory,
            Err(code) => {
                self.diagnose(path, kind, code);
                None
            }
        }
    }

    fn read_directory(
        &mut self,
        relative: &Path,
        kind: ImportItemKind,
    ) -> Result<Option<Directory>, Code> {
        let Some(path) = self.checked_path(relative, ExpectedEntryKind::Directory)? else {
            return Ok(None);
        };
        let directory = fs::read_dir(&path).map_err(|_| Code::MetadataUnavailable)?;
        let mut entries = Vec::new();
        for (index, entry) in directory.enumerate() {
            self.entries_read = self.entries_read.saturating_add(1);
            if index >= MAX_DIRECTORY_ENTRIES || self.entries_read > MAX_SOURCE_ENTRIES {
                return Err(Code::LimitExceeded);
            }
            entries.push(entry.map_err(|_| Code::MetadataUnavailable)?);
        }
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut checked = Vec::new();
        for entry in entries {
            let relative = relative.join(entry.file_name());
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.diagnose(&relative, kind, Code::MetadataUnavailable);
                    continue;
                }
            };
            let expected = if metadata.is_dir() {
                ExpectedEntryKind::Directory
            } else {
                ExpectedEntryKind::File
            };
            match self.checked_path(&relative, expected) {
                Ok(Some(path)) => checked.push(Entry {
                    relative_path: relative,
                    path,
                    kind: expected,
                }),
                Ok(None) => {}
                Err(code) => self.diagnose(&relative, kind, code),
            }
        }
        Ok(Some(Directory {
            path,
            entries: checked,
        }))
    }

    fn checked_path(
        &self,
        relative: &Path,
        expected: ExpectedEntryKind,
    ) -> Result<Option<PathBuf>, Code> {
        let components: Vec<_> = relative.components().collect();
        if components.len() > MAX_PATH_DEPTH {
            return Err(Code::LimitExceeded);
        }
        let mut candidate = self.root.path().to_path_buf();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(Code::EscapesSelectedRoot);
            };
            candidate.push(name);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(Code::MetadataUnavailable),
            };
            if metadata.is_symlink() {
                return Err(Code::SymlinkNotAllowed);
            }
            let matches =
                if index + 1 < components.len() || expected == ExpectedEntryKind::Directory {
                    metadata.is_dir()
                } else {
                    metadata.is_file()
                };
            if !matches {
                return Err(Code::UnexpectedFileType);
            }
        }
        self.root
            .canonicalize_within(candidate)
            .map(Some)
            .map_err(|error| match error {
                CanonicalContainmentError::OutsideRoot => Code::EscapesSelectedRoot,
                CanonicalContainmentError::Unavailable(_) => Code::MetadataUnavailable,
            })
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod tests;
