use crate::FileMutation;
use crate::TextFileFormat;
use crate::commit_file_mutations;
use crate::file_revision;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

/// A lease for the exact logical document read by a tool. Its owner retains the file format
/// and revision; the token must not be interpreted as a filesystem revision by callers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextDocumentSnapshot {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextDocumentContent {
    pub path: PathBuf,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextDocumentChange {
    Create {
        path: PathBuf,
        text: String,
    },
    Update {
        snapshot: String,
        text: String,
    },
    Delete {
        snapshot: String,
    },
    Move {
        snapshot: String,
        target: PathBuf,
        text: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextDocumentError {
    Unavailable,
    Conflict,
    Cancelled,
    Failed(String),
    OutcomeUnknown(String),
}

impl fmt::Display for TextDocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("the selected document source is unavailable"),
            Self::Conflict => formatter
                .write_str("the document changed after it was read; read it again before editing"),
            Self::Cancelled => formatter.write_str("document editing was cancelled"),
            Self::Failed(message) | Self::OutcomeUnknown(message) => formatter.write_str(message),
        }
    }
}
impl std::error::Error for TextDocumentError {}

/// One task's document source. Editor implementations own models and undo; filesystem
/// implementations own byte revisions. Successful application includes persistence.
pub trait TextDocumentEditor: Send + Sync {
    fn read(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<TextDocumentSnapshot>, TextDocumentError>;
    fn apply(
        &self,
        changes: Vec<TextDocumentChange>,
        cancellation: &CancellationToken,
    ) -> Result<(), TextDocumentError>;
    /// Unsaved documents that replace disk contents during a scoped search.
    fn open_documents(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Vec<TextDocumentContent>, TextDocumentError>;
    fn release(&self, snapshots: Vec<String>);
}

struct FileSnapshot {
    path: PathBuf,
    revision: String,
    bom: bool,
}

/// Directory-confined implementation for CLI, isolated and background environments.
pub struct FileTextDocuments {
    dir: Dir,
    snapshots: Mutex<BTreeMap<String, FileSnapshot>>,
}

impl FileTextDocuments {
    pub fn new(dir: Dir) -> Self {
        Self {
            dir,
            snapshots: Mutex::new(BTreeMap::new()),
        }
    }

    fn relative(&self, path: &Path) -> Result<PathBuf, TextDocumentError> {
        let relative = path
            .strip_prefix(self.dir.canonical_path())
            .map_err(|e| TextDocumentError::Failed(e.to_string()))?;
        self.dir
            .resolve_for_write(relative)
            .map_err(|e| TextDocumentError::Failed(e.to_string()))?;
        Ok(relative.to_path_buf())
    }
}

impl TextDocumentEditor for FileTextDocuments {
    fn read(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<TextDocumentSnapshot>, TextDocumentError> {
        if cancellation.is_cancelled() {
            return Err(TextDocumentError::Cancelled);
        }
        let relative = self.relative(path)?;
        let file = match self.dir.directory().handle().open(&relative) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(TextDocumentError::Failed(error.to_string())),
        };
        let mut bytes = Vec::new();
        file.take(10 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| TextDocumentError::Failed(e.to_string()))?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err(TextDocumentError::Failed(
                "document exceeds the text size limit".into(),
            ));
        }
        let revision = file_revision(&bytes);
        let text =
            String::from_utf8(bytes).map_err(|e| TextDocumentError::Failed(e.to_string()))?;
        if text.contains('\0') {
            return Err(TextDocumentError::Failed(
                "binary document cannot be edited as text".into(),
            ));
        }
        let bom = text.starts_with('\u{feff}');
        let id = format!("{}:{revision}", relative.display());
        self.snapshots
            .lock()
            .map_err(|e| TextDocumentError::Failed(e.to_string()))?
            .insert(
                id.clone(),
                FileSnapshot {
                    path: relative,
                    revision,
                    bom,
                },
            );
        Ok(Some(TextDocumentSnapshot {
            id,
            text: text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned(),
        }))
    }

    fn apply(
        &self,
        changes: Vec<TextDocumentChange>,
        cancellation: &CancellationToken,
    ) -> Result<(), TextDocumentError> {
        if cancellation.is_cancelled() {
            return Err(TextDocumentError::Cancelled);
        }
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|e| TextDocumentError::Failed(e.to_string()))?;
        let mutations = changes
            .into_iter()
            .map(|change| {
                let (id, text, target) = match change {
                    TextDocumentChange::Create { path, text } => {
                        let path = self.relative(&path)?;
                        let text = TextFileFormat::for_new_file(&self.dir, &path)
                            .map_err(|e| TextDocumentError::Failed(e.to_string()))?
                            .normalize(&text);
                        return Ok(FileMutation::Create {
                            path,
                            content: text.into_bytes(),
                        });
                    }
                    TextDocumentChange::Update { snapshot, text } => (snapshot, Some(text), None),
                    TextDocumentChange::Delete { snapshot } => (snapshot, None, None),
                    TextDocumentChange::Move {
                        snapshot,
                        target,
                        text,
                    } => (snapshot, Some(text), Some(target)),
                };
                let snapshot = snapshots.remove(&id).ok_or(TextDocumentError::Conflict)?;
                let content = text.map(|text| {
                    // Text tools never see the encoding marker; unchanged encoding belongs to this owner.
                    let mut bytes = if snapshot.bom {
                        vec![0xef, 0xbb, 0xbf]
                    } else {
                        Vec::new()
                    };
                    bytes.extend_from_slice(text.as_bytes());
                    bytes
                });
                match (content, target) {
                    (Some(content), Some(target)) => Ok(FileMutation::MoveAndReplace {
                        path: snapshot.path,
                        target: self.relative(&target)?,
                        content,
                        expected_revision: snapshot.revision,
                    }),
                    (Some(content), None) => Ok(FileMutation::Replace {
                        path: snapshot.path,
                        content,
                        expected_revision: snapshot.revision,
                    }),
                    (None, None) => Ok(FileMutation::Remove {
                        path: snapshot.path,
                        expected_revision: snapshot.revision,
                    }),
                    (None, Some(_)) => unreachable!("a move always has text"),
                }
            })
            .collect::<Result<Vec<_>, TextDocumentError>>()?;
        if cancellation.is_cancelled() {
            return Err(TextDocumentError::Cancelled);
        }
        commit_file_mutations(&self.dir, &mutations).map_err(|error| {
            if error.publication_started {
                TextDocumentError::OutcomeUnknown(error.to_string())
            } else if matches!(error.source, crate::FileSystemError::RevisionConflict(_)) {
                TextDocumentError::Conflict
            } else {
                TextDocumentError::Failed(error.to_string())
            }
        })
    }

    fn open_documents(
        &self,
        _: &Path,
        _: &CancellationToken,
    ) -> Result<Vec<TextDocumentContent>, TextDocumentError> {
        Ok(Vec::new())
    }

    fn release(&self, ids: Vec<String>) {
        let mut snapshots = self
            .snapshots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in ids {
            snapshots.remove(&id);
        }
    }
}

#[cfg(test)]
#[path = "text_document_tests.rs"]
mod tests;
