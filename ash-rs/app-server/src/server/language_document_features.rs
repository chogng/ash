use std::path::PathBuf;
use std::sync::MutexGuard;

use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::language::LanguageCodeLensDto;
use ash_app_server_protocol::protocol::language::LanguageCodeLensesResult;
use ash_app_server_protocol::protocol::language::LanguageColorDto;
use ash_app_server_protocol::protocol::language::LanguageColorPresentationDto;
use ash_app_server_protocol::protocol::language::LanguageColorPresentationsParams;
use ash_app_server_protocol::protocol::language::LanguageColorPresentationsResult;
use ash_app_server_protocol::protocol::language::LanguageCommandDto;
use ash_app_server_protocol::protocol::language::LanguageDocumentColorDto;
use ash_app_server_protocol::protocol::language::LanguageDocumentColorsResult;
use ash_app_server_protocol::protocol::language::LanguageDocumentDto;
use ash_app_server_protocol::protocol::language::LanguageDocumentFeaturesParams;
use ash_app_server_protocol::protocol::language::LanguageDocumentLinkDto;
use ash_app_server_protocol::protocol::language::LanguageDocumentLinksResult;
use ash_app_server_protocol::protocol::language::LanguageDocumentSymbolDto;
use ash_app_server_protocol::protocol::language::LanguageDocumentSymbolsResult;
use ash_app_server_protocol::protocol::language::LanguageFoldingRangeDto;
use ash_app_server_protocol::protocol::language::LanguageFoldingRangeKindDto;
use ash_app_server_protocol::protocol::language::LanguageFoldingRangesResult;
use ash_app_server_protocol::protocol::language::LanguageResolveCodeLensParams;
use ash_app_server_protocol::protocol::language::LanguageResolveDocumentLinkParams;
use ash_app_server_protocol::protocol::language::LanguageTextEditDto;
use ash_async_utils::CancellationToken;
use ash_lsp_manager::LanguageCodeLens;
use ash_lsp_manager::LanguageColor;
use ash_lsp_manager::LanguageCommand;
use ash_lsp_manager::LanguageDocumentLink;
use ash_lsp_manager::LanguageDocumentRevision;
use ash_lsp_manager::LanguageDocumentSymbol;
use ash_lsp_manager::LanguageFoldingRangeKind;
use ash_lsp_manager::LanguageTextEdit;
use ash_lsp_manager::LanguageTextRange;
use ash_lsp_manager::LspManagerRequestResult;
use serde_json::Value;

use super::AppServer;
use super::RpcError;
use super::language_operations::byte_range_to_utf16;
use super::language_operations::decode_language_operation;
use super::language_operations::language_error;
use super::language_operations::utf8_byte_range;
use super::language_runtime::AppServerLanguageRuntime;
use super::result;

impl AppServer {
    pub(super) fn language_document_symbols(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageDocumentFeaturesParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .request_document_symbols(&source_path, revision)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let symbols = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::DocumentSymbols(result) => result.symbols,
            LspManagerRequestResult::RequestFailed { .. } => Vec::new(),
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let symbols = symbols
            .into_iter()
            .filter_map(|symbol| document_symbol_to_dto(&params.document.text, symbol))
            .collect();
        result(&LanguageDocumentSymbolsResult {
            revision: params.document.revision,
            symbols,
        })
    }

    pub(super) fn language_code_lenses(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageDocumentFeaturesParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .request_code_lenses(&source_path, revision)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let lenses = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::CodeLenses(result) => result.lenses,
            LspManagerRequestResult::RequestFailed { .. } => Vec::new(),
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let lenses = lenses
            .into_iter()
            .filter_map(|lens| code_lens_to_dto(&params.document.text, lens))
            .collect();
        result(&LanguageCodeLensesResult {
            revision: params.document.revision,
            lenses,
        })
    }

    pub(super) fn language_resolve_code_lens(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageResolveCodeLensParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let lens = code_lens_from_dto(&params.document.text, params.lens)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .resolve_code_lens(&source_path, revision, lens)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let lens = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::CodeLenses(result) => result
                .lenses
                .into_iter()
                .next()
                .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?,
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let lens = code_lens_to_dto(&params.document.text, lens)
            .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?;
        result(&LanguageCodeLensesResult {
            revision: params.document.revision,
            lenses: vec![lens],
        })
    }

