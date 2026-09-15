use std::path::Path;
use std::path::PathBuf;

use crate::FileEditorHost;
use ash_app_server_protocol::protocol::language::LanguageCodeActionDiagnosticDto;
use ash_app_server_protocol::protocol::language::LanguageCommandDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionInsertTextFormatDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionItemDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionItemKindDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionsResult;
use ash_app_server_protocol::protocol::language::LanguageDiagnosticSeverityDto;
use ash_app_server_protocol::protocol::language::LanguageDiagnosticsNotification;
use ash_app_server_protocol::protocol::language::LanguageDocumentDto;
use ash_app_server_protocol::protocol::language::LanguageHoverResult;
use ash_app_server_protocol::protocol::language::LanguageLocationKindDto;
use ash_app_server_protocol::protocol::language::LanguageLocationsResult;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;
use ash_app_server_protocol::protocol::language::LanguageRangeDto;
use ash_app_server_protocol::protocol::language::LanguageServerMessageNotification;
use ash_app_server_protocol::protocol::language::LanguageTextEditDto;
use ash_lsp_manager::LanguageCommand;
use ash_lsp_manager::LanguageCompletionInsertTextFormat;
use ash_lsp_manager::LanguageCompletionItem;
use ash_lsp_manager::LanguageCompletionItemKind;
use ash_lsp_manager::LanguageCompletions;
use ash_lsp_manager::LanguageDiagnostic;
use ash_lsp_manager::LanguageDiagnosticSeverity;
use ash_lsp_manager::LanguageDocumentPosition;
use ash_lsp_manager::LanguageDocumentRevision;
use ash_lsp_manager::LanguageHover;
use ash_lsp_manager::LanguageLocationKind;
use ash_lsp_manager::LanguageLocationPosition;
use ash_lsp_manager::LanguageLocationRange;
use ash_lsp_manager::LanguageLocationTarget;
use ash_lsp_manager::LanguageLocations;
use ash_lsp_manager::LanguagePositionEncoding;
use ash_lsp_manager::LanguageRequestId;
use ash_lsp_manager::LanguageRequestKind;
use ash_lsp_manager::LanguageServiceDocument;
use ash_lsp_manager::LanguageTextEdit;
use ash_lsp_manager::LanguageTextRange;
use serde_json::Value;

use super::FileEditorDocumentDiagnostics;
use super::FileEditorLanguageService;
use super::editor_diagnostic;

/// Result or notification delivered by the Remote App Server language authority.
#[derive(Debug)]
pub enum RemoteLanguageEvent {
    ConnectionReady,
    ConnectionLost,
    ConnectionError(String),
    Diagnostics(LanguageDiagnosticsNotification),
    ServerMessage(LanguageServerMessageNotification),
    Hover {
        request_id: u64,
        path: PathBuf,
        result: LanguageHoverResult,
    },
    Completions {
        request_id: u64,
        path: PathBuf,
        result: LanguageCompletionsResult,
    },
    Locations {
        request_id: u64,
        path: PathBuf,
        kind: LanguageLocationKindDto,
        result: LanguageLocationsResult,
    },
    RequestFailed {
        request_id: u64,
        kind: LanguageRequestKind,
        path: PathBuf,
        message: String,
    },
    DocumentOperationFailed {
        path: PathBuf,
        operation: &'static str,
        message: String,
    },
}

pub(crate) fn protocol_document(document: LanguageServiceDocument) -> LanguageDocumentDto {
    LanguageDocumentDto {
        dir_id: None,
        session_directory: None,
        path: document.path().to_path_buf(),
        language_id: document.language_id().to_owned(),
        revision: document.revision().value(),
        text: document.text().to_owned(),
    }
}

pub(crate) fn protocol_position(
    text: &str,
    position: LanguageDocumentPosition,
) -> Option<LanguagePositionDto> {
    let row = usize::try_from(position.row).ok()?;
    let byte_offset = usize::try_from(position.byte_offset).ok()?;
    let (_, line) = line_at(text, row)?;
    if byte_offset > line.len() || !line.is_char_boundary(byte_offset) {
        return None;
    }
    Some(LanguagePositionDto {
        line_index: position.row,
        column_index: u32::try_from(line[..byte_offset].encode_utf16().count()).ok()?,
    })
}

pub(crate) fn project_hover(
    request_id: u64,
    path: PathBuf,
    text: &str,
    result: LanguageHoverResult,
) -> Option<LanguageHover> {
    Some(LanguageHover {
        request_id: LanguageRequestId::new(request_id),
        path,
        revision: LanguageDocumentRevision::new(result.revision),
        contents: result.contents?,
        range: match result.range {
            Some(range) => Some(byte_range(text, range)?),
            None => None,
        },
    })
}

