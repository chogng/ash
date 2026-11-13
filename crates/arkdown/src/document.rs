use crate::Error;
use crate::Node;
use crate::SourceIndex;
use crate::Utf16Range;
use crate::check_source_size;
use crate::parse;
use serde::Deserialize;
use serde::Serialize;
use std::collections::VecDeque;

const MAX_TRANSACTION_EDITS: usize = 4096;
const MAX_HISTORY_ENTRIES: usize = 256;
const MAX_HISTORY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextEdit {
    pub range: Utf16Range,
    pub text: String,
}

/// All edit ranges address the source at expected_revision, not intermediate text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transaction {
    pub expected_revision: u32,
    pub edits: Vec<TextEdit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Edit,
    Undo,
    Redo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Change {
    pub revision: u32,
    pub changed: bool,
    pub kind: ChangeKind,
    /// Applied edits in ascending order, with ranges in the preceding revision.
    pub edits: Vec<TextEdit>,
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub revision: u32,
    pub source: String,
    pub utf16_len: u32,
    pub nodes: Vec<Node>,
}

struct HistoryEntry {
    forward: Vec<TextEdit>,
    inverse: Vec<TextEdit>,
    bytes: usize,
}

struct PreparedEdit {
    range: std::ops::Range<usize>,
    forward: TextEdit,
    removed: String,
}

/// One owner of source, revision and local transaction history. Rendering is a
/// projection; callers never have to serialize the parsed tree back to Markdown.
pub struct Document {
    source: String,
    revision: u32,
    undo: VecDeque<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    history_bytes: usize,
}

impl Document {
    pub fn new(source: impl Into<String>) -> Result<Self, Error> {
        let source = source.into();
        check_source_size(source.len())?;
        Ok(Self {
            source,
            revision: 0,
            undo: VecDeque::new(),
            redo: Vec::new(),
            history_bytes: 0,
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn revision(&self) -> u32 {
        self.revision
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn snapshot(&self) -> Result<Snapshot, Error> {
        Ok(Snapshot {
            revision: self.revision,
            source: self.source.clone(),
            utf16_len: self.source.encode_utf16().count() as u32,
            nodes: parse(&self.source)?,
        })
    }

    pub fn apply(&mut self, transaction: Transaction) -> Result<Change, Error> {
        self.check_revision(transaction.expected_revision)?;
        let (next_source, entry) = self.prepare(transaction.edits)?;
        if entry.forward.is_empty() {
            return Ok(self.unchanged(ChangeKind::Edit));
        }
        let revision = self.next_revision()?;
        let edits = entry.forward.clone();
        // All fallible validation completes before state or history is changed.
        self.source = next_source;
        self.revision = revision;
        for entry in self.redo.drain(..) {
            self.history_bytes -= entry.bytes;
        }
        self.history_bytes += entry.bytes;
        self.undo.push_back(entry);
        while self.undo.len() > MAX_HISTORY_ENTRIES || self.history_bytes > MAX_HISTORY_BYTES {
            self.history_bytes -= self
                .undo
                .pop_front()
                .expect("history exceeds its bound")
                .bytes;
        }
        Ok(Change {
            revision,
            changed: true,
            kind: ChangeKind::Edit,
            edits,
        })
    }

    pub fn undo(&mut self, expected_revision: u32) -> Result<Change, Error> {
        self.check_revision(expected_revision)?;
        let Some(entry) = self.undo.back() else {
            return Ok(self.unchanged(ChangeKind::Undo));
        };
        let (source, prepared) = self.prepare(entry.inverse.clone())?;
        let revision = self.next_revision()?;
        let entry = self.undo.pop_back().expect("entry was validated");
        self.source = source;
        self.revision = revision;
        self.redo.push(entry);
        Ok(Change {
            revision,
            changed: true,
            kind: ChangeKind::Undo,
            edits: prepared.forward,
        })
    }

    pub fn redo(&mut self, expected_revision: u32) -> Result<Change, Error> {
        self.check_revision(expected_revision)?;
        let Some(entry) = self.redo.last() else {
            return Ok(self.unchanged(ChangeKind::Redo));
        };
        let (source, prepared) = self.prepare(entry.forward.clone())?;
        let revision = self.next_revision()?;
        let entry = self.redo.pop().expect("entry was validated");
        self.source = source;
        self.revision = revision;
        self.undo.push_back(entry);
        Ok(Change {
            revision,
            changed: true,
            kind: ChangeKind::Redo,
            edits: prepared.forward,
        })
    }

    fn check_revision(&self, expected: u32) -> Result<(), Error> {
        if expected != self.revision {
            Err(Error::RevisionMismatch {
                expected,
                actual: self.revision,
            })
        } else {
            Ok(())
        }
    }

    fn next_revision(&self) -> Result<u32, Error> {
        self.revision.checked_add(1).ok_or(Error::RevisionExhausted)
    }

    fn unchanged(&self, kind: ChangeKind) -> Change {
        Change {
            revision: self.revision,
            changed: false,
            kind,
            edits: Vec::new(),
        }
    }

    fn prepare(&self, mut edits: Vec<TextEdit>) -> Result<(String, HistoryEntry), Error> {
        if edits.len() > MAX_TRANSACTION_EDITS {
            return Err(Error::TooManyEdits {
                count: edits.len(),
                limit: MAX_TRANSACTION_EDITS,
            });
        }
        let index = SourceIndex::new(&self.source)?;
        edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
        let mut prepared = Vec::new();
        let mut previous: Option<Utf16Range> = None;
        let mut next_len = self.source.len();
        for forward in edits {
            let range = index.byte_range(forward.range)?;
            if previous.is_some_and(|prior| {
                forward.range.start < prior.end || forward.range.start == prior.start
            }) {
                return Err(Error::OverlappingEdits);
            }
            previous = Some(forward.range);
            if self.source[range.clone()] == forward.text {
                continue;
            }
            next_len -= range.len();
            next_len = next_len
                .checked_add(forward.text.len())
                .ok_or(Error::SourceTooLarge {
                    bytes: usize::MAX,
                    limit: crate::MAX_SOURCE_BYTES,
                })?;
            prepared.push(PreparedEdit {
                removed: self.source[range.clone()].to_owned(),
                range,
                forward,
            });
        }
        check_source_size(next_len)?;
        let mut source = self.source.clone();
        for edit in prepared.iter().rev() {
            source.replace_range(edit.range.clone(), &edit.forward.text);
        }
        let mut forward = Vec::new();
        let mut inverse: Vec<TextEdit> = Vec::new();
        let mut delta: i64 = 0;
        let mut bytes = 0;
        for edit in prepared {
            let range = edit.forward.range;
            let start = (i64::from(range.start) + delta) as u32;
            let inserted_units = edit.forward.text.encode_utf16().count() as u32;
            delta += i64::from(inserted_units) - i64::from(range.end - range.start);
            bytes += edit.removed.len() + edit.forward.text.len();
            // Adjacent deletions collapse to the same insertion point in the new
            // source. Merge inverse ranges so undo has one unambiguous edit there.
            if let Some(prior) = inverse.last_mut().filter(|prior| prior.range.end == start) {
                prior.range.end = start + inserted_units;
                prior.text.push_str(&edit.removed);
            } else {
                inverse.push(TextEdit {
                    range: Utf16Range {
                        start,
                        end: start + inserted_units,
                    },
                    text: edit.removed,
                });
            }
            forward.push(edit.forward);
        }
        Ok((
            source,
            HistoryEntry {
                forward,
                inverse,
                bytes,
            },
        ))
    }
}