    pub(super) fn language_document_links(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageDocumentFeaturesParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .request_document_links(&source_path, revision)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let links = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::DocumentLinks(result) => result.links,
            LspManagerRequestResult::RequestFailed { .. } => Vec::new(),
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let links = links
            .into_iter()
            .filter_map(|link| document_link_to_dto(&params.document.text, link))
            .collect();
        result(&LanguageDocumentLinksResult {
            revision: params.document.revision,
            links,
        })
    }

    pub(super) fn language_resolve_document_link(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageResolveDocumentLinkParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let link = document_link_from_dto(&params.document.text, params.link)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .resolve_document_link(&source_path, revision, link)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let link = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::DocumentLinks(result) => result
                .links
                .into_iter()
                .next()
                .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?,
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let link = document_link_to_dto(&params.document.text, link)
            .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?;
        result(&LanguageDocumentLinksResult {
            revision: params.document.revision,
            links: vec![link],
        })
    }

    pub(super) fn language_document_colors(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageDocumentFeaturesParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .request_document_colors(&source_path, revision)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let colors = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::DocumentColors(result) => result.colors,
            LspManagerRequestResult::RequestFailed { .. } => Vec::new(),
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let colors = colors
            .into_iter()
            .filter_map(|color| {
                Some(LanguageDocumentColorDto {
                    range: byte_range_to_utf16(&params.document.text, color.range.byte_range())?,
                    color: color_to_dto(color.color),
                })
            })
            .collect();
        result(&LanguageDocumentColorsResult {
            revision: params.document.revision,
            colors,
        })
    }

    pub(super) fn language_color_presentations(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageColorPresentationsParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let range = LanguageTextRange::new(
            utf8_byte_range(&params.document.text, params.range)
                .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?,
        );
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .request_color_presentations(
                &source_path,
                revision,
                range,
                color_from_dto(params.color),
            )
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let presentations = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::ColorPresentations(result) => result.presentations,
            LspManagerRequestResult::RequestFailed { .. } => Vec::new(),
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let presentations = presentations
            .into_iter()
            .map(|presentation| LanguageColorPresentationDto {
                label: presentation.label,
                text_edit: presentation
                    .text_edit
                    .and_then(|edit| text_edit_to_dto(&params.document.text, edit)),
                additional_text_edits: presentation
                    .additional_text_edits
                    .into_iter()
                    .filter_map(|edit| text_edit_to_dto(&params.document.text, edit))
                    .collect(),
            })
            .collect();
        result(&LanguageColorPresentationsResult {
            revision: params.document.revision,
            presentations,
        })
    }

    pub(super) fn language_folding_ranges(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: LanguageDocumentFeaturesParams = decode_language_operation(params)?;
        let (source_path, revision, mut runtime) =
            self.prepare_document_feature_request(&params.document, cancellation)?;
        let request_id = runtime
            .manager()
            .ok_or_else(|| language_error(AppServerErrorName::LanguageServiceUnavailable))?
            .request_folding_ranges(&source_path, revision)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let ranges = match runtime
            .wait_for_request(request_id, cancellation)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?
        {
            LspManagerRequestResult::FoldingRanges(result) => result.ranges,
            LspManagerRequestResult::RequestFailed { .. } => Vec::new(),
            _ => return Err(language_error(AppServerErrorName::LanguageRequestFailed)),
        };
        let ranges = ranges
            .into_iter()
            .map(|range| LanguageFoldingRangeDto {
                start_line_index: range.start_line,
                end_line_index: range.end_line,
                kind: range.kind.map(|kind| match kind {
                    LanguageFoldingRangeKind::Comment => LanguageFoldingRangeKindDto::Comment,
                    LanguageFoldingRangeKind::Imports => LanguageFoldingRangeKindDto::Imports,
                    LanguageFoldingRangeKind::Region => LanguageFoldingRangeKindDto::Region,
                }),
                collapsed_text: range.collapsed_text,
            })
            .collect();
        result(&LanguageFoldingRangesResult {
            revision: params.document.revision,
            ranges,
        })
    }