pub(crate) fn project_completions(
    request_id: u64,
    path: PathBuf,
    text: &str,
    result: LanguageCompletionsResult,
) -> Option<LanguageCompletions> {
    let items = result
        .items
        .into_iter()
        .map(|item| completion_item(text, item))
        .collect::<Option<Vec<_>>>()?;
    Some(LanguageCompletions {
        request_id: LanguageRequestId::new(request_id),
        path,
        revision: LanguageDocumentRevision::new(result.revision),
        is_incomplete: result.is_incomplete,
        can_resolve: result.can_resolve,
        items,
    })
}

pub(crate) fn project_locations(
    request_id: u64,
    source_path: PathBuf,
    kind: LanguageLocationKindDto,
    result: LanguageLocationsResult,
) -> LanguageLocations {
    LanguageLocations {
        request_id: LanguageRequestId::new(request_id),
        kind: location_kind(kind),
        source_path,
        source_revision: LanguageDocumentRevision::new(result.revision),
        targets: result
            .locations
            .into_iter()
            .map(|location| LanguageLocationTarget {
                path: location.path,
                range: location_range(location.range),
                selection_range: location_range(location.selection_range),
                encoding: LanguagePositionEncoding::Utf16,
            })
            .collect(),
    }
}

pub(crate) fn project_diagnostics(
    text: &str,
    diagnostics: Vec<LanguageCodeActionDiagnosticDto>,
) -> Vec<LanguageDiagnostic> {
    diagnostics
        .into_iter()
        .filter_map(|diagnostic| {
            Some(LanguageDiagnostic {
                range: byte_range(text, diagnostic.range)?,
                severity: diagnostic_severity(diagnostic.severity),
                message: diagnostic.message,
                source: diagnostic.source,
                code: diagnostic.code.map(diagnostic_code),
            })
        })
        .collect()
}

fn completion_item(text: &str, item: LanguageCompletionItemDto) -> Option<LanguageCompletionItem> {
    let edit = LanguageTextEdit {
        range: byte_range(text, item.range)?,
        new_text: item.insert_text,
    };
    let additional_text_edits = item
        .additional_text_edits
        .into_iter()
        .map(|edit| text_edit(text, edit))
        .collect::<Option<Vec<_>>>()?;
    Some(LanguageCompletionItem {
        label: item.label,
        kind: completion_kind(item.kind),
        detail: item.detail,
        documentation: item.documentation,
        filter_text: item.filter_text,
        sort_text: item.sort_text,
        preselect: item.preselect,
        commit_characters: item.commit_characters,
        insert_text_format: completion_insert_text_format(item.insert_text_format),
        edit: Some(edit),
        additional_text_edits,
        command: item.command.map(language_command),
        provider_data: item.provider_data.unwrap_or(Value::Null),
    })
}

fn text_edit(text: &str, edit: LanguageTextEditDto) -> Option<LanguageTextEdit> {
    Some(LanguageTextEdit {
        range: byte_range(text, edit.range)?,
        new_text: edit.new_text,
    })
}

fn byte_range(text: &str, range: LanguageRangeDto) -> Option<LanguageTextRange> {
    let start = byte_offset(text, range.start)?;
    let end = byte_offset(text, range.end)?;
    (start <= end).then(|| LanguageTextRange::new(start..end))
}

fn byte_offset(text: &str, position: LanguagePositionDto) -> Option<usize> {
    let row = usize::try_from(position.line_index).ok()?;
    let requested = usize::try_from(position.column_index).ok()?;
    let (line_start, line) = line_at(text, row)?;
    let mut utf16 = 0;
    for (offset, scalar) in line.char_indices() {
        if utf16 == requested {
            return Some(line_start + offset);
        }
        utf16 += scalar.len_utf16();
        if utf16 > requested {
            return None;
        }
    }
    (utf16 == requested).then_some(line_start + line.len())
}

fn line_at(text: &str, requested_row: usize) -> Option<(usize, &str)> {
    let mut start = 0;
    for _ in 0..requested_row {
        let newline = text[start..].find('\n')?;
        start += newline + 1;
    }
    let mut end = text[start..]
        .find('\n')
        .map_or(text.len(), |offset| start + offset);
    if end > start && text.as_bytes()[end - 1] == b'\r' {
        end -= 1;
    }
    Some((start, &text[start..end]))
}

