use std::path::PathBuf;

use ash_lsp::lsp_types::CodeLens;
use ash_lsp::lsp_types::Color;
use ash_lsp::lsp_types::ColorInformation;
use ash_lsp::lsp_types::ColorPresentation;
use ash_lsp::lsp_types::Command;
use ash_lsp::lsp_types::DocumentLink;
use ash_lsp::lsp_types::DocumentSymbol;
use ash_lsp::lsp_types::DocumentSymbolResponse;
use ash_lsp::lsp_types::FoldingRange;
use ash_lsp::lsp_types::FoldingRangeKind;
use ash_lsp::lsp_types::PositionEncodingKind;
use ash_lsp::lsp_types::Range;
use ash_lsp::lsp_types::SymbolInformation;
use ash_lsp::lsp_types::TextEdit;
use ash_lsp::lsp_types::Uri;
use serde_json::Value;

use crate::LanguageDocumentPosition;
use crate::LanguageDocumentRevision;
use crate::LanguageRequestId;
use crate::LanguageTextEdit;
use crate::LanguageTextRange;
use crate::projection::byte_range_for_lsp_range;
use crate::requests::protocol_position;

const MAX_DOCUMENT_FEATURE_ITEMS: usize = 10_000;
const MAX_DOCUMENT_SYMBOL_DEPTH: usize = 64;
const MAX_FOLDING_RANGES: usize = 5_000;

/// One hierarchy-preserving symbol projected into the authoritative document snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub symbol_kind: u32,
    pub range: LanguageTextRange,
    pub selection_range: LanguageTextRange,
    pub children: Vec<LanguageDocumentSymbol>,
}

/// Fresh document symbols for one exact editor revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDocumentSymbols {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub symbols: Vec<LanguageDocumentSymbol>,
}

/// Presentation-neutral command attached to a language-server item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCommand {
    pub id: String,
    pub title: String,
    pub arguments: Vec<Value>,
}

/// One resolved or unresolved code lens, including opaque provider data for resolve.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCodeLens {
    pub range: LanguageTextRange,
    pub command: Option<LanguageCommand>,
    pub provider_data: Option<Value>,
}

/// Fresh code lenses for one exact editor revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCodeLenses {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub lenses: Vec<LanguageCodeLens>,
}

/// One resolved or unresolved document link, including opaque provider data for resolve.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDocumentLink {
    pub range: LanguageTextRange,
    pub target: Option<String>,
    pub tooltip: Option<String>,
    pub provider_data: Option<Value>,
}

/// Fresh document links for one exact editor revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDocumentLinks {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub links: Vec<LanguageDocumentLink>,
}

/// RGBA color with byte components suitable for editor presentation contracts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanguageColor {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}

/// One source range with its parsed color value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDocumentColor {
    pub range: LanguageTextRange,
    pub color: LanguageColor,
}

/// Fresh document colors for one exact editor revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDocumentColors {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub colors: Vec<LanguageDocumentColor>,
}

/// One server-selected textual representation for a color.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageColorPresentation {
    pub label: String,
    pub text_edit: Option<LanguageTextEdit>,
    pub additional_text_edits: Vec<LanguageTextEdit>,
}

/// Fresh color presentations for one exact editor revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageColorPresentations {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub presentations: Vec<LanguageColorPresentation>,
}

/// Stable folding category understood without exposing protocol objects.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageFoldingRangeKind {
    Comment,
    Imports,
    Region,
}

/// One complete-line folding range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageFoldingRange {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: Option<LanguageFoldingRangeKind>,
    pub collapsed_text: Option<String>,
}

/// Fresh folding ranges for one exact editor revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageFoldingRanges {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub ranges: Vec<LanguageFoldingRange>,
}

pub(crate) fn project_document_symbols(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    source_uri: &Uri,
    encoding: &PositionEncodingKind,
    response: Option<DocumentSymbolResponse>,
) -> LanguageDocumentSymbols {
    let mut remaining = MAX_DOCUMENT_FEATURE_ITEMS;
    let symbols = match response {
        Some(DocumentSymbolResponse::Nested(symbols)) => symbols
            .into_iter()
            .filter_map(|symbol| project_nested_symbol(symbol, text, encoding, 0, &mut remaining))
            .collect(),
        Some(DocumentSymbolResponse::Flat(symbols)) => symbols
            .into_iter()
            .filter(|symbol| &symbol.location.uri == source_uri)
            .filter_map(|symbol| project_flat_symbol(symbol, text, encoding, &mut remaining))
            .collect(),
        None => Vec::new(),
    };
    LanguageDocumentSymbols {
        request_id,
        path,
        revision,
        symbols,
    }
}