    fn prepare_document_feature_request(
        &self,
        document: &LanguageDocumentDto,
        cancellation: &CancellationToken,
    ) -> Result<
        (
            PathBuf,
            LanguageDocumentRevision,
            MutexGuard<'_, AppServerLanguageRuntime>,
        ),
        RpcError,
    > {
        let dir = self.language_dir_root_for(
            document.dir_id.as_deref(),
            document.session_directory.as_ref(),
        )?;
        let source_path = dir
            .resolve_existing(&document.path)
            .map_err(|_| language_error(AppServerErrorName::LanguageRequestFailed))?;
        let revision = LanguageDocumentRevision::new(document.revision);
        let runtime = self.prepare_document_runtime(&dir, &source_path, document, cancellation)?;
        Ok((source_path, revision, runtime))
    }
}

fn document_symbol_to_dto(
    text: &str,
    symbol: LanguageDocumentSymbol,
) -> Option<LanguageDocumentSymbolDto> {
    Some(LanguageDocumentSymbolDto {
        name: symbol.name,
        detail: symbol.detail,
        symbol_kind: symbol.symbol_kind,
        range: byte_range_to_utf16(text, symbol.range.byte_range())?,
        selection_range: byte_range_to_utf16(text, symbol.selection_range.byte_range())?,
        children: symbol
            .children
            .into_iter()
            .filter_map(|child| document_symbol_to_dto(text, child))
            .collect(),
    })
}

fn command_to_dto(command: LanguageCommand) -> LanguageCommandDto {
    LanguageCommandDto {
        id: command.id,
        title: command.title,
        arguments: command.arguments,
    }
}

fn command_from_dto(command: LanguageCommandDto) -> LanguageCommand {
    LanguageCommand {
        id: command.id,
        title: command.title,
        arguments: command.arguments,
    }
}

fn code_lens_to_dto(text: &str, lens: LanguageCodeLens) -> Option<LanguageCodeLensDto> {
    Some(LanguageCodeLensDto {
        range: byte_range_to_utf16(text, lens.range.byte_range())?,
        command: lens.command.map(command_to_dto),
        provider_data: lens.provider_data,
    })
}

fn code_lens_from_dto(text: &str, lens: LanguageCodeLensDto) -> Result<LanguageCodeLens, RpcError> {
    Ok(LanguageCodeLens {
        range: LanguageTextRange::new(
            utf8_byte_range(text, lens.range)
                .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?,
        ),
        command: lens.command.map(command_from_dto),
        provider_data: lens.provider_data,
    })
}

fn document_link_to_dto(text: &str, link: LanguageDocumentLink) -> Option<LanguageDocumentLinkDto> {
    Some(LanguageDocumentLinkDto {
        range: byte_range_to_utf16(text, link.range.byte_range())?,
        target: link.target,
        tooltip: link.tooltip,
        provider_data: link.provider_data,
    })
}

fn document_link_from_dto(
    text: &str,
    link: LanguageDocumentLinkDto,
) -> Result<LanguageDocumentLink, RpcError> {
    Ok(LanguageDocumentLink {
        range: LanguageTextRange::new(
            utf8_byte_range(text, link.range)
                .ok_or_else(|| language_error(AppServerErrorName::LanguageRequestFailed))?,
        ),
        target: link.target,
        tooltip: link.tooltip,
        provider_data: link.provider_data,
    })
}

fn color_to_dto(color: LanguageColor) -> LanguageColorDto {
    LanguageColorDto {
        red: color.red,
        green: color.green,
        blue: color.blue,
        alpha: color.alpha,
    }
}

fn color_from_dto(color: LanguageColorDto) -> LanguageColor {
    LanguageColor {
        red: color.red,
        green: color.green,
        blue: color.blue,
        alpha: color.alpha,
    }
}

fn text_edit_to_dto(text: &str, edit: LanguageTextEdit) -> Option<LanguageTextEditDto> {
    Some(LanguageTextEditDto {
        range: byte_range_to_utf16(text, edit.range.byte_range())?,
        new_text: edit.new_text,
    })
}
