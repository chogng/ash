//! Native Markdown parsing, layout, and presentation for Ash product hosts.
//!
//! This crate owns a bounded CommonMark document projection and its presentation with `zui` and
//! `ash-ui-components`
//! primitives. It owns safe link evaluation, decoded-image projection, code highlighting,
//! document search/selection geometry, footnote/math projection, and an accessibility tree. It
//! does not own message identity, scrolling input, platform URL/clipboard side effects, network
//! fetching, persistence, or product lifecycle.

mod accessibility;
mod component;
mod component_interaction;
mod component_paint;
mod document;
mod document_text;
mod highlight;
mod image;
mod inline_layout;
mod interaction;
mod link;
mod math;
mod presentation;
mod style;
mod table;
mod table_layout;

pub use accessibility::{MarkdownSemanticNode, MarkdownSemanticRole};
pub use component::{Markdown, MarkdownLayoutEngine, MarkdownLink};
pub use document::{MarkdownDocument, MarkdownError};
pub use highlight::{MarkdownSyntaxHighlighter, MarkdownSyntaxSpan, SyntectMarkdownHighlighter};
pub use image::{
    MarkdownImageDecodeError, MarkdownImageSource, MarkdownImages, decode_markdown_image,
};
pub use interaction::{
    MarkdownSearchCase, MarkdownSearchMatch, MarkdownSelection, MarkdownSelectionController,
    MarkdownTextPosition,
};
pub use link::{MarkdownLinkError, MarkdownLinkPolicy, MarkdownLinkScheme, MarkdownLinkTarget};
pub use math::{MarkdownMathError, MarkdownMathMode, render_markdown_math};
pub use presentation::MarkdownPresentation;
pub use style::MarkdownStyle;

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
