import type { AppServerMethod, LanguageOperationParams, MethodParams, MethodResult } from "../../app-server/common/generated/index.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import { runCancellableLanguageRequest, type ILanguageApi, type LanguageRequestOptions } from "../common/languageApi.js";

export function createDisconnectedLanguageApi(unavailable: UnavailableOperation): ILanguageApi {
	return { servers: () => unavailable("language.servers"), synchronize: () => unavailable("language.synchronize"), close: () => unavailable("language.close"), hover: () => unavailable("language.hover"), completions: () => unavailable("language.completions"), resolveCompletion: () => unavailable("language.resolveCompletion"), executeCommand: () => unavailable("language.executeCommand"), documentDiagnostics: () => unavailable("language.documentDiagnostics"), directoryDiagnostics: () => unavailable("language.directoryDiagnostics"), formatDocument: () => unavailable("language.formatDocument"), formatRange: () => unavailable("language.formatRange"), signatureHelp: () => unavailable("language.signatureHelp"), inlayHints: () => unavailable("language.inlayHints"), linkedEditingRanges: () => unavailable("language.linkedEditingRanges"), semanticTokens: () => unavailable("language.semanticTokens"), documentSymbols: () => unavailable("language.documentSymbols"), codeLenses: () => unavailable("language.codeLenses"), resolveCodeLens: () => unavailable("language.resolveCodeLens"), documentLinks: () => unavailable("language.documentLinks"), resolveDocumentLink: () => unavailable("language.resolveDocumentLink"), documentColors: () => unavailable("language.documentColors"), colorPresentations: () => unavailable("language.colorPresentations"), foldingRanges: () => unavailable("language.foldingRanges"), locations: () => unavailable("language.locations"), hierarchy: () => unavailable("language.hierarchy"), directorySymbols: () => unavailable("language.directorySymbols"), prepareRename: () => unavailable("language.prepareRename"), rename: () => unavailable("language.rename"), codeActions: () => unavailable("language.codeActions"), resolveCodeAction: () => unavailable("language.resolveCodeAction") };
}

export function createAppServerLanguageApi(connection: AppServerProtocolClient): ILanguageApi {
	return {
		servers: params => appServerRequest(connection, "language/servers", params),
		synchronize: params => voidResult(appServerRequest(connection, "language/synchronize", params)),
		close: params => voidResult(appServerRequest(connection, "language/close", params)),
		hover: (params, options) => languageRequest(connection, "language/hover", params, options, languageOperationParams),
		completions: (params, options) => languageRequest(connection, "language/completions", params, options, languageOperationParams),
		resolveCompletion: (params, options) => languageRequest(connection, "language/resolveCompletion", params, options, languageOperationParams),
		executeCommand: params => voidResult(appServerRequest(connection, "language/executeCommand", params)),
		documentDiagnostics: (params, options) => languageRequest(connection, "language/documentDiagnostics", params, options, languageOperationParams),
		directoryDiagnostics: (params, options) => languageRequest(connection, "language/directoryDiagnostics", params, options, languageOperationParams),
		formatDocument: (params, options) => languageRequest(connection, "language/formatDocument", params, options, languageOperationParams),
		formatRange: (params, options) => languageRequest(connection, "language/formatRange", params, options, languageOperationParams),
		signatureHelp: (params, options) => languageRequest(connection, "language/signatureHelp", params, options, languageOperationParams),
		inlayHints: (params, options) => languageRequest(connection, "language/inlayHints", params, options, languageOperationParams),
		linkedEditingRanges: (params, options) => languageRequest(connection, "language/linkedEditingRanges", params, options, languageOperationParams),
		semanticTokens: (params, options) => languageRequest(connection, "language/semanticTokens", params, options, languageOperationParams),
		documentSymbols: (params, options) => languageRequest(connection, "language/documentSymbols", params, options, languageOperationParams),
		codeLenses: (params, options) => languageRequest(connection, "language/codeLenses", params, options, languageOperationParams),
		resolveCodeLens: (params, options) => languageRequest(connection, "language/resolveCodeLens", params, options, languageOperationParams),
		documentLinks: (params, options) => languageRequest(connection, "language/documentLinks", params, options, languageOperationParams),
		resolveDocumentLink: (params, options) => languageRequest(connection, "language/resolveDocumentLink", params, options, languageOperationParams),
		documentColors: (params, options) => languageRequest(connection, "language/documentColors", params, options, languageOperationParams),
		colorPresentations: (params, options) => languageRequest(connection, "language/colorPresentations", params, options, languageOperationParams),
		foldingRanges: (params, options) => languageRequest(connection, "language/foldingRanges", params, options, languageOperationParams),
		locations: (params, options) => languageRequest(connection, "language/locations", params, options, languageOperationParams),
		hierarchy: (params, options) => languageRequest(connection, "language/hierarchy", params, options, languageOperationParams),
		directorySymbols: (params, options) => languageRequest(connection, "language/directorySymbols", params, options, languageOperationParams),
		prepareRename: (params, options) => languageRequest(connection, "language/prepareRename", params, options, languageOperationParams),
		rename: (params, options) => languageRequest(connection, "language/rename", params, options, languageOperationParams),
		codeActions: (params, options) => languageRequest(connection, "language/codeActions", params, options, languageOperationParams),
		resolveCodeAction: (params, options) => languageRequest(connection, "language/resolveCodeAction", params, options, languageOperationParams),
	};
}

function languageRequest<M extends AppServerMethod, P>(
	connection: AppServerProtocolClient,
	method: M,
	request: P,
	options: LanguageRequestOptions | undefined,
	wrap: (operationId: string, request: P) => MethodParams<M>,
): Promise<MethodResult<M>> {
	return runCancellableLanguageRequest(
		options,
		operationId => appServerRequest(connection, method, wrap(operationId, request)),
		operationId => appServerRequest(connection, "language/cancel", { operationId }),
	);
}

function languageOperationParams<P>(operationId: string, request: P): LanguageOperationParams<P> {
	return { operationId, request };
}
