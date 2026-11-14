use crate::Change;
use crate::ChangeKind;
use crate::Document;
use crate::Error;
use crate::TextEdit;
use crate::Transaction;
use crate::Utf16Range;
use crate::check_source_size;
use yrs::Doc;
use yrs::GetString;
use yrs::OffsetKind;
use yrs::Options;
use yrs::ReadTxn;
use yrs::StateVector;
use yrs::Text;
use yrs::TextRef;
use yrs::Transact;
use yrs::UndoManager;
use yrs::Update;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;

const MAX_UPDATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_HISTORY_OPERATIONS: usize = 256;
const MAX_HISTORY_BYTES: usize = 16 * 1024 * 1024;
const LOCAL_ORIGIN: &str = "arkdown.local";

/// A collaborative session's source and selective history owner. Peers join by
/// applying a seed update, never by independently inserting the same initial text.
/// Persistence, peer identity allocation and transport belong to the host.
pub struct Buffer {
    doc: Doc,
    text: TextRef,
    history: UndoManager,
    revision: u32,
    history_operations: usize,
    history_bytes: usize,
}

impl Buffer {
    pub fn new(client_id: u64, source: &str) -> Result<Self, Error> {
        if client_id == 0 || client_id > (1_u64 << 53) - 1 {
            return Err(invalid(
                "Client ID must be a nonzero JavaScript-safe integer",
            ));
        }
        check_source_size(source.len())?;
        let doc = new_doc(client_id);
        let text = doc.get_or_insert_text("markdown");
        text.insert(&mut doc.transact_mut_with("arkdown.seed"), 0, source);
        let mut history = UndoManager::with_scope_and_options(&doc, &text, history_options());
        history.include_origin(LOCAL_ORIGIN);
        Ok(Self {
            doc,
            text,
            history,
            revision: 0,
            history_operations: 0,
            history_bytes: 0,
        })
    }

