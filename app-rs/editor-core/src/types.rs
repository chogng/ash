use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use serde::de::Error;
use serde::de::Visitor;
use std::fmt;
use std::num::ParseIntError;

/// A document-local revision that changes only after committed text mutations.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct EditorCoreRevision(u64);

impl EditorCoreRevision {
    /// The first revision assigned to a newly created document.
    pub const INITIAL: Self = Self(1);

    /// Returns the monotonic numeric revision for in-process Rust consumers.
    pub const fn value(self) -> u64 {
        self.0
    }

    /// Parses the decimal form used by JavaScript and transport adapters.
    pub fn parse_decimal(value: &str) -> Result<Self, ParseIntError> {
        value.parse().map(Self)
    }

    /// Returns the next revision after one committed document mutation.
    ///
    /// Presentation adapters use this only when their document owner has already committed the
    /// corresponding text transaction; selection-only changes do not advance a revision.
    pub const fn next_after_committed_edit(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

impl Serialize for EditorCoreRevision {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for EditorCoreRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(EditorCoreRevisionVisitor)
    }
}

struct EditorCoreRevisionVisitor;

impl Visitor<'_> for EditorCoreRevisionVisitor {
    type Value = EditorCoreRevision;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a decimal editor-core revision string")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: Error,
    {
        value.parse().map(EditorCoreRevision).map_err(E::custom)
    }
}

/// A UTF-16 code-unit offset used by JavaScript and browser selection APIs.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(transparent)]
pub struct EditorCoreUtf16Offset(u32);

impl EditorCoreUtf16Offset {
    pub const ZERO: Self = Self(0);

    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u32 {
        self.0
    }

    /// Converts this Browser-compatible offset to a UTF-8 byte offset in `text`.
    ///
    /// Offsets in the middle of a surrogate pair are rejected instead of being rounded.
    pub fn byte_offset_in(self, text: &str) -> Result<usize, crate::EditorCoreEditError> {
        let target = self.value();
        let mut utf16 = 0_u32;
        for (byte, character) in text.char_indices() {
            if utf16 == target {
                return Ok(byte);
            }
            utf16 = utf16.saturating_add(character.len_utf16() as u32);
            if utf16 > target {
                return Err(crate::EditorCoreEditError::InvalidUtf16Offset);
            }
        }
        if utf16 == target {
            Ok(text.len())
        } else {
            Err(crate::EditorCoreEditError::InvalidUtf16Offset)
        }
    }

    /// Converts a valid UTF-8 byte boundary into the corresponding UTF-16 offset.
    pub fn at_byte_offset(
        text: &str,
        byte_offset: usize,
    ) -> Result<Self, crate::EditorCoreEditError> {
        if byte_offset > text.len() || !text.is_char_boundary(byte_offset) {
            return Err(crate::EditorCoreEditError::InvalidUtf8Offset);
        }
        let utf16 = text[..byte_offset].encode_utf16().count();
        let utf16 =
            u32::try_from(utf16).map_err(|_| crate::EditorCoreEditError::Utf16OffsetOverflow)?;
        Ok(Self::new(utf16))
    }
}

/// An ordered, end-exclusive UTF-16 range in a document snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCoreTextRange {
    start: EditorCoreUtf16Offset,
    end: EditorCoreUtf16Offset,
}

impl EditorCoreTextRange {
    pub const fn new(start: EditorCoreUtf16Offset, end: EditorCoreUtf16Offset) -> Option<Self> {
        if start.value() <= end.value() {
            Some(Self { start, end })
        } else {
            None
        }
    }

    pub const fn start(self) -> EditorCoreUtf16Offset {
        self.start
    }

    pub const fn end(self) -> EditorCoreUtf16Offset {
        self.end
    }

    pub(crate) const fn is_ordered(self) -> bool {
        self.start.value() <= self.end.value()
    }
}

/// One directional selection endpoint pair expressed in UTF-16 code units.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCoreSelection {
    anchor: EditorCoreUtf16Offset,
    active: EditorCoreUtf16Offset,
}

impl EditorCoreSelection {
    pub const fn new(anchor: EditorCoreUtf16Offset, active: EditorCoreUtf16Offset) -> Self {
        Self { anchor, active }
    }

    pub const fn collapsed_at(offset: EditorCoreUtf16Offset) -> Self {
        Self::new(offset, offset)
    }

    pub const fn anchor(self) -> EditorCoreUtf16Offset {
        self.anchor
    }

    pub const fn active(self) -> EditorCoreUtf16Offset {
        self.active
    }
}

/// An ordered multi-selection set with one explicit primary selection.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCoreSelectionSet {
    selections: Vec<EditorCoreSelection>,
    primary_index: usize,
}

impl EditorCoreSelectionSet {
    pub fn new(selections: Vec<EditorCoreSelection>, primary_index: usize) -> Option<Self> {
        if selections.is_empty() || primary_index >= selections.len() {
            return None;
        }
        Some(Self {
            selections,
            primary_index,
        })
    }

    pub fn single(selection: EditorCoreSelection) -> Self {
        Self {
            selections: vec![selection],
            primary_index: 0,
        }
    }

    pub fn selections(&self) -> &[EditorCoreSelection] {
        &self.selections
    }

    pub const fn primary_index(&self) -> usize {
        self.primary_index
    }

    pub(crate) fn has_valid_primary_index(&self) -> bool {
        !self.selections.is_empty() && self.primary_index < self.selections.len()
    }
}

/// A complete document snapshot returned at an explicit synchronization boundary.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCoreDocumentSnapshot {
    revision: EditorCoreRevision,
    text: String,
    selections: EditorCoreSelectionSet,
}

impl EditorCoreDocumentSnapshot {
    pub(crate) fn new(
        revision: EditorCoreRevision,
        text: String,
        selections: EditorCoreSelectionSet,
    ) -> Self {
        Self {
            revision,
            text,
            selections,
        }
    }

    pub const fn revision(&self) -> EditorCoreRevision {
        self.revision
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn selections(&self) -> &EditorCoreSelectionSet {
        &self.selections
    }
}

#[cfg(test)]
#[path = "types_tests.rs"]
mod tests;
