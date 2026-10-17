use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeParams;
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeResult;
use ash_app_server_protocol::protocol::syntax::SyntaxBracketDto;
use ash_app_server_protocol::protocol::syntax::SyntaxCancelParams;
use ash_app_server_protocol::protocol::syntax::SyntaxCaptureDto;
use ash_app_server_protocol::protocol::syntax::SyntaxCloseParams;
use ash_app_server_protocol::protocol::syntax::SyntaxDiagnosticDto;
use ash_app_server_protocol::protocol::syntax::SyntaxDiagnosticKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxDiagnosticsSpliceDto;
use ash_app_server_protocol::protocol::syntax::SyntaxFactsDeltaDto;
use ash_app_server_protocol::protocol::syntax::SyntaxFoldingRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxFoldsSpliceDto;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::syntax::SyntaxOpenParams;
use ash_app_server_protocol::protocol::syntax::SyntaxPositionDto;
use ash_app_server_protocol::protocol::syntax::SyntaxQueryKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxQueryParams;
use ash_app_server_protocol::protocol::syntax::SyntaxQueryResult;
use ash_app_server_protocol::protocol::syntax::SyntaxRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxRowDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSelectionRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSelectionRangesParams;
use ash_app_server_protocol::protocol::syntax::SyntaxSelectionRangesResult;
use ash_app_server_protocol::protocol::syntax::SyntaxSymbolDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSymbolKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSymbolsSpliceDto;
use ash_app_server_protocol::protocol::syntax::SyntaxTokenDto;
use ash_app_server_protocol::protocol::syntax::SyntaxTokenKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxUpdateParams;
use ash_async_utils::CancellationToken;
use ash_syntax::DocumentRevision;
use ash_syntax::DocumentSymbolKind;
use ash_syntax::SyntaxDiagnosticKind;
use ash_syntax::SyntaxDocument;
use ash_syntax::SyntaxEdit;
use ash_syntax::SyntaxError;
use ash_syntax::SyntaxLanguage;
use ash_syntax::SyntaxRange;
use ash_syntax::SyntaxSnapshot;
use ash_syntax::SyntaxTokenKind;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

struct SyntaxSession {
    document: SyntaxDocument,
    analysis: SessionAnalysis,
    parse_ms: Option<f64>,
    initial_revision: u64,
    facts: Option<Arc<SharedFacts>>,
    acknowledged_facts: Option<(Arc<SharedFacts>, Vec<[usize; 6]>)>,
    facts_edits: Vec<[usize; 6]>,
}

enum SessionAnalysis {
    Complete(SyntaxSnapshot),
    Shared(Option<(usize, Arc<ash_syntax::EditorFacts>)>),
}

impl SyntaxSession {
    fn open(language: SyntaxLanguage, revision: u64, text: &str) -> Result<Self, RpcError> {
        let document = SyntaxDocument::open(language, DocumentRevision::new(revision), text)
            .map_err(syntax_error)?;
        let snapshot = document.snapshot();
        Ok(Self {
            document,
            analysis: SessionAnalysis::Complete(snapshot),
            parse_ms: None,
            initial_revision: revision,
            facts: None,
            acknowledged_facts: None,
            facts_edits: Vec::new(),
        })
    }
}

/// Owns connection-scoped syntax documents; request cancellation shares the RPC registry.
pub(super) struct SyntaxRequestProcessor {
    syntax_documents: Mutex<std::collections::HashMap<(u64, String), Arc<Mutex<SyntaxSession>>>>,
    request_scheduler: super::request_serialization::RequestScheduler,
    request_cancellations: super::request_serialization::RequestCancellationRegistry,
}

impl SyntaxRequestProcessor {
    pub(super) fn new(
        request_scheduler: super::request_serialization::RequestScheduler,
        request_cancellations: super::request_serialization::RequestCancellationRegistry,
    ) -> Self {
        Self {
            syntax_documents: Mutex::new(Default::default()),
            request_scheduler,
            request_cancellations,
        }
    }
    pub(super) fn connection_closed(&self, connection_id: u64) {
        if let Ok(mut documents) = self.syntax_documents.lock() {
            documents.retain(|(owner, _), _| *owner != connection_id);
        }
    }

