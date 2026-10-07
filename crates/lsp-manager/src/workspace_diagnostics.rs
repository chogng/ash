use std::path::PathBuf;

use ash_lsp::lsp_types::PositionEncodingKind;
use ash_lsp::lsp_types::WorkspaceDiagnosticReportResult;
use ash_lsp::lsp_types::WorkspaceDocumentDiagnosticReport;

use crate::LanguageDiagnosticSeverity;
use crate::LanguageLocationPosition;
use crate::LanguageLocationRange;
use crate::LanguagePositionEncoding;
use crate::LanguageRequestId;
use crate::projection::code_string;
use crate::projection::severity;
use crate::requests::file_path;

/// One raw workspace diagnostic whose range retains the negotiated server encoding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDirectoryDiagnostic {
    pub path: PathBuf,
    pub range: LanguageLocationRange,
    pub encoding: LanguagePositionEncoding,
    pub severity: LanguageDiagnosticSeverity,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
}

/// Complete workspace diagnostic report returned by one ready language server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageDirectoryDiagnostics {
    pub request_id: LanguageRequestId,
    pub language_id: String,
    pub supported: bool,
    pub diagnostics: Vec<LanguageDirectoryDiagnostic>,
}

pub(crate) fn project_workspace_diagnostics(
    request_id: LanguageRequestId,
    language_id: String,
    encoding: &PositionEncodingKind,
    response: WorkspaceDiagnosticReportResult,
) -> Result<LanguageDirectoryDiagnostics, String> {
    let reports = match response {
        WorkspaceDiagnosticReportResult::Report(report) => report.items,
        WorkspaceDiagnosticReportResult::Partial(_) => {
            return Err("workspace diagnostic partial result omitted its primary report".into());
        }
    };
    let encoding = if *encoding == PositionEncodingKind::UTF8 {
        LanguagePositionEncoding::Utf8
    } else {
        LanguagePositionEncoding::Utf16
    };
    let mut diagnostics = Vec::new();
    for report in reports {
        let WorkspaceDocumentDiagnosticReport::Full(report) = report else {
            continue;
        };
        let Some(path) = file_path(&report.uri) else {
            continue;
        };
        diagnostics.extend(
            report
                .full_document_diagnostic_report
                .items
                .into_iter()
                .map(|diagnostic| LanguageDirectoryDiagnostic {
                    path: path.clone(),
                    range: LanguageLocationRange {
                        start: LanguageLocationPosition {
                            row: diagnostic.range.start.line,
                            character: diagnostic.range.start.character,
                        },
                        end: LanguageLocationPosition {
                            row: diagnostic.range.end.line,
                            character: diagnostic.range.end.character,
                        },
                    },
                    encoding,
                    severity: severity(diagnostic.severity),
                    message: diagnostic.message,
                    source: diagnostic.source,
                    code: diagnostic.code.map(code_string),
                }),
        );
    }
    Ok(LanguageDirectoryDiagnostics {
        request_id,
        language_id,
        supported: true,
        diagnostics,
    })
}