    pub fn source(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }
    pub fn revision(&self) -> u32 {
        self.revision
    }
    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }
    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn apply(&mut self, transaction: Transaction) -> Result<Change, Error> {
        self.check_revision(transaction.expected_revision)?;
        let mut proposal = Document::new(self.source())?;
        let mut change = proposal.apply(Transaction {
            expected_revision: 0,
            edits: transaction.edits,
        })?;
        if change.changed {
            let next = self.next_revision()?;
            let old = self.source();
            let index = crate::SourceIndex::new(&old).unwrap();
            let bytes = change
                .edits
                .iter()
                .map(|edit| {
                    let start = index.utf16_to_byte(edit.range.start).unwrap();
                    let end = index.utf16_to_byte(edit.range.end).unwrap();
                    (end - start) as usize + edit.text.len()
                })
                .sum::<usize>();
            // Checkpoint whole capture segments. Clearing the manager releases its
            // retained deletion contents; CRDT clocks and operation identities survive GC.
            if self.history_operations >= MAX_HISTORY_OPERATIONS
                || self.history_bytes.saturating_add(bytes) > MAX_HISTORY_BYTES
            {
                self.history.clear();
                self.history_operations = 0;
                self.history_bytes = 0;
                self.compact();
            }
            self.history_operations += 1;
            self.history_bytes = self.history_bytes.saturating_add(bytes);
            self.history.reset();
            {
                let mut txn = self.doc.transact_mut_with(LOCAL_ORIGIN);
                for edit in change.edits.iter().rev() {
                    if edit.range.end > edit.range.start {
                        self.text.remove_range(
                            &mut txn,
                            edit.range.start,
                            edit.range.end - edit.range.start,
                        );
                    }
                    if !edit.text.is_empty() {
                        self.text.insert(&mut txn, edit.range.start, &edit.text);
                    }
                }
            }
            self.history.reset();
            if bytes > MAX_HISTORY_BYTES {
                self.history.clear();
                self.history_operations = 0;
                self.history_bytes = 0;
            }
            self.revision = next;
            self.compact();
        }
        change.revision = self.revision;
        Ok(change)
    }

    /// Releases deleted content outside the retained undo window without replacing CRDT identities.
    pub fn compact(&mut self) {
        self.doc.transact_mut().gc(None);
    }

    /// Computes wire sizes against an isolated replica before any source/history mutation.
    pub fn preview(&self, action: BufferAction, vector: &[u8]) -> Result<BufferSizes, Error> {
        if vector.len() > MAX_UPDATE_BYTES {
            return Err(invalid("State vector exceeds 32 MiB"));
        }
        let staged = new_doc(self.doc.client_id().get());
        let text = staged.get_or_insert_text("markdown");
        let state = self.encode_update(&[])?;
        staged
            .transact_mut()
            .apply_update(Update::decode_v1(&state).map_err(|_| invalid("Invalid state"))?)
            .map_err(|_| invalid("Invalid state"))?;
        let mut options = history_options();
        options.init_undo_stack = self.history.undo_stack().to_vec();
        options.init_redo_stack = self.history.redo_stack().to_vec();
        let mut history = UndoManager::with_scope_and_options(&staged, &text, options);
        match action {
            BufferAction::Edit { edits } => {
                let mut proposal = Document::new(self.source())?;
                let change = proposal.apply(Transaction {
                    expected_revision: 0,
                    edits,
                })?;
                let mut txn = staged.transact_mut();
                for edit in change.edits.iter().rev() {
                    if edit.range.end > edit.range.start {
                        text.remove_range(
                            &mut txn,
                            edit.range.start,
                            edit.range.end - edit.range.start,
                        );
                    }
                    if !edit.text.is_empty() {
                        text.insert(&mut txn, edit.range.start, &edit.text);
                    }
                }
            }
            BufferAction::Undo => {
                history.undo_blocking();
            }
            BufferAction::Redo => {
                history.redo_blocking();
            }
        }
        check_source_size(text.get_string(&staged.transact()).len())?;
        let vector = if vector.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(vector).map_err(|_| invalid("Invalid state vector"))?
        };
        let txn = staged.transact();
        Ok(BufferSizes {
            snapshot_bytes: txn.encode_state_as_update_v1(&StateVector::default()).len(),
            update_bytes: txn.encode_state_as_update_v1(&vector).len(),
        })
    }

    /// Yjs/Yrs v1 updates are idempotent and may arrive out of order. Validate on
    /// an isolated replica first so malformed or oversized updates cannot poison
    /// the live session or consume its local undo history.
    pub fn apply_update(&mut self, bytes: &[u8]) -> Result<Change, Error> {
        if bytes.len() > MAX_UPDATE_BYTES {
            return Err(invalid("Collaboration update exceeds 32 MiB"));
        }
        let update =
            Update::decode_v1(bytes).map_err(|_| invalid("Invalid collaboration update"))?;
        let staged = new_doc(1);
        let text = staged.get_or_insert_text("markdown");
        {
            let state = self
                .doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let mut txn = staged.transact_mut();
            txn.apply_update(
                Update::decode_v1(&state).map_err(|_| invalid("Invalid session state"))?,
            )
            .map_err(|_| invalid("Invalid session state"))?;
            txn.apply_update(update)
                .map_err(|_| invalid("Invalid collaboration update"))?;
        }
        let next_source = text.get_string(&staged.transact());
        check_source_size(next_source.len())?;
        let old = self.source();
        let changed = old != next_source;
        let revision = if changed {
            self.next_revision()?
        } else {
            self.revision
        };
        self.doc
            .transact_mut_with("arkdown.remote")
            .apply_update(
                Update::decode_v1(bytes).map_err(|_| invalid("Invalid collaboration update"))?,
            )
            .map_err(|_| invalid("Invalid collaboration update"))?;
        self.revision = revision;
        self.compact();
        Ok(Change {
            revision,
            changed,
            kind: ChangeKind::External,
            edits: difference(&old, &next_source),
        })
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    pub fn encode_update(&self, state_vector: &[u8]) -> Result<Vec<u8>, Error> {
        if state_vector.len() > MAX_UPDATE_BYTES {
            return Err(invalid("State vector exceeds 32 MiB"));
        }
        let vector = if state_vector.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(state_vector).map_err(|_| invalid("Invalid state vector"))?
        };
        Ok(self.doc.transact().encode_state_as_update_v1(&vector))
    }

    pub fn undo(&mut self, expected_revision: u32) -> Result<Change, Error> {
        self.history_change(expected_revision, ChangeKind::Undo)
    }
    pub fn redo(&mut self, expected_revision: u32) -> Result<Change, Error> {
        self.history_change(expected_revision, ChangeKind::Redo)
    }

    fn history_change(
        &mut self,
        expected_revision: u32,
        kind: ChangeKind,
    ) -> Result<Change, Error> {
        self.check_revision(expected_revision)?;
        let old = self.source();
        // Preview selective history against the same CRDT IDs before mutation;
        // restoring a local deletion after remote insertions can exceed the limit.
        let staged = new_doc(self.doc.client_id().get());
        let text = staged.get_or_insert_text("markdown");
        let state = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        staged
            .transact_mut()
            .apply_update(Update::decode_v1(&state).map_err(|_| invalid("Invalid session state"))?)
            .map_err(|_| invalid("Invalid session state"))?;
        let mut options = history_options();
        options.init_undo_stack = self.history.undo_stack().to_vec();
        options.init_redo_stack = self.history.redo_stack().to_vec();
        let mut preview = UndoManager::with_scope_and_options(&staged, &text, options);
        match kind {
            ChangeKind::Undo => {
                preview.undo_blocking();
            }
            ChangeKind::Redo => {
                preview.redo_blocking();
            }
            ChangeKind::Edit | ChangeKind::External => unreachable!(),
        }
        check_source_size(text.get_string(&staged.transact()).len())?;
        // Check exhaustion before asking Yrs to mutate history.
        let revision = self.next_revision()?;
        match kind {
            ChangeKind::Undo => {
                self.history.undo_blocking();
            }
            ChangeKind::Redo => {
                self.history.redo_blocking();
            }
            ChangeKind::Edit | ChangeKind::External => unreachable!(),
        }
        let source = self.source();
        let changed = old != source;
        if changed {
            self.revision = revision;
        }
        Ok(Change {
            revision: self.revision,
            changed,
            kind,
            edits: difference(&old, &source),
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
}

fn new_doc(client_id: u64) -> Doc {
    let mut options = Options::with_client_id(yrs::block::ClientID::new(client_id));
    options.offset_kind = OffsetKind::Utf16;
    // Keep deleted content available to selective-history preflight replicas.
    options.skip_gc = true;
    Doc::with_options(options)
}

fn difference(old: &str, new: &str) -> Vec<TextEdit> {
    if old == new {
        return Vec::new();
    }
    let prefix = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum::<usize>();
    let suffix = old[prefix..]
        .chars()
        .rev()
        .zip(new[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum::<usize>();
    vec![TextEdit {
        range: Utf16Range {
            start: old[..prefix].encode_utf16().count() as u32,
            end: old[..old.len() - suffix].encode_utf16().count() as u32,
        },
        text: new[prefix..new.len() - suffix].to_owned(),
    }]
}

fn invalid(message: &str) -> Error {
    Error::InvalidRequest {
        message: message.to_owned(),
    }
}

fn history_options() -> yrs::undo::Options<()> {
    yrs::undo::Options {
        capture_timeout_millis: 0,
        // Transactions define history groups; neither native nor WASM needs a clock.
        timestamp: std::sync::Arc::new(|| 1_u64),
        tracked_origins: std::collections::HashSet::new(),
        capture_transaction: None,
        init_undo_stack: Vec::new(),
        init_redo_stack: Vec::new(),
    }
}

/// One speculative local operation; never commits into the live buffer.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BufferAction {
    Edit { edits: Vec<TextEdit> },
    Undo,
    Redo,
}

#[derive(serde::Serialize)]
pub struct BufferSizes {
    pub snapshot_bytes: usize,
    pub update_bytes: usize,
}
