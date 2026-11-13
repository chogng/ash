use crate::Error;
use crate::check_source_size;
use serde::Deserialize;
use serde::Serialize;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Utf16Range {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ByteRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SourceSpan {
    pub bytes: ByteRange,
    pub utf16: Utf16Range,
}

/// Maps scalar boundaries without treating Rust byte offsets as browser offsets.
/// Offsets inside a Unicode grapheme are valid edit boundaries, but cursor movement
/// uses the separate grapheme boundary list (e.g. a family emoji moves as one unit).
#[derive(Debug)]
pub struct SourceIndex {
    bytes: usize,
    units: u32,
    wide: Vec<WideChar>,
    graphemes: Vec<Utf16Range>,
}

#[derive(Debug)]
struct WideChar {
    byte: usize,
    units: u32,
    bytes: u8,
    width: u8,
}

impl SourceIndex {
    pub fn new(source: &str) -> Result<Self, Error> {
        check_source_size(source.len())?;
        // ASCII runs map arithmetically. Store only characters whose UTF-8 and
        // UTF-16 widths differ, rather than an allocation per source byte.
        let mut wide = Vec::new();
        let mut units = 0;
        for (byte, ch) in source.char_indices() {
            if !ch.is_ascii() {
                wide.push(WideChar {
                    byte,
                    units,
                    bytes: ch.len_utf8() as u8,
                    width: ch.len_utf16() as u8,
                });
            }
            units += ch.len_utf16() as u32;
        }
        let mut graphemes = Vec::new();
        let mut position = 0;
        for grapheme in source.graphemes(true) {
            let width = grapheme.encode_utf16().count() as u32;
            if width > 1 {
                graphemes.push(Utf16Range {
                    start: position,
                    end: position + width,
                });
            }
            position += width;
        }
        Ok(Self {
            bytes: source.len(),
            units,
            wide,
            graphemes,
        })
    }

    pub fn utf16_len(&self) -> u32 {
        self.units
    }

    pub fn byte_to_utf16(&self, offset: usize) -> Result<u32, Error> {
        if offset > self.bytes {
            return Err(Error::InvalidByteOffset { offset });
        }
        let before = self.wide.partition_point(|ch| ch.byte < offset);
        let Some(ch) = before.checked_sub(1).map(|index| &self.wide[index]) else {
            return Ok(offset as u32);
        };
        if offset < ch.byte + usize::from(ch.bytes) {
            return Err(Error::InvalidByteOffset { offset });
        }
        Ok(ch.units + (offset - ch.byte) as u32 - u32::from(ch.bytes - ch.width))
    }

    pub fn utf16_to_byte(&self, offset: u32) -> Result<usize, Error> {
        if offset > self.units {
            return Err(Error::InvalidUtf16Offset { offset });
        }
        let before = self.wide.partition_point(|ch| ch.units < offset);
        let Some(ch) = before.checked_sub(1).map(|index| &self.wide[index]) else {
            return Ok(offset as usize);
        };
        if offset < ch.units + u32::from(ch.width) {
            return Err(Error::InvalidUtf16Offset { offset });
        }
        Ok(ch.byte + (offset - ch.units) as usize + usize::from(ch.bytes - ch.width))
    }

    pub fn byte_range(&self, range: Utf16Range) -> Result<Range<usize>, Error> {
        if range.start > range.end {
            return Err(Error::ReversedRange {
                start: range.start,
                end: range.end,
            });
        }
        Ok(self.utf16_to_byte(range.start)?..self.utf16_to_byte(range.end)?)
    }

    pub fn source_span(&self, bytes: Range<usize>) -> Result<SourceSpan, Error> {
        Ok(SourceSpan {
            bytes: ByteRange {
                start: bytes.start,
                end: bytes.end,
            },
            utf16: Utf16Range {
                start: self.byte_to_utf16(bytes.start)?,
                end: self.byte_to_utf16(bytes.end)?,
            },
        })
    }

    pub fn previous_grapheme(&self, offset: u32) -> Result<u32, Error> {
        self.utf16_to_byte(offset)?;
        let before = self.graphemes.partition_point(|range| range.start < offset);
        if let Some(range) = before.checked_sub(1).map(|index| self.graphemes[index]) {
            if offset <= range.end {
                return Ok(range.start);
            }
        }
        Ok(offset.saturating_sub(1))
    }

    pub fn next_grapheme(&self, offset: u32) -> Result<u32, Error> {
        self.utf16_to_byte(offset)?;
        let after = self.graphemes.partition_point(|range| range.end <= offset);
        if let Some(range) = self.graphemes.get(after) {
            if offset >= range.start {
                return Ok(range.end);
            }
        }
        Ok((offset + 1).min(self.units))
    }
}