fn location_range(range: LanguageRangeDto) -> LanguageLocationRange {
    LanguageLocationRange {
        start: location_position(range.start),
        end: location_position(range.end),
    }
}

fn location_position(position: LanguagePositionDto) -> LanguageLocationPosition {
    LanguageLocationPosition {
        row: position.line_index,
        character: position.column_index,
    }
}

fn completion_kind(kind: LanguageCompletionItemKindDto) -> LanguageCompletionItemKind {
    match kind {
        LanguageCompletionItemKindDto::Text => LanguageCompletionItemKind::Text,
        LanguageCompletionItemKindDto::Method => LanguageCompletionItemKind::Method,
        LanguageCompletionItemKindDto::Function => LanguageCompletionItemKind::Function,
        LanguageCompletionItemKindDto::Constructor => LanguageCompletionItemKind::Constructor,
        LanguageCompletionItemKindDto::Field => LanguageCompletionItemKind::Field,
        LanguageCompletionItemKindDto::Variable => LanguageCompletionItemKind::Variable,
        LanguageCompletionItemKindDto::Class => LanguageCompletionItemKind::Class,
        LanguageCompletionItemKindDto::Interface => LanguageCompletionItemKind::Interface,
        LanguageCompletionItemKindDto::Module => LanguageCompletionItemKind::Module,
        LanguageCompletionItemKindDto::Property => LanguageCompletionItemKind::Property,
        LanguageCompletionItemKindDto::Unit => LanguageCompletionItemKind::Unit,
        LanguageCompletionItemKindDto::Value => LanguageCompletionItemKind::Value,
        LanguageCompletionItemKindDto::Enum => LanguageCompletionItemKind::Enum,
        LanguageCompletionItemKindDto::Keyword => LanguageCompletionItemKind::Keyword,
        LanguageCompletionItemKindDto::Snippet => LanguageCompletionItemKind::Snippet,
        LanguageCompletionItemKindDto::File => LanguageCompletionItemKind::File,
        LanguageCompletionItemKindDto::Folder => LanguageCompletionItemKind::Folder,
        LanguageCompletionItemKindDto::Reference => LanguageCompletionItemKind::Reference,
        LanguageCompletionItemKindDto::TypeParameter => LanguageCompletionItemKind::TypeParameter,
    }
}

fn completion_insert_text_format(
    format: LanguageCompletionInsertTextFormatDto,
) -> LanguageCompletionInsertTextFormat {
    match format {
        LanguageCompletionInsertTextFormatDto::PlainText => {
            LanguageCompletionInsertTextFormat::PlainText
        }
        LanguageCompletionInsertTextFormatDto::Snippet => {
            LanguageCompletionInsertTextFormat::Snippet
        }
    }
}

fn language_command(command: LanguageCommandDto) -> LanguageCommand {
    LanguageCommand {
        id: command.id,
        title: command.title,
        arguments: command.arguments,
    }
}

fn location_kind(kind: LanguageLocationKindDto) -> LanguageLocationKind {
    match kind {
        LanguageLocationKindDto::Declaration => LanguageLocationKind::Declaration,
        LanguageLocationKindDto::Definition => LanguageLocationKind::Definition,
        LanguageLocationKindDto::Implementation => LanguageLocationKind::Implementation,
        LanguageLocationKindDto::TypeDefinition => LanguageLocationKind::TypeDefinition,
        LanguageLocationKindDto::References => LanguageLocationKind::Reference,
    }
}

fn diagnostic_severity(severity: LanguageDiagnosticSeverityDto) -> LanguageDiagnosticSeverity {
    match severity {
        LanguageDiagnosticSeverityDto::Error => LanguageDiagnosticSeverity::Error,
        LanguageDiagnosticSeverityDto::Warning => LanguageDiagnosticSeverity::Warning,
        LanguageDiagnosticSeverityDto::Information => LanguageDiagnosticSeverity::Information,
        LanguageDiagnosticSeverityDto::Hint => LanguageDiagnosticSeverity::Hint,
    }
}

fn diagnostic_code(code: Value) -> String {
    match code {
        Value::String(code) => code,
        code => code.to_string(),
    }
}

