import { VSBuffer } from "../../../../base/common/buffer.js";
import { type CancellationToken } from "../../../../base/common/cancellation.js";
import { Disposable, MutableDisposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range, type IRange } from "../../../../editor/common/core/range.js";
import { type ITextModel } from "../../../../editor/common/model.js";
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import * as languages from '../../../../editor/common/languages.js';
import { type LanguageCompletionItemKindDto, type LanguageHierarchyItemDto, type LanguageCodeActionDto, type LanguageCodeLensDto, type LanguageDirectoryEditDto, type LanguageDocumentLinkDto, type LanguageDocumentSymbolDto } from '../../../../platform/app-server/common/generated/index.js';
import { type ILanguageApi } from "../../../../platform/language/common/languageApi.js";
import { workspaceRelativePath, workspaceResourceFromPath } from "../../../../platform/files/browser/fileService.js";
import { type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { type IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { type IDirPermissionsService } from "../../../../platform/dirPermissions/common/dirPermissionsService.js";
import { APP_SERVER_LANGUAGE_IDS } from "./appServerLanguageSupport.js";
import { resolveAppServerLanguageDirAccess } from "./appServerLanguageWorkspace.js";

type LocationKind = "declaration" | "definition" | "implementation" | "typeDefinition" | "references";
const APP_SERVER_LANGUAGE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

interface LanguageWorkspaceRoot {
	readonly id: string;
	readonly uri: URI;
	readonly wireId?: string;
}

/** Registers App Server-backed cross-resource providers for Code languages. */
export class AppServerLanguageProviders extends Disposable {
	private readonly registrations = this._register(new MutableDisposable<DisposableStore>());
	private refreshQueued = false;
	private refreshGeneration = 0;
	private refreshQueue = Promise.resolve();
	private alive = true;

	constructor(private readonly languageFeatures: ILanguageFeaturesService, private readonly api: ILanguageApi, private readonly workspace: IWorkspaceContextService, private readonly options: AppServerLanguageProvidersOptions = {}) {
		super();
		if (options.dirPermissions && !options.events) throw new Error("Permission-aware App Server language providers require the App Server event stream");
		if (options.events) {
			const subscription = options.events.subscribe(event => {
				if (event.method === "config/changed") this.queueRefresh();
			});
			this._register(toDisposable(() => subscription.dispose()));
		}
		this._register(workspace.onDidChangeWorkspace(() => this.queueRefresh()));
		this._register(toDisposable(() => { this.alive = false; }));
		if (!options.dirPermissions && workspace.getWorkspace().folders.length > 0) this.registrations.value = this.install();
		else this.queueRefresh();
	}

	private install(): DisposableStore {
		const adapter = new AppServerLanguageProvider(this.api, this.workspace);
		const registrations = new DisposableStore();
		registrations.add(this.languageFeatures.hoverProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.completionProvider.register(adapter));
		registrations.add(this.languageFeatures.declarationProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.definitionProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.implementationProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.typeDefinitionProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.referenceProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.callHierarchyProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.typeHierarchyProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.workspaceSymbolProvider.register('*', new AppServerWorkspaceSymbolProvider(this.api, this.workspace)));
		registrations.add(this.languageFeatures.renameProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.codeActionProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.documentFormattingEditProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.documentRangeFormattingEditProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.signatureHelpProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.inlayHintsProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.linkedEditingRangeProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.documentSemanticTokensProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.documentSymbolProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.codeLensProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.linkProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.colorProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		registrations.add(this.languageFeatures.foldingRangeProvider.register(APP_SERVER_LANGUAGE_IDS, adapter));
		return registrations;
	}

	private queueRefresh(): void {
		if (!this.alive) return;
		this.refreshGeneration += 1;
		if (this.refreshQueued) return;
		this.refreshQueued = true;
		queueMicrotask(() => {
			this.refreshQueued = false;
			const generation = this.refreshGeneration;
			this.refreshQueue = this.refreshQueue.catch(() => undefined).then(() => this.refresh(generation)).catch(error => {
				this.registrations.clear();
				console.error("Directory access refresh for App Server language providers failed", error);
			});
		});
	}

	private async refresh(generation: number): Promise<void> {
		const access = await resolveAppServerLanguageDirAccess(this.workspace, this.options.dirPermissions);
		if (!this.alive || generation !== this.refreshGeneration || this.workspace.getWorkspace().id !== access.workspaceId) return;
		if (access.allowed) {
			if (!this.registrations.value) this.registrations.value = this.install();
		} else {
			this.registrations.clear();
		}
	}
}

export interface AppServerLanguageProvidersOptions {
	readonly dirPermissions?: IDirPermissionsService;
	readonly events?: IServerEventApi;
}

class AppServerLanguageProvider implements languages.LanguageCompletionProvider, languages.LanguageHoverProvider, languages.LanguageDeclarationProvider, languages.LanguageDefinitionProvider, languages.LanguageImplementationProvider, languages.LanguageTypeDefinitionProvider, languages.LanguageReferenceProvider, languages.LanguageCallHierarchyProvider, languages.LanguageTypeHierarchyProvider, languages.LanguageRenameProvider, languages.LanguageCodeActionProvider, languages.DocumentFormattingEditProvider, languages.DocumentRangeFormattingEditProvider, languages.LanguageParameterHintsProvider, languages.LanguageInlayHintsProvider, languages.LinkedEditingRangeProvider, languages.LanguageSemanticTokensProvider, languages.LanguageDocumentSymbolProvider, languages.CodeLensProvider, languages.LanguageLinkProvider, languages.LanguageColorProvider, languages.LanguageFoldingRangeProvider {
	readonly languageIds = APP_SERVER_LANGUAGE_IDS;
	readonly id = "ash.appServer.completions";
	readonly triggerCharacters = Object.freeze([".", ":", "<", "\"", "'", "/", "@", "#"]);

	constructor(private readonly api: ILanguageApi, private readonly workspace: IWorkspaceContextService) {}

	async provideHover(request: languages.LanguageHoverRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageSnapshotDocument(root, request);
		if (!document) return undefined;
		const result = await this.api.hover({ document, position: dtoPosition(request.position) }, { signal });
		if (result.revision !== request.snapshot.version || !result.contents) return undefined;
		return Object.freeze({ ...(result.range ? { range: range(result.range) } : {}), contents: Object.freeze([result.contents]) });
	}

	async provideCompletions(request: languages.LanguageCompletionProviderRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageCompletionDocument(root, request);
		if (!document) return undefined;
		const result = await this.api.completions({
			document,
			position: dtoPosition(request.position),
			triggerKind: request.context.kind === languages.LanguageCompletionTriggerKind.Invoke ? "invoke" : request.context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter ? "triggerCharacter" : "incompleteRefresh",
			triggerCharacter: request.context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter ? request.context.triggerCharacter : null,
		}, { signal });
		if (result.revision !== request.snapshot.version) return undefined;
		return Object.freeze({
			isIncomplete: result.isIncomplete,
			items: Object.freeze(result.items.map((item, index) => Object.freeze({
				id: `${request.requestId}:${index}:${item.label}`,
				label: item.label,
				kind: completionKind(item.kind),
				range: range(item.range),
				insertText: item.insertText,
				...(item.insertTextFormat === "snippet" ? { insertTextFormat: languages.LanguageCompletionInsertTextFormat.Snippet } : {}),
				...(item.detail ? { detail: item.detail } : {}),
				...(item.documentation ? { documentation: item.documentation } : {}),
				...(item.filterText ? { filterText: item.filterText } : {}),
				...(item.sortText ? { sortText: item.sortText } : {}),
				...(item.preselect === null ? {} : { preselect: item.preselect }),
				...(item.commitCharacters.length === 0 ? {} : { commitCharacters: Object.freeze(item.commitCharacters) }),
				...(item.additionalTextEdits.length === 0 ? {} : { additionalTextEdits: Object.freeze(item.additionalTextEdits.map(edit => Object.freeze({ range: range(edit.range), text: edit.newText }))) }),
				...(item.command === null ? {} : { command: Object.freeze({ id: item.command.id, title: item.command.title, arguments: Object.freeze(item.command.arguments) }) }),
				...(result.canResolve ? { resolveData: Object.freeze({ document, providerData: item.providerData }) } : {}),
			}))),
		});
	}

	async resolveCompletionItem(request: languages.LanguageCompletionProviderResolveRequest, signal: AbortSignal) {
		const data = appServerCompletionResolveData(request.item.resolveData);
		const result = await this.api.resolveCompletion({ document: data.document, providerData: data.providerData }, { signal });
		return Object.freeze({ ...(result.detail ? { detail: result.detail } : {}), ...(result.documentation ? { documentation: result.documentation } : {}) });
	}

	async executeCompletionCommand(request: languages.LanguageCompletionProviderCommandRequest): Promise<void> {
		const document = languageSnapshotDocument(workspaceRootForResource(this.workspace, request.resource), request);
		if (!document) return;
		await this.api.executeCommand({ document, command: { id: request.command.id, title: request.command.title, arguments: [...request.command.arguments] } });
	}

	provideDeclaration(request: languages.LanguageLocationRequest, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> { return this.request("declaration", request, true, signal); }
	provideDefinition(request: languages.LanguageLocationRequest, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> { return this.request("definition", request, true, signal); }
	provideImplementation(request: languages.LanguageLocationRequest, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> { return this.request("implementation", request, true, signal); }
	provideTypeDefinition(request: languages.LanguageLocationRequest, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> { return this.request("typeDefinition", request, true, signal); }
	provideReferences(request: languages.LanguageReferenceRequest, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> { return this.request("references", request, request.includeDeclaration, signal); }
	prepareCallHierarchy(request: languages.LanguageHierarchyRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> { return this.prepareHierarchy("prepareCall", request, signal); }
	prepareTypeHierarchy(request: languages.LanguageHierarchyRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> { return this.prepareHierarchy("prepareType", request, signal); }
	provideIncomingCalls(request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageCallHierarchyEntry[]> { return this.followCallHierarchy("incomingCalls", request, signal); }
	provideOutgoingCalls(request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageCallHierarchyEntry[]> { return this.followCallHierarchy("outgoingCalls", request, signal); }
	provideSupertypes(request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> { return this.followTypeHierarchy("supertypes", request, signal); }
	provideSubtypes(request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> { return this.followTypeHierarchy("subtypes", request, signal); }
	async prepareRename(request: languages.LanguageRenameRequest, signal: AbortSignal): Promise<{ readonly range: Range; readonly placeholder: string } | undefined> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return undefined;
		const result = await this.api.prepareRename({ document, position: dtoPosition(request.position) }, { signal });
		return result.preparation ? Object.freeze({ range: range(result.preparation.range), placeholder: result.preparation.placeholder }) : undefined;
	}
	async provideRenameEdits(request: languages.LanguageRenameRequest, signal: AbortSignal) {
		if (!request.newName) throw new Error("Rename request requires a new name");
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) throw new Error("Rename is unavailable because this file is too large for App Server language synchronization");
		return workspaceEdit(root, await this.api.rename({ document, position: dtoPosition(request.position), newName: request.newName }, { signal }));
	}
	async provideCodeActions(request: languages.LanguageCodeActionRequest, signal: AbortSignal): Promise<readonly languages.LanguageCodeAction[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.api.codeActions({
			document,
			range: dtoRange(request.range),
			diagnostics: request.diagnostics.map(diagnostic => ({ range: dtoRange(diagnostic.range), severity: diagnosticSeverity(diagnostic.severity), message: diagnostic.message, code: diagnostic.code ?? null, source: diagnostic.source ?? null })),
			only: [...(request.only ?? [])],
		}, { signal });
		return Object.freeze(result.actions.map(action => codeAction(root, action)));
	}
	async resolveCodeAction(action: languages.LanguageCodeAction, request: languages.LanguageCodeActionRequest, signal: AbortSignal): Promise<languages.LanguageCodeAction> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		return document ? codeAction(root, await this.api.resolveCodeAction({ document, providerData: action.data }, { signal })) : action;
	}
	async provideDocumentFormattingEdits(model: ITextModel, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> {
		const document = this.documentForModel(model);
		if (!document) return [];
		const result = await withAbortSignal(token, signal => this.api.formatDocument({ document, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: options.trimTrailingWhitespace ?? null } }, { signal }));
		return !model.isDisposed() && result.revision === document.revision && model.getVersionId() === document.revision ? [...formattingEdits(result.edits)] : [];
	}
	async provideDocumentRangeFormattingEdits(model: ITextModel, range: Range, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> {
		const document = this.documentForModel(model);
		if (!document) return [];
		const result = await withAbortSignal(token, signal => this.api.formatRange({ document, range: dtoRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: options.trimTrailingWhitespace ?? null } }, { signal }));
		return !model.isDisposed() && result.revision === document.revision && model.getVersionId() === document.revision ? [...formattingEdits(result.edits)] : [];
	}
	async provideParameterHints(request: languages.LanguageParameterHintsRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageParameterHintsDocument(root, request);
		if (!document) return undefined;
		const result = await this.api.signatureHelp({
			document,
			position: dtoPosition(request.position),
			triggerKind: request.context.kind,
			triggerCharacter: request.context.kind === "triggerCharacter" ? request.context.triggerCharacter : null,
		}, { signal });
		if (result.revision !== request.snapshot.version || result.signatures.length === 0) return undefined;
		return Object.freeze({
			signatures: Object.freeze(result.signatures.map(signature => Object.freeze({
				label: signature.label,
				...(signature.documentation ? { documentation: signature.documentation } : {}),
				parameters: Object.freeze(signature.parameters.map(parameter => Object.freeze({ label: parameter.label, ...(parameter.documentation ? { documentation: parameter.documentation } : {}) }))),
				...(signature.activeParameter === null ? {} : { activeParameter: signature.activeParameter }),
			}))),
			...(result.activeSignature === null ? {} : { activeSignature: result.activeSignature }),
		});
	}
	async provideInlayHints(request: languages.LanguageInlayHintsRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageInlayHintsDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.api.inlayHints({ document, range: dtoRange(request.range) }, { signal });
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.hints.map(hint => Object.freeze({
			position: new Position((hint.position.lineIndex) + 1, (hint.position.columnIndex) + 1),
			label: hint.label,
			kind: hint.kind,
			...(hint.tooltip ? { tooltip: hint.tooltip } : {}),
			paddingLeft: hint.paddingLeft,
			paddingRight: hint.paddingRight,
		})));
	}
	async provideLinkedEditingRanges(model: ITextModel, position: Position, token: CancellationToken): Promise<languages.LinkedEditingRanges | undefined> {
		const document = this.documentForModel(model);
		if (!document) return undefined;
		const result = await withAbortSignal(token, signal => this.api.linkedEditingRanges({ document, position: dtoPosition(position) }, { signal }));
		if (result.revision !== model.getVersionId() || result.ranges.length < 2) return undefined;
		let wordPattern: RegExp | undefined;
		if (result.wordPattern) {
			try { wordPattern = new RegExp(result.wordPattern, "u"); } catch { wordPattern = undefined; }
		}
		return Object.freeze({ ranges: result.ranges.map(value => range(value)), ...(wordPattern ? { wordPattern } : {}) });
	}

	async provideSemanticTokens(request: languages.LanguageSemanticTokensRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageSemanticTokensDocument(root, request);
		if (!document) return undefined;
		signal.throwIfAborted();
		const result = await this.api.semanticTokens({ document }, { signal });
		signal.throwIfAborted();
		if (result.revision !== request.snapshot.version) return undefined;
		return Object.freeze({ tokens: Object.freeze(result.tokens.map(token => Object.freeze({ range: range(token.range), tokenType: token.tokenType, modifiers: Object.freeze([...token.modifiers]) }))) });
	}

	async provideDocumentSymbols(request: languages.LanguageDocumentSymbolRequest, signal: AbortSignal): Promise<readonly languages.LanguageDocumentSymbol[]> {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.api.documentSymbols({ document }, { signal });
		signal.throwIfAborted();
		return result.revision === request.snapshot.version ? Object.freeze(result.symbols.map(documentSymbol)) : Object.freeze([]);
	}

	async provideCodeLenses(model: ITextModel, token: CancellationToken): Promise<languages.CodeLensList> {
		const document = this.documentForModel(model);
		if (!document) return Object.freeze({ lenses: Object.freeze([]) });
		const result = await withAbortSignal(token, signal => this.api.codeLenses({ document }, { signal }));
		return Object.freeze({
			lenses: result.revision === model.getVersionId() ? Object.freeze(result.lenses.map(codeLens)) : Object.freeze([]),
		});
	}

	async resolveCodeLens(model: ITextModel, lens: languages.CodeLens, token: CancellationToken): Promise<languages.CodeLens> {
		const document = this.documentForModel(model);
		if (!document) return lens;
		const result = await withAbortSignal(token, signal => this.api.resolveCodeLens({ document, lens: codeLensDto(lens) }, { signal }));
		return result.revision === model.getVersionId() && result.lenses[0] ? codeLens(result.lenses[0]) : lens;
	}

	async provideLinks(request: languages.LanguageLinkRequest, signal: AbortSignal): Promise<readonly languages.LanguageLink[]> {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.api.documentLinks({ document }, { signal });
		signal.throwIfAborted();
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		const resolved = await Promise.all(result.links.map(async link => link.target ? link : this.resolveDocumentLink(document, link, signal)));
		signal.throwIfAborted();
		return Object.freeze(resolved.flatMap(link => link.target ? [Object.freeze({ range: range(link.range), target: link.target, ...(link.tooltip ? { tooltip: link.tooltip } : {}) })] : []));
	}

	async provideDocumentColors(request: languages.LanguageColorRequest, signal: AbortSignal) {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.api.documentColors({ document }, { signal });
		signal.throwIfAborted();
		return result.revision === request.snapshot.version ? Object.freeze(result.colors.map(item => Object.freeze({ range: range(item.range), color: Object.freeze({ red: item.color.red / 255, green: item.color.green / 255, blue: item.color.blue / 255, alpha: item.color.alpha / 255 }) }))) : Object.freeze([]);
	}

	async provideColorPresentations(request: languages.LanguageColorPresentationRequest, signal: AbortSignal) {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.api.colorPresentations({ document, range: dtoRange(request.range), color: { red: Math.round(request.color.red * 255), green: Math.round(request.color.green * 255), blue: Math.round(request.color.blue * 255), alpha: Math.round(request.color.alpha * 255) } }, { signal });
		signal.throwIfAborted();
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.presentations.map(item => ({ label: item.label, ...(item.textEdit ? { textEdit: { range: range(item.textEdit.range), text: item.textEdit.newText } } : {}), ...(item.additionalTextEdits.length > 0 ? { additionalTextEdits: item.additionalTextEdits.map(edit => ({ range: range(edit.range), text: edit.newText })) } : {}) })));
	}

	async provideFoldingRanges(request: languages.LanguageFoldingRangeRequest, signal: AbortSignal) {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.api.foldingRanges({ document }, { signal });
		signal.throwIfAborted();
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.ranges.map(item => Object.freeze({ startLineIndex: item.startLineIndex, endLineIndex: item.endLineIndex, ...(item.kind ? { kind: item.kind } : {}), ...(item.collapsedText ? { collapsedText: item.collapsedText } : {}) })));
	}

	private documentForRequest(request: { readonly resource?: URI; readonly languageId: string; readonly snapshot: { readonly version: number; getText(): string }; readonly model: { readonly largeFile: { readonly tooLargeForSynchronization: boolean } } }) {
		if (request.model.largeFile.tooLargeForSynchronization) return undefined;
		return languageSnapshotDocument(workspaceRootForResource(this.workspace, request.resource), request);
	}

	private documentForModel(model: ITextModel) {
		if (model.isTooLargeForSyncing()) return undefined;
		return languageSnapshotDocument(workspaceRootForResource(this.workspace, model.uri), {
			resource: model.uri,
			languageId: model.getLanguageId(),
			snapshot: { version: model.getVersionId(), getText: () => model.getValue() },
		});
	}

	private async resolveDocumentLink(document: NonNullable<ReturnType<AppServerLanguageProvider["documentForRequest"]>>, link: LanguageDocumentLinkDto, signal: AbortSignal): Promise<LanguageDocumentLinkDto> {
		signal.throwIfAborted();
		const result = await this.api.resolveDocumentLink({ document, link }, { signal });
		signal.throwIfAborted();
		return result.revision === document.revision && result.links[0] ? result.links[0] : link;
	}

	private async request(kind: LocationKind, request: languages.LanguageLocationRequest, includeDeclaration: boolean, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.api.locations({
			document,
			position: dtoPosition(request.position),
			kind,
			includeDeclaration,
		}, { signal });
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.locations.map(location => {
			const resource = workspaceResource(root, location.path);
			return Object.freeze({
				resource,
				range: range(location.range),
				selectionRange: range(location.selectionRange),
			});
		}));
	}

	private async prepareHierarchy(kind: "prepareCall" | "prepareType", request: languages.LanguageHierarchyRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.api.hierarchy({ document, kind, position: dtoPosition(request.position), item: null }, { signal });
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.entries.map(entry => hierarchyItem(root, entry.item)));
	}

	private async followCallHierarchy(kind: "incomingCalls" | "outgoingCalls", request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageCallHierarchyEntry[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.api.hierarchy({ document, kind, position: null, item: hierarchyItemDto(root, request.item) }, { signal });
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.entries.map(entry => Object.freeze({ item: hierarchyItem(root, entry.item), ...(entry.fromPath ? { fromResource: workspaceResource(root, entry.fromPath) } : {}), fromRanges: Object.freeze(entry.fromRanges.map(range)) })));
	}

	private async followTypeHierarchy(kind: "supertypes" | "subtypes", request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.api.hierarchy({ document, kind, position: null, item: hierarchyItemDto(root, request.item) }, { signal });
		if (result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.entries.map(entry => hierarchyItem(root, entry.item)));
	}
}

class AppServerWorkspaceSymbolProvider implements languages.LanguageWorkspaceSymbolProvider {
	constructor(private readonly api: ILanguageApi, private readonly workspace: IWorkspaceContextService) {}

	async provideWorkspaceSymbols(query: string, signal: AbortSignal): Promise<readonly languages.LanguageWorkspaceSymbol[]> {
		const folders = this.workspace.getWorkspace().folders;
		const roots = folders.map(folder => ({ id: folder.id, uri: folder.uri, ...(folders.length > 1 ? { wireId: folder.id } : {}) }));
		const responses = await Promise.all(roots.flatMap(root => APP_SERVER_LANGUAGE_IDS.map(async languageId => {
			if (signal.aborted) return [];
			try { return (await this.api.directorySymbols({ ...(root.wireId ? { dirId: root.wireId } : {}), languageId, query }, { signal })).symbols.map(symbol => ({ root, symbol })); } catch { return []; }
		})));
		if (signal.aborted) return Object.freeze([]);
		const seen = new Set<string>();
		return Object.freeze(responses.flat().flatMap(({ root, symbol }) => {
			const resource = workspaceResource(root, symbol.path);
			const symbolRange = range(symbol.range);
			const key = `${resource.toString()}\0${symbol.name}\0${symbolRange.getStartPosition().lineNumber}:${symbolRange.getStartPosition().column}`;
			if (seen.has(key)) return [];
			seen.add(key);
			return [Object.freeze({ name: symbol.name, kind: symbol.symbolKind, resource, range: symbolRange, ...(symbol.containerName ? { containerName: symbol.containerName } : {}) })];
		}));
	}
}

function languageDocument(root: LanguageWorkspaceRoot, request: languages.LanguageLocationRequest | languages.LanguageHierarchyRequest | languages.LanguageHierarchyFollowupRequest | languages.LanguageRenameRequest | languages.LanguageCodeActionRequest) {
	if (request.model.largeFile.tooLargeForSynchronization) return undefined;
	const text = request.snapshot.getText();
	if (VSBuffer.fromString(text).byteLength > APP_SERVER_LANGUAGE_DOCUMENT_MAX_BYTES) return undefined;
	return { ...(root.wireId ? { dirId: root.wireId } : {}), path: workspaceRelativePath(root.uri, request.resource), languageId: request.languageId, revision: request.snapshot.version, text };
}

function languageCompletionDocument(root: LanguageWorkspaceRoot, request: languages.LanguageCompletionProviderRequest) {
	if (!request.resource) return undefined;
	return languageSnapshotDocument(root, { resource: request.resource, languageId: request.languageId, snapshot: request.snapshot });
}

function languageSnapshotDocument(root: LanguageWorkspaceRoot, request: { readonly resource?: URI; readonly languageId: string; readonly snapshot: { readonly version: number; getText(): string } }) {
	if (!request.resource) return undefined;
	const text = request.snapshot.getText();
	if (VSBuffer.fromString(text).byteLength > APP_SERVER_LANGUAGE_DOCUMENT_MAX_BYTES) return undefined;
	return { ...(root.wireId ? { dirId: root.wireId } : {}), path: workspaceRelativePath(root.uri, request.resource), languageId: request.languageId, revision: request.snapshot.version, text };
}

function languageParameterHintsDocument(root: LanguageWorkspaceRoot, request: languages.LanguageParameterHintsRequest) {
	if (!request.resource || request.model.largeFile.tooLargeForSynchronization) return undefined;
	return languageSnapshotDocument(root, request);
}

function languageInlayHintsDocument(root: LanguageWorkspaceRoot, request: languages.LanguageInlayHintsRequest) {
	if (!request.resource || request.model.largeFile.tooLargeForSynchronization) return undefined;
	return languageSnapshotDocument(root, request);
}

function appServerCompletionResolveData(value: unknown): { readonly document: NonNullable<ReturnType<typeof languageCompletionDocument>>; readonly providerData: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("App Server completion resolve data must be an object");
	const data = value as { readonly document?: unknown; readonly providerData?: unknown };
	if (typeof data.document !== "object" || data.document === null) throw new TypeError("App Server completion resolve data must include its document snapshot");
	return data as { readonly document: NonNullable<ReturnType<typeof languageCompletionDocument>>; readonly providerData: unknown };
}

function languageSemanticTokensDocument(root: LanguageWorkspaceRoot, request: languages.LanguageSemanticTokensRequest) {
	if (!request.resource || request.model.largeFile.tooLargeForTokenization || request.model.largeFile.tooLargeForSynchronization) return undefined;
	return languageSnapshotDocument(root, request);
}

function formattingEdits(edits: readonly { readonly range: { readonly start: { readonly lineIndex: number; readonly columnIndex: number }; readonly end: { readonly lineIndex: number; readonly columnIndex: number } }; readonly newText: string }[]) {
	return Object.freeze(edits.map(edit => Object.freeze({ range: range(edit.range), text: edit.newText })));
}

function completionKind(kind: LanguageCompletionItemKindDto): languages.LanguageCompletionItemKind {
	switch (kind) {
		case "method": return languages.LanguageCompletionItemKind.Method;
		case "function": return languages.LanguageCompletionItemKind.Function;
		case "constructor": return languages.LanguageCompletionItemKind.Constructor;
		case "field": return languages.LanguageCompletionItemKind.Field;
		case "variable": return languages.LanguageCompletionItemKind.Variable;
		case "class": return languages.LanguageCompletionItemKind.Class;
		case "interface": return languages.LanguageCompletionItemKind.Interface;
		case "module": return languages.LanguageCompletionItemKind.Module;
		case "property": return languages.LanguageCompletionItemKind.Property;
		case "unit": return languages.LanguageCompletionItemKind.Unit;
		case "value": return languages.LanguageCompletionItemKind.Value;
		case "enum": return languages.LanguageCompletionItemKind.Enum;
		case "keyword": return languages.LanguageCompletionItemKind.Keyword;
		case "snippet": return languages.LanguageCompletionItemKind.Snippet;
		case "file": return languages.LanguageCompletionItemKind.File;
		case "folder": return languages.LanguageCompletionItemKind.Folder;
		case "reference": return languages.LanguageCompletionItemKind.Reference;
		case "typeParameter": return languages.LanguageCompletionItemKind.TypeParameter;
		case "text": return languages.LanguageCompletionItemKind.Text;
	}
}

function dtoPosition(position: Position): { readonly lineIndex: number; readonly columnIndex: number } { return { lineIndex: position.lineNumber - 1, columnIndex: position.column - 1 }; }

function hierarchyItem(root: LanguageWorkspaceRoot, item: LanguageHierarchyItemDto): languages.LanguageHierarchyItem {
	return Object.freeze({ name: item.name, symbolKind: item.symbolKind, ...(item.detail ? { detail: item.detail } : {}), resource: workspaceResource(root, item.path), range: range(item.range), selectionRange: range(item.selectionRange), ...(item.data === undefined ? {} : { data: item.data }) });
}

function hierarchyItemDto(root: LanguageWorkspaceRoot, item: languages.LanguageHierarchyItem): LanguageHierarchyItemDto {
	return { name: item.name, symbolKind: item.symbolKind, detail: item.detail ?? null, path: workspaceRelativePath(root.uri, item.resource), range: dtoRange(item.range), selectionRange: dtoRange(item.selectionRange), data: item.data };
}

function dtoRange(value: IRange) {
	const range = Range.lift(value);
	return { start: dtoPosition(range.getStartPosition()), end: dtoPosition(range.getEndPosition()) };
}

function workspaceEdit(root: LanguageWorkspaceRoot, edit: LanguageDirectoryEditDto) {
	return Object.freeze({ entries: Object.freeze(edit.entries.map(entry => {
		switch (entry.kind) {
			case "textDocument": return Object.freeze({ kind: entry.kind, resource: workspaceResource(root, entry.document.path), expectedText: entry.document.expectedText, edits: Object.freeze(entry.document.edits.map(edit => Object.freeze({ range: range(edit.range), text: edit.newText }))) });
			case "create": return Object.freeze({ kind: entry.kind, resource: workspaceResource(root, entry.path), existing: entry.existing });
			case "rename": return Object.freeze({ kind: entry.kind, source: workspaceResource(root, entry.source), target: workspaceResource(root, entry.target), existing: entry.existing });
			case "delete": return Object.freeze({ kind: entry.kind, resource: workspaceResource(root, entry.path), missing: entry.missing, mode: entry.mode });
		}
	})) });
}

function codeAction(root: LanguageWorkspaceRoot, action: LanguageCodeActionDto): languages.LanguageCodeAction {
	return Object.freeze({ title: action.title, ...(action.kind ? { kind: action.kind } : {}), isPreferred: action.isPreferred, ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}), ...(action.edit ? { edit: workspaceEdit(root, action.edit) } : {}), data: action.providerData });
}

function documentSymbol(value: LanguageDocumentSymbolDto): languages.LanguageDocumentSymbol {
	return Object.freeze({ name: value.name, ...(value.detail ? { detail: value.detail } : {}), kind: value.symbolKind, range: range(value.range), selectionRange: range(value.selectionRange), ...(value.children.length > 0 ? { children: Object.freeze(value.children.map(documentSymbol)) } : {}) });
}

type AppServerCodeLens = languages.CodeLens & { readonly providerData?: unknown };

function codeLens(value: LanguageCodeLensDto): languages.CodeLens {
	return Object.freeze({ range: range(value.range), ...(value.command ? { command: Object.freeze({ id: value.command.id, title: value.command.title, arguments: [...value.command.arguments] }) } : {}), ...(value.providerData === undefined ? {} : { providerData: value.providerData }) });
}

function codeLensDto(value: languages.CodeLens): LanguageCodeLensDto {
	return { range: dtoRange(value.range), command: value.command ? { id: value.command.id, title: value.command.title, arguments: [...(value.command.arguments ?? [])] } : null, providerData: (value as AppServerCodeLens).providerData };
}

async function withAbortSignal<T>(token: CancellationToken, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	if (token.isCancellationRequested) controller.abort();
	const listener = token.onCancellationRequested(() => controller.abort());
	try {
		return await run(controller.signal);
	} finally {
		listener.dispose();
	}
}

function diagnosticSeverity(severity: languages.LanguageDiagnosticSeverity): "error" | "warning" | "information" | "hint" {
	return severity;
}

function workspaceRootForResource(workspace: IWorkspaceContextService, resource: URI | undefined): LanguageWorkspaceRoot {
	const folders = workspace.getWorkspace().folders;
	if (!resource && folders.length === 1) return { id: folders[0]!.id, uri: folders[0]!.uri };
	let match: LanguageWorkspaceRoot | undefined;
	for (const folder of folders) {
		if (!resource) continue;
		try {
			workspaceRelativePath(folder.uri, resource);
			if (!match || folder.uri.path.length > match.uri.path.length) match = { id: folder.id, uri: folder.uri, ...(folders.length > 1 ? { wireId: folder.id } : {}) };
		} catch {
			// Resource belongs to a different Workspace folder.
		}
	}
	if (!match) throw new Error("Language service resource is outside the current workspace");
	return match;
}

function workspaceResource(root: LanguageWorkspaceRoot, relativePath: string): URI {
	const resource = workspaceResourceFromPath(root.uri, relativePath);
	if (!resource) throw new Error("Language service returned an invalid workspace path");
	return resource;
}

function range(value: { readonly start: { readonly lineIndex: number; readonly columnIndex: number }; readonly end: { readonly lineIndex: number; readonly columnIndex: number } }): Range {
	return Range.fromPositions(new Position((value.start.lineIndex) + 1, (value.start.columnIndex) + 1), new Position((value.end.lineIndex) + 1, (value.end.columnIndex) + 1));
}
