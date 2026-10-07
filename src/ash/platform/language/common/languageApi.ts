import type { LanguageServersParams, LanguageServersResult, LanguageCloseParams, LanguageCodeActionDto, LanguageCodeActionsParams, LanguageCodeActionsResult, LanguageCodeLensesResult, LanguageColorPresentationsParams, LanguageColorPresentationsResult, LanguageCompletionDetailsResult, LanguageCompletionsParams, LanguageCompletionsResult, LanguageDirectoryDiagnosticsParams, LanguageDirectoryDiagnosticsResult, LanguageDirectoryEditDto, LanguageDirectorySymbolsParams, LanguageDirectorySymbolsResult, LanguageDocumentColorsResult, LanguageDocumentDiagnosticsParams, LanguageDocumentDiagnosticsResult, LanguageDocumentFeaturesParams, LanguageDocumentFormattingParams, LanguageDocumentLinksResult, LanguageDocumentSymbolsResult, LanguageExecuteCommandParams, LanguageFoldingRangesResult, LanguageFormattingResult, LanguageHierarchyParams, LanguageHierarchyResultDto, LanguageHoverParams, LanguageHoverResult, LanguageInlayHintsParams, LanguageInlayHintsResult, LanguageLinkedEditingRangesParams, LanguageLinkedEditingRangesResult, LanguageLocationsParams, LanguageLocationsResult, LanguagePrepareRenameParams, LanguagePrepareRenameResult, LanguageRangeFormattingParams, LanguageRenameParams, LanguageResolveCodeActionParams, LanguageResolveCodeLensParams, LanguageResolveCompletionParams, LanguageResolveDocumentLinkParams, LanguageSemanticTokensParams, LanguageSemanticTokensResult, LanguageSignatureHelpParams, LanguageSignatureHelpResult, LanguageSynchronizeParams } from "../../app-server/common/generated/index.js";
import { CancellationError } from "../../../base/common/errors.js";

/** Transport-neutral entry point for workspace language-server locations. */
export interface LanguageRequestOptions {
	readonly signal?: AbortSignal;
}

export interface LanguageCancelOutcome {
	readonly status: "requested" | "alreadyRequested" | "completed";
}

/** Runs one language operation and resolves cancellation against its terminal result. */
export function runCancellableLanguageRequest<TResult>(
	options: LanguageRequestOptions | undefined,
	start: (operationId: string) => Promise<TResult>,
	cancel: (operationId: string) => Promise<LanguageCancelOutcome>,
): Promise<TResult> {
	const signal = options?.signal;
	if (signal?.aborted) return Promise.reject(new CancellationError("Language request cancelled", signal.reason));
	const operationId = globalThis.crypto.randomUUID();
	const pending = start(operationId);
	if (!signal) return pending;
	return new Promise<TResult>((resolve, reject) => {
		let settled = false;
		let cancelling = false;
		let pendingRejected = false;
		let pendingError: unknown;
		const cleanup = (): void => signal.removeEventListener("abort", abort);
		const abort = (): void => {
			if (settled || cancelling) return;
			cancelling = true;
			void cancel(operationId).then(
				result => {
					if (settled) return;
					if (result.status === "completed") {
						cancelling = false;
						if (pendingRejected) {
							settled = true;
							cleanup();
							reject(pendingError);
						}
						return;
					}
					settled = true;
					cleanup();
					reject(new CancellationError("Language request cancelled", signal.reason));
				},
				error => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
			);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		pending.then(
			value => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			error => {
				if (settled) return;
				if (cancelling) {
					pendingRejected = true;
					pendingError = error;
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

export interface ILanguageApi {
	servers(params: LanguageServersParams): Promise<LanguageServersResult>;
	synchronize(params: LanguageSynchronizeParams): Promise<void>;
	close(params: LanguageCloseParams): Promise<void>;
	hover(params: LanguageHoverParams, options?: LanguageRequestOptions): Promise<LanguageHoverResult>;
	completions(params: LanguageCompletionsParams, options?: LanguageRequestOptions): Promise<LanguageCompletionsResult>;
	resolveCompletion(params: LanguageResolveCompletionParams, options?: LanguageRequestOptions): Promise<LanguageCompletionDetailsResult>;
	executeCommand(params: LanguageExecuteCommandParams): Promise<void>;
	documentDiagnostics(params: LanguageDocumentDiagnosticsParams, options?: LanguageRequestOptions): Promise<LanguageDocumentDiagnosticsResult>;
	directoryDiagnostics(params: LanguageDirectoryDiagnosticsParams, options?: LanguageRequestOptions): Promise<LanguageDirectoryDiagnosticsResult>;
	formatDocument(params: LanguageDocumentFormattingParams, options?: LanguageRequestOptions): Promise<LanguageFormattingResult>;
	formatRange(params: LanguageRangeFormattingParams, options?: LanguageRequestOptions): Promise<LanguageFormattingResult>;
	signatureHelp(params: LanguageSignatureHelpParams, options?: LanguageRequestOptions): Promise<LanguageSignatureHelpResult>;
	inlayHints(params: LanguageInlayHintsParams, options?: LanguageRequestOptions): Promise<LanguageInlayHintsResult>;
	linkedEditingRanges(params: LanguageLinkedEditingRangesParams, options?: LanguageRequestOptions): Promise<LanguageLinkedEditingRangesResult>;
	semanticTokens(params: LanguageSemanticTokensParams, options?: LanguageRequestOptions): Promise<LanguageSemanticTokensResult>;
	documentSymbols(params: LanguageDocumentFeaturesParams, options?: LanguageRequestOptions): Promise<LanguageDocumentSymbolsResult>;
	codeLenses(params: LanguageDocumentFeaturesParams, options?: LanguageRequestOptions): Promise<LanguageCodeLensesResult>;
	resolveCodeLens(params: LanguageResolveCodeLensParams, options?: LanguageRequestOptions): Promise<LanguageCodeLensesResult>;
	documentLinks(params: LanguageDocumentFeaturesParams, options?: LanguageRequestOptions): Promise<LanguageDocumentLinksResult>;
	resolveDocumentLink(params: LanguageResolveDocumentLinkParams, options?: LanguageRequestOptions): Promise<LanguageDocumentLinksResult>;
	documentColors(params: LanguageDocumentFeaturesParams, options?: LanguageRequestOptions): Promise<LanguageDocumentColorsResult>;
	colorPresentations(params: LanguageColorPresentationsParams, options?: LanguageRequestOptions): Promise<LanguageColorPresentationsResult>;
	foldingRanges(params: LanguageDocumentFeaturesParams, options?: LanguageRequestOptions): Promise<LanguageFoldingRangesResult>;
	locations(params: LanguageLocationsParams, options?: LanguageRequestOptions): Promise<LanguageLocationsResult>;
	hierarchy(params: LanguageHierarchyParams, options?: LanguageRequestOptions): Promise<LanguageHierarchyResultDto>;
	directorySymbols(params: LanguageDirectorySymbolsParams, options?: LanguageRequestOptions): Promise<LanguageDirectorySymbolsResult>;
	prepareRename(params: LanguagePrepareRenameParams, options?: LanguageRequestOptions): Promise<LanguagePrepareRenameResult>;
	rename(params: LanguageRenameParams, options?: LanguageRequestOptions): Promise<LanguageDirectoryEditDto>;
	codeActions(params: LanguageCodeActionsParams, options?: LanguageRequestOptions): Promise<LanguageCodeActionsResult>;
	resolveCodeAction(params: LanguageResolveCodeActionParams, options?: LanguageRequestOptions): Promise<LanguageCodeActionDto>;
}