    pub(super) fn syntax_open(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxOpenParams = decode(params)?;
        validate_document_id(&params.document_id)?;
        let session = SyntaxSession::open(
            syntax_language(params.language),
            params.revision,
            &params.text,
        )?;
        self.syntax_documents
            .lock()
            .map_err(|_| internal_error())?
            .insert(
                (connection.connection_id, params.document_id),
                Arc::new(Mutex::new(session)),
            );
        result(&())
    }

    /// Dedicated request workers perform CPU work, outside the renderer and async reactor.
    pub(super) fn syntax_open_shared(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxOpenParams = decode(params)?;
        validate_document_id(&params.document_id)?;
        let started = Instant::now();
        let document = SyntaxDocument::open(
            syntax_language(params.language),
            DocumentRevision::new(params.revision),
            params.text,
        )
        .map_err(syntax_error)?;
        let session = SyntaxSession {
            document,
            analysis: SessionAnalysis::Shared(None),
            parse_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
            initial_revision: params.revision,
            facts: None,
            acknowledged_facts: None,
            facts_edits: Vec::new(),
        };
        self.syntax_documents
            .lock()
            .map_err(|_| internal_error())?
            .insert(
                (connection.connection_id, params.document_id),
                Arc::new(Mutex::new(session)),
            );
        result(&())
    }