pub(crate) fn project_code_lenses(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    lenses: Vec<CodeLens>,
) -> LanguageCodeLenses {
    LanguageCodeLenses {
        request_id,
        path,
        revision,
        lenses: lenses
            .into_iter()
            .take(MAX_DOCUMENT_FEATURE_ITEMS)
            .filter_map(|lens| project_code_lens(lens, text, encoding))
            .collect(),
    }
}

pub(crate) fn project_document_links(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    links: Vec<DocumentLink>,
) -> LanguageDocumentLinks {
    LanguageDocumentLinks {
        request_id,
        path,
        revision,
        links: links
            .into_iter()
            .take(MAX_DOCUMENT_FEATURE_ITEMS)
            .filter_map(|link| project_document_link(link, text, encoding))
            .collect(),
    }
}

pub(crate) fn project_document_colors(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    colors: Vec<ColorInformation>,
) -> LanguageDocumentColors {
    LanguageDocumentColors {
        request_id,
        path,
        revision,
        colors: colors
            .into_iter()
            .take(MAX_DOCUMENT_FEATURE_ITEMS)
            .filter_map(|color| {
                Some(LanguageDocumentColor {
                    range: project_range(text, color.range, encoding)?,
                    color: project_color(color.color)?,
                })
            })
            .collect(),
    }
}

pub(crate) fn project_color_presentations(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    presentations: Vec<ColorPresentation>,
) -> LanguageColorPresentations {
    LanguageColorPresentations {
        request_id,
        path,
        revision,
        presentations: presentations
            .into_iter()
            .take(MAX_DOCUMENT_FEATURE_ITEMS)
            .filter_map(|presentation| project_color_presentation(presentation, text, encoding))
            .collect(),
    }
}

pub(crate) fn project_folding_ranges(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    ranges: Vec<FoldingRange>,
) -> LanguageFoldingRanges {
    let line_count = text.split('\n').count();
    LanguageFoldingRanges {
        request_id,
        path,
        revision,
        ranges: ranges
            .into_iter()
            .take(MAX_FOLDING_RANGES)
            .filter_map(|range| {
                let start = usize::try_from(range.start_line).ok()?;
                let end = usize::try_from(range.end_line).ok()?;
                (start < end && end < line_count).then_some(LanguageFoldingRange {
                    start_line: range.start_line,
                    end_line: range.end_line,
                    kind: range.kind.map(project_folding_kind),
                    collapsed_text: range.collapsed_text.filter(|text| !text.contains('\0')),
                })
            })
            .collect(),
    }
}

