//! Arkdown owns document source and editing semantics. Hosts own views and IO.
//!
//! Public edit coordinates use UTF-16 code units. Parser source ranges additionally
//! expose UTF-8 byte offsets. A Markdown source range is not a rendered DOM range:
//! escaping, entities and hidden syntax still require host-side selection mapping.

mod document;
mod error;
mod markdown;
mod source;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;

pub use document::Change;
pub use document::ChangeKind;
pub use document::Document;
pub use document::Snapshot;
pub use document::TextEdit;
pub use document::Transaction;
pub use error::Error;
pub use markdown::ColumnAlignment;
pub use markdown::Node;
pub use markdown::NodeKind;
pub use markdown::parse;
pub use markdown::render_html;
pub use source::ByteRange;
pub use source::SourceIndex;
pub use source::SourceSpan;
pub use source::Utf16Range;

#[cfg(test)]
mod tests;

/// A bound on both native and browser input, checked before parsing or mutation.
pub const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn check_source_size(bytes: usize) -> Result<(), Error> {
    if bytes > MAX_SOURCE_BYTES {
        Err(Error::SourceTooLarge {
            bytes,
            limit: MAX_SOURCE_BYTES,
        })
    } else {
        Ok(())
    }
}