    pub(super) fn syntax_query(
        &self,
        connection: &ConnectionState,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: SyntaxQueryParams = decode(params)?;
        if params.tab_size == 0
            || params.tab_size > 1000
            || params.operation_id.is_empty()
            || params.operation_id.len() > 128
        {
            return Err(invalid_params());
        }
        cancellation
            .check()
            .map_err(|_| syntax_error(SyntaxError::ParseCancelled))?;
        let session = self.syntax_document(connection, &params.document_id)?;
        let mut session = session.lock().map_err(|_| internal_error())?;
        validate_revision(&session, params.revision)?;
        if !matches!(session.analysis, SessionAnalysis::Shared(_)) {
            return Err(invalid_params());
        }
        let ranges = params
            .ranges
            .iter()
            .map(|range| {
                if range.start_line_index >= range.end_line_index
                    || range.end_line_index > session.document.line_count()
                {
                    Err(invalid_params())
                } else {
                    Ok(range.start_line_index..range.end_line_index)
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let started = Instant::now();
        let cancelled = || cancellation.is_cancelled();
        let mut response = SyntaxQueryResult {
            revision: params.revision,
            rows: Vec::new(),
            facts: None,
            brackets: Vec::new(),
            parse_ms: 0.0,
            query_ms: 0.0,
            incremental: params.revision != session.initial_revision,
        };
        match params.kind {
            SyntaxQueryKindDto::Highlight => {
                if ranges.iter().map(std::ops::Range::len).sum::<usize>() > 10_000 {
                    return Err(invalid_params());
                }
                for range in &ranges {
                    response.rows.extend(project_rows(
                        session
                            .document
                            .editor_highlight(range.clone(), &cancelled)
                            .map_err(syntax_error)?,
                    ));
                }
                let brackets = session
                    .document
                    .editor_brackets(&ranges, params.tab_size, &cancelled)
                    .map_err(syntax_error)?;
                let range = |value: &SyntaxRange| SyntaxRangeDto {
                    start: SyntaxPositionDto {
                        line_index: value.start.row,
                        column_index: session.document.utf16_column(value.start),
                    },
                    end: SyntaxPositionDto {
                        line_index: value.end.row,
                        column_index: session.document.utf16_column(value.end),
                    },
                };
                response.brackets = brackets
                    .into_iter()
                    .map(|bracket| SyntaxBracketDto {
                        range: range(&bracket.range),
                        opening: range(&bracket.opening),
                        closing: bracket.closing.as_ref().map(range),
                        text: bracket.text,
                        close_text: bracket.close_text,
                        level: bracket.level,
                        equal_level: bracket.equal_level,
                        min_indent: bracket.min_indent,
                    })
                    .collect();
            }
            SyntaxQueryKindDto::Facts => {
                let cached = matches!(&session.analysis, SessionAnalysis::Shared(Some((tab_size, _))) if *tab_size == params.tab_size);
                if !cached {
                    let facts = session
                        .document
                        .editor_facts(params.tab_size, &cancelled)
                        .map_err(syntax_error)?;
                    session.analysis = SessionAnalysis::Shared(Some((params.tab_size, facts)));
                }
                if let SessionAnalysis::Shared(Some((_, facts))) = &session.analysis {
                    let current = Arc::new(SharedFacts {
                        revision: facts.revision().value(),
                        tab_size: params.tab_size,
                        value: Arc::clone(facts),
                    });
                    let matches = |facts: &SharedFacts| {
                        Some(facts.revision) == params.facts_revision
                            && Some(facts.tab_size) == params.facts_tab_size
                    };
                    let base = session
                        .facts
                        .as_ref()
                        .filter(|facts| matches(facts))
                        .map(|facts| (Arc::clone(facts), session.facts_edits.clone()))
                        .or_else(|| {
                            session
                                .acknowledged_facts
                                .as_ref()
                                .filter(|(facts, _)| matches(facts))
                                .cloned()
                        });
                    let edits = base
                        .as_ref()
                        .map(|(_, edits)| edits.clone())
                        .unwrap_or_default();
                    let delta = current
                        .value
                        .delta(base.as_ref().map(|(facts, _)| facts.value.as_ref()), &edits);
                    response.facts = Some(SyntaxFactsDeltaDto {
                        base_revision: base.as_ref().map(|(facts, _)| facts.revision),
                        edits,
                        symbols: SyntaxSymbolsSpliceDto {
                            start: delta.symbols.start,
                            delete_count: delta.symbols.delete_count,
                            items: delta
                                .symbols
                                .items
                                .into_iter()
                                .map(|symbol| {
                                    (
                                        symbol.name,
                                        symbol_kind(symbol.kind),
                                        symbol.range,
                                        symbol.selection_range,
                                    )
                                })
                                .collect(),
                        },
                        folds: SyntaxFoldsSpliceDto {
                            start: delta.folds.start,
                            delete_count: delta.folds.delete_count,
                            items: delta
                                .folds
                                .items
                                .into_iter()
                                .map(|fold| {
                                    (
                                        fold.start_line_index,
                                        fold.end_line_index,
                                        fold.kind.map(str::to_owned),
                                    )
                                })
                                .collect(),
                        },
                        diagnostics: SyntaxDiagnosticsSpliceDto {
                            start: delta.diagnostics.start,
                            delete_count: delta.diagnostics.delete_count,
                            items: delta
                                .diagnostics
                                .items
                                .into_iter()
                                .map(|diagnostic| {
                                    (
                                        diagnostic.range,
                                        match diagnostic.kind {
                                            SyntaxDiagnosticKind::Error => {
                                                SyntaxDiagnosticKindDto::Error
                                            }
                                            SyntaxDiagnosticKind::Missing => {
                                                SyntaxDiagnosticKindDto::Missing
                                            }
                                        },
                                    )
                                })
                                .collect(),
                        },
                    });
                    // A sent response may be cancelled before the consumer sees it.
                    // Pin its last acknowledged base as well as our latest response;
                    // a burst can then keep sending patches against the observed base.
                    if base.is_some() {
                        session.acknowledged_facts = base;
                    }
                    session.facts = Some(current);
                    session.facts_edits.clear();
                }
            }
            SyntaxQueryKindDto::Preview => {
                let row = params.line_index.ok_or_else(invalid_params)?;
                if row >= session.document.line_count()
                    || params.lines.is_empty()
                    || params.lines.iter().any(|line| line.contains(['\r', '\n']))
                    || params.lines.iter().map(String::len).sum::<usize>() > 4_194_304
                {
                    return Err(invalid_params());
                }
                response.rows = project_rows(
                    session
                        .document
                        .editor_preview(row, &params.lines, &cancelled)
                        .map_err(syntax_error)?,
                );
            }
        }
        cancellation
            .check()
            .map_err(|_| syntax_error(SyntaxError::ParseCancelled))?;
        response.parse_ms = session.parse_ms.take().unwrap_or(0.0);
        response.query_ms = started.elapsed().as_secs_f64() * 1000.0;
        result(&response)
    }

    pub(super) fn syntax_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxCancelParams = decode(params)?;
        if params.operation_id.is_empty() || params.operation_id.len() > 128 {
            return Err(invalid_params());
        }
        self.request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id);
        self.request_scheduler.cancel_waiting_requests();
        result(&())
    }

    pub(super) fn syntax_update(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxUpdateParams = decode(params)?;
        let session = self.syntax_document(connection, &params.document_id)?;
        let mut session = session.lock().map_err(|_| internal_error())?;
        if session.document.revision().value() != params.previous_revision
            || params.revision <= params.previous_revision
        {
            return Err(invalid_params());
        }
        let mut edits = Vec::with_capacity(params.edits.len());
        for edit in params.edits {
            let start = byte_offset_for_utf16_index(&session.document, edit.start_offset)
                .ok_or_else(invalid_params)?;
            let end = byte_offset_for_utf16_index(&session.document, edit.end_offset)
                .ok_or_else(invalid_params)?;
            edits.push(SyntaxEdit::replace(start..end, edit.text));
        }
        match session.analysis {
            SessionAnalysis::Complete(_) => {
                let snapshot = session
                    .document
                    .apply_edits(DocumentRevision::new(params.revision), &edits)
                    .map_err(syntax_error)?;
                session.analysis = SessionAnalysis::Complete(snapshot);
            }
            SessionAnalysis::Shared(_) => {
                // A Rope snapshot shares untouched nodes. Preserve old coordinates
                // until the document has atomically validated and reduced the batch.
                let previous_text: Option<ropey::Rope> = session
                    .facts
                    .as_ref()
                    .map(|_| session.document.text().into());
                let started = Instant::now();
                let edits = session
                    .document
                    .update_edits(DocumentRevision::new(params.revision), &edits)
                    .map_err(syntax_error)?;
                session.parse_ms = Some(
                    session.parse_ms.unwrap_or(0.0) + started.elapsed().as_secs_f64() * 1000.0,
                );
                session.analysis = SessionAnalysis::Shared(None);
                let mut facts_edits = Vec::new();
                if let Some(previous_text) = previous_text {
                    let offsets = edits
                        .iter()
                        .flat_map(|edit| [edit.range().start, edit.range().end])
                        .collect();
                    let positions = Utf16PositionIndex::for_text(previous_text.slice(..), offsets);
                    for edit in &edits {
                        let start = positions.position(edit.range().start);
                        let end = positions.position(edit.range().end);
                        let rows = edit
                            .replacement()
                            .bytes()
                            .filter(|byte| *byte == b'\n')
                            .count();
                        let column = edit
                            .replacement()
                            .rsplit('\n')
                            .next()
                            .unwrap()
                            .encode_utf16()
                            .count();
                        facts_edits.push([
                            start.line_index,
                            start.column_index,
                            end.line_index,
                            end.column_index,
                            start.line_index + rows,
                            if rows == 0 {
                                start.column_index + column
                            } else {
                                column
                            },
                        ]);
                    }
                }
                if let Some((_, pending)) = &mut session.acknowledged_facts {
                    pending.extend_from_slice(&facts_edits);
                    if pending.len() > 1024 {
                        session.acknowledged_facts = None;
                    }
                }
                session.facts_edits.extend(facts_edits);
                // A slow consumer may skip arbitrarily many revisions. Bound retained
                // deltas and use a fresh snapshot rather than growing without limit.
                if session.facts_edits.len() > 1024 {
                    session.facts = None;
                    session.acknowledged_facts = None;
                    session.facts_edits.clear();
                }
            }
        }
        result(&())
    }

    pub(super) fn syntax_analyze(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxAnalyzeParams = decode(params)?;
        let document = self.syntax_document(connection, &params.document_id)?;
        let document = document.lock().map_err(|_| internal_error())?;
        validate_revision(&document, params.revision)?;
        let SessionAnalysis::Complete(snapshot) = &document.analysis else {
            return Err(invalid_params());
        };
        result(&project(&document.document, snapshot))
    }

    pub(super) fn syntax_selection_ranges(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxSelectionRangesParams = decode(params)?;
        let document = self.syntax_document(connection, &params.document_id)?;
        let document = document.lock().map_err(|_| internal_error())?;
        validate_revision(&document, params.revision)?;
        let mut ranges = Vec::new();
        for requested in params.ranges {
            let requested = byte_range_for_utf16(&document.document, requested)
                .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
            ranges.extend(
                document
                    .document
                    .selection_ranges(requested)
                    .map_err(syntax_error)?,
            );
        }
        ranges.sort_by_key(|selection| {
            (
                selection.range.bytes.start,
                std::cmp::Reverse(selection.range.bytes.end),
            )
        });
        ranges.dedup_by(|left, right| left.range.bytes == right.range.bytes);
        let positions = Utf16PositionIndex::for_selection_ranges(&document.document, &ranges);
        result(&SyntaxSelectionRangesResult {
            revision: params.revision,
            ranges: ranges
                .iter()
                .map(|selection| SyntaxSelectionRangeDto {
                    range: positions.project_range(&selection.range),
                })
                .collect(),
        })
    }

    pub(super) fn syntax_close(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SyntaxCloseParams = decode(params)?;
        validate_document_id(&params.document_id)?;
        self.syntax_documents
            .lock()
            .map_err(|_| internal_error())?
            .remove(&(connection.connection_id, params.document_id));
        result(&())
    }

    fn syntax_document(
        &self,
        connection: &ConnectionState,
        document_id: &str,
    ) -> Result<Arc<Mutex<SyntaxSession>>, RpcError> {
        validate_document_id(document_id)?;
        self.syntax_documents
            .lock()
            .map_err(|_| internal_error())?
            .get(&(connection.connection_id, document_id.to_owned()))
            .cloned()
            .ok_or_else(invalid_params)
    }
}

fn project_rows(rows: Vec<ash_syntax::EditorRow>) -> Vec<SyntaxRowDto> {
    rows.into_iter()
        .map(|row| SyntaxRowDto {
            row: row.row,
            tokens: row
                .tokens
                .into_iter()
                .map(|token| SyntaxCaptureDto {
                    language_id: token.language_id.map(str::to_owned),
                    start: token.start,
                    end: token.end,
                    name: token.name,
                })
                .collect(),
        })
        .collect()
}

fn validate_revision(document: &SyntaxSession, revision: u64) -> Result<(), RpcError> {
    if document.document.revision().value() != revision {
        return Err(invalid_params());
    }
    Ok(())
}

fn byte_offset_for_utf16_index(document: &SyntaxDocument, requested: usize) -> Option<usize> {
    let text = document.text();
    let index = text.try_utf16_cu_to_char(requested).ok()?;
    (text.char_to_utf16_cu(index) == requested).then(|| text.char_to_byte(index))
}

fn invalid_params() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn validate_document_id(document_id: &str) -> Result<(), RpcError> {
    if document_id.is_empty() || document_id.len() > 128 {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    Ok(())
}

fn internal_error() -> RpcError {
    RpcError::new(-32603, AppServerErrorName::InternalError)
}

include!("../syntax_language.generated.rs");

fn project(document: &SyntaxDocument, snapshot: &SyntaxSnapshot) -> SyntaxAnalyzeResult {
    let positions = Utf16PositionIndex::for_snapshot(document, snapshot);
    SyntaxAnalyzeResult {
        revision: snapshot.revision().value(),
        has_errors: snapshot.has_errors(),
        tokens: snapshot
            .tokens()
            .iter()
            .map(|token| SyntaxTokenDto {
                range: positions.project_range(&token.range),
                kind: token_kind(token.kind),
            })
            .collect(),
        folding_ranges: snapshot
            .folding_ranges()
            .iter()
            .map(|fold| SyntaxFoldingRangeDto {
                range: positions.project_range(&fold.range),
            })
            .collect(),
        symbols: snapshot
            .symbols()
            .iter()
            .map(|symbol| SyntaxSymbolDto {
                name: symbol.name.clone(),
                kind: symbol_kind(symbol.kind),
                range: positions.project_range(&symbol.range),
                selection_range: positions.project_range(&symbol.selection_range),
            })
            .collect(),
        diagnostics: snapshot
            .diagnostics()
            .iter()
            .map(|diagnostic| SyntaxDiagnosticDto {
                range: positions.project_range(&diagnostic.range),
                kind: diagnostic_kind(diagnostic.kind),
            })
            .collect(),
    }
}

fn token_kind(kind: SyntaxTokenKind) -> SyntaxTokenKindDto {
    match kind {
        SyntaxTokenKind::Attribute => SyntaxTokenKindDto::Attribute,
        SyntaxTokenKind::Comment => SyntaxTokenKindDto::Comment,
        SyntaxTokenKind::Constant => SyntaxTokenKindDto::Constant,
        SyntaxTokenKind::Constructor => SyntaxTokenKindDto::Constructor,
        SyntaxTokenKind::Embedded => SyntaxTokenKindDto::Embedded,
        SyntaxTokenKind::Function => SyntaxTokenKindDto::Function,
        SyntaxTokenKind::Keyword => SyntaxTokenKindDto::Keyword,
        SyntaxTokenKind::Label => SyntaxTokenKindDto::Label,
        SyntaxTokenKind::Module => SyntaxTokenKindDto::Module,
        SyntaxTokenKind::Number => SyntaxTokenKindDto::Number,
        SyntaxTokenKind::Operator => SyntaxTokenKindDto::Operator,
        SyntaxTokenKind::Property => SyntaxTokenKindDto::Property,
        SyntaxTokenKind::Punctuation => SyntaxTokenKindDto::Punctuation,
        SyntaxTokenKind::String => SyntaxTokenKindDto::String,
        SyntaxTokenKind::Type => SyntaxTokenKindDto::Type,
        SyntaxTokenKind::Variable => SyntaxTokenKindDto::Variable,
    }
}

fn symbol_kind(kind: DocumentSymbolKind) -> SyntaxSymbolKindDto {
    match kind {
        DocumentSymbolKind::Constant => SyntaxSymbolKindDto::Constant,
        DocumentSymbolKind::Enum => SyntaxSymbolKindDto::Enum,
        DocumentSymbolKind::Field => SyntaxSymbolKindDto::Field,
        DocumentSymbolKind::Function => SyntaxSymbolKindDto::Function,
        DocumentSymbolKind::Macro => SyntaxSymbolKindDto::Macro,
        DocumentSymbolKind::Method => SyntaxSymbolKindDto::Method,
        DocumentSymbolKind::Module => SyntaxSymbolKindDto::Module,
        DocumentSymbolKind::Static => SyntaxSymbolKindDto::Static,
        DocumentSymbolKind::Struct => SyntaxSymbolKindDto::Struct,
        DocumentSymbolKind::Trait => SyntaxSymbolKindDto::Trait,
        DocumentSymbolKind::Type => SyntaxSymbolKindDto::Type,
        DocumentSymbolKind::Variable => SyntaxSymbolKindDto::Variable,
    }
}

fn diagnostic_kind(kind: SyntaxDiagnosticKind) -> SyntaxDiagnosticKindDto {
    match kind {
        SyntaxDiagnosticKind::Error => SyntaxDiagnosticKindDto::Error,
        SyntaxDiagnosticKind::Missing => SyntaxDiagnosticKindDto::Missing,
    }
}

fn syntax_error(error: SyntaxError) -> RpcError {
    match error {
        SyntaxError::DocumentTooLarge { .. } => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        SyntaxError::Language { .. }
        | SyntaxError::Query { .. }
        | SyntaxError::ParseCancelled
        | SyntaxError::NonIncreasingRevision { .. }
        | SyntaxError::InvalidEditRange { .. }
        | SyntaxError::InvalidEditBoundary { .. }
        | SyntaxError::InvalidSelectionRange { .. }
        | SyntaxError::InvalidSelectionBoundary { .. }
        | SyntaxError::OverlappingEdits => {
            RpcError::new(-32071, AppServerErrorName::SyntaxAnalysisFailed)
        }
    }
}

struct Utf16PositionIndex {
    byte_offsets: Vec<usize>,
    positions: Vec<SyntaxPositionDto>,
}

impl Utf16PositionIndex {
    fn for_snapshot(document: &SyntaxDocument, snapshot: &SyntaxSnapshot) -> Self {
        let mut byte_offsets = Vec::with_capacity(
            snapshot.tokens().len() * 2
                + snapshot.folding_ranges().len() * 2
                + snapshot.symbols().len() * 4
                + snapshot.diagnostics().len() * 2,
        );
        for token in snapshot.tokens() {
            push_range_offsets(&mut byte_offsets, &token.range);
        }
        for folding_range in snapshot.folding_ranges() {
            push_range_offsets(&mut byte_offsets, &folding_range.range);
        }
        for symbol in snapshot.symbols() {
            push_range_offsets(&mut byte_offsets, &symbol.range);
            push_range_offsets(&mut byte_offsets, &symbol.selection_range);
        }
        for diagnostic in snapshot.diagnostics() {
            push_range_offsets(&mut byte_offsets, &diagnostic.range);
        }
        Self::for_offsets(document, byte_offsets)
    }

    fn for_selection_ranges(
        document: &SyntaxDocument,
        ranges: &[ash_syntax::SelectionRange],
    ) -> Self {
        let mut byte_offsets = Vec::with_capacity(ranges.len() * 2);
        for selection in ranges {
            push_range_offsets(&mut byte_offsets, &selection.range);
        }
        Self::for_offsets(document, byte_offsets)
    }

    fn for_offsets(document: &SyntaxDocument, byte_offsets: Vec<usize>) -> Self {
        Self::for_text(document.text(), byte_offsets)
    }

    fn for_text(text: ropey::RopeSlice<'_>, mut byte_offsets: Vec<usize>) -> Self {
        byte_offsets.sort_unstable();
        byte_offsets.dedup();

        // Small patches use Rope metrics instead of walking from the document's start.
        // Full snapshots keep the sorted linear walk, avoiding a tree lookup per field.
        if byte_offsets.len() <= 128 {
            let positions = byte_offsets
                .iter()
                .map(|offset| {
                    let row = text.byte_to_line(*offset);
                    let index = text.byte_to_char(*offset);
                    assert_eq!(
                        text.char_to_byte(index),
                        *offset,
                        "syntax range boundary must be UTF-8"
                    );
                    SyntaxPositionDto {
                        line_index: row,
                        column_index: text.char_to_utf16_cu(index)
                            - text.char_to_utf16_cu(text.line_to_char(row)),
                    }
                })
                .collect();
            return Self {
                byte_offsets,
                positions,
            };
        }
        let mut positions = Vec::with_capacity(byte_offsets.len());
        let mut next_offset = 0;
        let mut line_index = 0;
        let mut column_index = 0;
        let mut byte_offset = 0;
        for character in text.chars() {
            while byte_offsets.get(next_offset) == Some(&byte_offset) {
                positions.push(SyntaxPositionDto {
                    line_index,
                    column_index,
                });
                next_offset += 1;
            }
            if next_offset == byte_offsets.len() {
                break;
            }
            if character == '\n' {
                line_index += 1;
                column_index = 0;
            } else {
                column_index += character.len_utf16();
            }
            byte_offset += character.len_utf8();
        }
        while byte_offsets.get(next_offset) == Some(&text.len_bytes()) {
            positions.push(SyntaxPositionDto {
                line_index,
                column_index,
            });
            next_offset += 1;
        }
        assert_eq!(
            next_offset,
            byte_offsets.len(),
            "syntax ranges must contain only UTF-8 boundaries"
        );
        Self {
            byte_offsets,
            positions,
        }
    }

    fn project_range(&self, range: &SyntaxRange) -> SyntaxRangeDto {
        SyntaxRangeDto {
            start: self.position(range.bytes.start),
            end: self.position(range.bytes.end),
        }
    }

    fn position(&self, byte_offset: usize) -> SyntaxPositionDto {
        let index = self
            .byte_offsets
            .binary_search(&byte_offset)
            .expect("syntax range boundary must be indexed");
        self.positions[index]
    }
}

fn byte_range_for_utf16(
    document: &SyntaxDocument,
    range: SyntaxRangeDto,
) -> Option<std::ops::Range<usize>> {
    let start = byte_offset_for_utf16(document, range.start)?;
    let end = byte_offset_for_utf16(document, range.end)?;
    (start <= end).then_some(start..end)
}

fn byte_offset_for_utf16(document: &SyntaxDocument, requested: SyntaxPositionDto) -> Option<usize> {
    let text = document.text();
    let line = text.get_line(requested.line_index)?;
    let has_lf = line.len_bytes() > 0 && line.byte(line.len_bytes() - 1) == b'\n';
    if requested.column_index > line.len_utf16_cu() - usize::from(has_lf) {
        return None;
    }
    let index = line.try_utf16_cu_to_char(requested.column_index).ok()?;
    (line.char_to_utf16_cu(index) == requested.column_index)
        .then(|| text.line_to_byte(requested.line_index) + line.char_to_byte(index))
}

fn push_range_offsets(offsets: &mut Vec<usize>, range: &SyntaxRange) {
    offsets.push(range.bytes.start);
    offsets.push(range.bytes.end);
}

#[cfg(test)]
#[path = "../syntax_operations_tests.rs"]
mod tests;

struct SharedFacts {
    revision: u64,
    tab_size: usize,
    value: Arc<ash_syntax::EditorFacts>,
}