pub(crate) fn protocol_code_lens(
    lens: LanguageCodeLens,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<CodeLens> {
    Some(CodeLens {
        range: protocol_range(text, lens.range, encoding)?,
        command: lens.command.map(protocol_command),
        data: lens.provider_data,
    })
}

pub(crate) fn protocol_document_link(
    link: LanguageDocumentLink,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<DocumentLink> {
    Some(DocumentLink {
        range: protocol_range(text, link.range, encoding)?,
        target: link.target.and_then(|target| target.parse().ok()),
        tooltip: link.tooltip,
        data: link.provider_data,
    })
}

pub(crate) fn protocol_color(color: LanguageColor) -> Color {
    Color {
        red: f32::from(color.red) / 255.0,
        green: f32::from(color.green) / 255.0,
        blue: f32::from(color.blue) / 255.0,
        alpha: f32::from(color.alpha) / 255.0,
    }
}

pub(crate) fn protocol_range(
    text: &str,
    range: LanguageTextRange,
    encoding: &PositionEncodingKind,
) -> Option<Range> {
    let byte_range = range.byte_range();
    let start = document_position_for_offset(text, byte_range.start)?;
    let end = document_position_for_offset(text, byte_range.end)?;
    Some(Range::new(
        protocol_position(text, start, encoding)?,
        protocol_position(text, end, encoding)?,
    ))
}

fn project_nested_symbol(
    symbol: DocumentSymbol,
    text: &str,
    encoding: &PositionEncodingKind,
    depth: usize,
    remaining: &mut usize,
) -> Option<LanguageDocumentSymbol> {
    if *remaining == 0 || depth > MAX_DOCUMENT_SYMBOL_DEPTH {
        return None;
    }
    *remaining -= 1;
    let range = project_range(text, symbol.range, encoding)?;
    let selection_range = project_range(text, symbol.selection_range, encoding)?;
    let children = symbol
        .children
        .unwrap_or_default()
        .into_iter()
        .filter_map(|child| project_nested_symbol(child, text, encoding, depth + 1, remaining))
        .collect();
    Some(LanguageDocumentSymbol {
        name: symbol.name,
        detail: symbol.detail,
        symbol_kind: symbol_kind(symbol.kind)?,
        range,
        selection_range,
        children,
    })
}

fn project_flat_symbol(
    symbol: SymbolInformation,
    text: &str,
    encoding: &PositionEncodingKind,
    remaining: &mut usize,
) -> Option<LanguageDocumentSymbol> {
    if *remaining == 0 {
        return None;
    }
    *remaining -= 1;
    let range = project_range(text, symbol.location.range, encoding)?;
    Some(LanguageDocumentSymbol {
        name: symbol.name,
        detail: symbol.container_name,
        symbol_kind: symbol_kind(symbol.kind)?,
        range: range.clone(),
        selection_range: range,
        children: Vec::new(),
    })
}

fn project_code_lens(
    lens: CodeLens,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageCodeLens> {
    Some(LanguageCodeLens {
        range: project_range(text, lens.range, encoding)?,
        command: lens.command.map(project_command),
        provider_data: lens.data,
    })
}

fn project_document_link(
    link: DocumentLink,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageDocumentLink> {
    Some(LanguageDocumentLink {
        range: project_range(text, link.range, encoding)?,
        target: link.target.map(|target| target.to_string()),
        tooltip: link.tooltip,
        provider_data: link.data,
    })
}

fn project_command(command: Command) -> LanguageCommand {
    LanguageCommand {
        id: command.command,
        title: command.title,
        arguments: command.arguments.unwrap_or_default(),
    }
}

fn protocol_command(command: LanguageCommand) -> Command {
    Command {
        title: command.title,
        command: command.id,
        arguments: (!command.arguments.is_empty()).then_some(command.arguments),
    }
}

fn project_color(color: Color) -> Option<LanguageColor> {
    Some(LanguageColor {
        red: color_component(color.red)?,
        green: color_component(color.green)?,
        blue: color_component(color.blue)?,
        alpha: color_component(color.alpha)?,
    })
}

fn color_component(value: f32) -> Option<u8> {
    (value.is_finite() && (0.0..=1.0).contains(&value)).then_some((value * 255.0).round() as u8)
}

fn project_color_presentation(
    presentation: ColorPresentation,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageColorPresentation> {
    (!presentation.label.contains('\0')).then_some(LanguageColorPresentation {
        label: presentation.label,
        text_edit: presentation
            .text_edit
            .and_then(|edit| project_text_edit(edit, text, encoding)),
        additional_text_edits: presentation
            .additional_text_edits
            .unwrap_or_default()
            .into_iter()
            .filter_map(|edit| project_text_edit(edit, text, encoding))
            .collect(),
    })
}

fn project_text_edit(
    edit: TextEdit,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageTextEdit> {
    Some(LanguageTextEdit {
        range: project_range(text, edit.range, encoding)?,
        new_text: edit.new_text,
    })
}

fn project_range(
    text: &str,
    range: Range,
    encoding: &PositionEncodingKind,
) -> Option<LanguageTextRange> {
    byte_range_for_lsp_range(text, range.start, range.end, encoding).map(LanguageTextRange::new)
}

fn document_position_for_offset(text: &str, offset: usize) -> Option<LanguageDocumentPosition> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return None;
    }
    let before = &text[..offset];
    let row = before.bytes().filter(|byte| *byte == b'\n').count();
    let line_start = before.rfind('\n').map_or(0, |index| index + 1);
    Some(LanguageDocumentPosition::new(
        u32::try_from(row).ok()?,
        u32::try_from(offset - line_start).ok()?,
    ))
}

fn symbol_kind(kind: ash_lsp::lsp_types::SymbolKind) -> Option<u32> {
    serde_json::to_value(kind)
        .ok()?
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
}

fn project_folding_kind(kind: FoldingRangeKind) -> LanguageFoldingRangeKind {
    match kind {
        FoldingRangeKind::Comment => LanguageFoldingRangeKind::Comment,
        FoldingRangeKind::Imports => LanguageFoldingRangeKind::Imports,
        FoldingRangeKind::Region => LanguageFoldingRangeKind::Region,
    }
}

#[cfg(test)]
#[path = "document_features_tests.rs"]
mod tests;