impl FileEditorLanguageService {
    pub(super) fn handle_remote_event(
        &mut self,
        event: RemoteLanguageEvent,
        host: &FileEditorHost,
    ) {
        match event {
            RemoteLanguageEvent::ConnectionReady => self.synchronize_all(host),
            RemoteLanguageEvent::ConnectionLost => self.clear_requests(),
            RemoteLanguageEvent::ConnectionError(error) => {
                eprintln!("Remote language service: {error}");
            }
            RemoteLanguageEvent::Diagnostics(diagnostics) => {
                let path = self.absolute_path(&diagnostics.path);
                let Some(tab) = host.tabs().iter().find(|tab| {
                    self.absolute_path(tab.path()) == path
                        && tab.document().revision().value() == diagnostics.revision
                }) else {
                    return;
                };
                let items = project_diagnostics(tab.document().text(), diagnostics.diagnostics)
                    .iter()
                    .map(editor_diagnostic)
                    .collect();
                self.diagnostics.insert(
                    path,
                    FileEditorDocumentDiagnostics {
                        revision: diagnostics.revision,
                        items,
                    },
                );
            }
            RemoteLanguageEvent::ServerMessage(message) => {
                eprintln!(
                    "Remote language server {}: {}",
                    message.server, message.message
                );
            }
            RemoteLanguageEvent::Hover {
                request_id,
                path,
                result,
            } => {
                if !self
                    .pending_requests
                    .complete_value(LanguageRequestKind::Hover, request_id)
                {
                    return;
                }
                let text = active_document_text(self, host, &path, result.revision);
                self.hover = text.and_then(|text| project_hover(request_id, path, text, result));
                self.request_error = None;
            }
            RemoteLanguageEvent::Completions {
                request_id,
                path,
                result,
            } => {
                if !self
                    .pending_requests
                    .complete_value(LanguageRequestKind::Completion, request_id)
                {
                    return;
                }
                let text = active_document_text(self, host, &path, result.revision);
                self.completions =
                    text.and_then(|text| project_completions(request_id, path, text, result));
                self.request_error = None;
            }
            RemoteLanguageEvent::Locations {
                request_id,
                path,
                kind,
                result,
            } => {
                let request_kind = request_kind_for_protocol_location(kind);
                if !self
                    .pending_requests
                    .complete_value(request_kind, request_id)
                {
                    return;
                }
                if active_document_text(self, host, &path, result.revision).is_none() {
                    return;
                }
                self.definitions = Some(project_locations(request_id, path, kind, result));
                self.request_error = None;
            }
            RemoteLanguageEvent::RequestFailed {
                request_id,
                kind,
                path,
                message,
            } => {
                if !self.pending_requests.complete_value(kind, request_id) {
                    return;
                }
                if kind == LanguageRequestKind::Hover {
                    self.hover = None;
                } else {
                    eprintln!(
                        "Remote language request {kind:?} for {} failed: {message}",
                        path.display()
                    );
                    self.request_error = Some(message);
                }
            }
            RemoteLanguageEvent::DocumentOperationFailed {
                path,
                operation,
                message,
            } => {
                eprintln!(
                    "Remote language document {} {operation} failed: {message}",
                    path.display()
                );
            }
        }
    }
}

pub(super) fn protocol_location_kind(kind: LanguageRequestKind) -> LanguageLocationKindDto {
    match kind {
        LanguageRequestKind::Declaration => LanguageLocationKindDto::Declaration,
        LanguageRequestKind::Definition => LanguageLocationKindDto::Definition,
        LanguageRequestKind::Implementation => LanguageLocationKindDto::Implementation,
        LanguageRequestKind::TypeDefinition => LanguageLocationKindDto::TypeDefinition,
        LanguageRequestKind::References => LanguageLocationKindDto::References,
        _ => unreachable!("non-location language request"),
    }
}

fn request_kind_for_protocol_location(kind: LanguageLocationKindDto) -> LanguageRequestKind {
    match kind {
        LanguageLocationKindDto::Declaration => LanguageRequestKind::Declaration,
        LanguageLocationKindDto::Definition => LanguageRequestKind::Definition,
        LanguageLocationKindDto::Implementation => LanguageRequestKind::Implementation,
        LanguageLocationKindDto::TypeDefinition => LanguageRequestKind::TypeDefinition,
        LanguageLocationKindDto::References => LanguageRequestKind::References,
    }
}

fn active_document_text<'a>(
    service: &FileEditorLanguageService,
    host: &'a FileEditorHost,
    path: &Path,
    revision: u64,
) -> Option<&'a str> {
    let tab = host.active()?;
    (service.absolute_path(tab.path()) == service.absolute_path(path)
        && tab.document().revision().value() == revision)
        .then(|| tab.document().text())
}

#[cfg(test)]
#[path = "language_service_remote_tests.rs"]
mod tests;
