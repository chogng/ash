import { VSBuffer } from "../../../../base/common/buffer.js";
import { type CancellationToken } from "../../../../base/common/cancellation.js";
import { Disposable, MutableDisposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range, type IRange } from "../../../../editor/common/core/range.js";
import { type ITextModel } from "../../../../editor/common/model.js";
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { type LanguageFeatureRegistry } from '../../../../editor/common/languageFeatureRegistry.js';
import * as languages from '../../../../editor/common/languages.js';
import { type LanguageServerFeatureDto, type LanguageCompletionItemKindDto, type LanguageHierarchyItemDto, type LanguageCodeActionDto, type LanguageCodeLensDto, type LanguageDirectoryEditDto, type LanguageDocumentLinkDto, type LanguageDocumentSymbolDto } from '../../../../../../.build/protocol/typescript/index.js';
import { type ILanguageApi } from "../../../../platform/language/common/languageApi.js";
import { workspaceResourceFromPath } from "../../../../platform/workspace/common/workspace.js";
import { workspaceRelativePath, IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IServerEventApi } from "../../../../platform/agentHost/common/appServerApi.js";
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { AppServerLanguageSupport } from "./appServerLanguageSupport.js";
import { resolveAppServerLanguageDirAccess } from "./appServerLanguageWorkspace.js";

type LocationKind = "declaration" | "definition" | "implementation" | "typeDefinition" | "references";
const APP_SERVER_LANGUAGE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

interface LanguageWorkspaceRoot {
	readonly id: string;
	readonly uri: URI;
	readonly wireId?: string;
}

interface ServerCapabilities {
	readonly server: string;
	readonly features: ReadonlySet<LanguageServerFeatureDto>;
	readonly lifetime: AbortController;
	readonly generation: number;
	readonly completion: readonly string[];
	readonly onType: readonly string[];
	readonly signature: readonly string[];
	readonly retrigger: readonly string[];
}

/** Registers App Server-backed cross-resource providers for Code languages. */
export class AppServerLanguageProviders extends Disposable {
	private readonly registrations = this._register(new MutableDisposable<DisposableStore>());
	private refreshQueued = false;
	private refreshGeneration = 0;
	private refreshQueue = Promise.resolve();
	private alive = true;
	private started = false;
	private nextCapabilityGeneration = 1;
	private readonly capabilities = new Map<string, ServerCapabilities>();

	constructor(
		private readonly api: ILanguageApi,
		private readonly options: AppServerLanguageProvidersOptions,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrust: IWorkspaceTrustManagementService,
		@IServerEventApi events: IServerEventApi,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === 'language/serverCapabilities') {
				const folderId = event.params.dirId ?? this.workspace.getWorkspace().folders[0]?.id;
				if (folderId) for (const languageId of event.params.languageIds) {
					const key = `${folderId}:${languageId}`;
					const previous = this.capabilities.get(key);
					const next = { server: event.params.server, features: new Set(event.params.features), lifetime: new AbortController(), generation: this.nextCapabilityGeneration++, completion: event.params.completionTriggerCharacters, onType: event.params.onTypeFormattingTriggerCharacters, signature: event.params.signatureHelpTriggerCharacters, retrigger: event.params.signatureHelpRetriggerCharacters };
					if (previous && sameCapabilities(previous, next)) continue;
					previous?.lifetime.abort();
					this.capabilities.set(key, next);
				}
				this.queueRefresh();
			}
			if (event.method === 'language/serverState' && event.params.state.type !== 'ready') {
				const folderId = event.params.dirId ?? this.workspace.getWorkspace().folders[0]?.id;
				let removed = false;
				for (const [key, value] of this.capabilities) {
					if (key.startsWith(`${folderId}:`) && value.server === event.params.server) { value.lifetime.abort(); this.capabilities.delete(key); removed = true; }
				}
				if (removed) this.queueRefresh();
			}
			// State transitions retire metadata only for sessions that actually stopped. A profile
			// update may concern another feature and leave these negotiated capabilities intact.
			if (event.method === 'extensions/changed') this.clearCapabilities();
			if (event.method === "extensions/changed" || event.method === "config/changed") this.queueRefresh();
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('rust-analyzer')) this.queueRefresh();
		}));
		if (options.checkWorkspaceTrust) this._register(workspaceTrust.onDidChangeTrust(() => this.queueRefresh()));
		this._register(workspace.onDidChangeWorkspace(() => { this.clearCapabilities(); this.queueRefresh(); }));
		this._register(toDisposable(() => { this.alive = false; this.clearCapabilities(); }));
	}

	/** The window starts executable providers only after its configuration layers are loaded. */
	start(): void {
		if (this.started || !this.alive) return;
		this.started = true;
		this.queueRefresh();
	}

	private clearCapabilities(): void {
		for (const capabilities of this.capabilities.values()) capabilities.lifetime.abort();
		this.capabilities.clear();
	}

	private install(support: AppServerLanguageSupport): DisposableStore {
		const folders = this.workspace.getWorkspace().folders;
		const languageIds = support.languageIds;
		const completionLanguages = languageIds.filter(language => folders.some(folder => support.supports(folder.id, language) && this.capabilities.get(`${folder.id}:${language}`)?.features.has('completion')));
		const adapter = new AppServerLanguageProvider(this.api, this.workspace, completionLanguages, this.capabilities);
		const registrations = new DisposableStore();
		// Negotiated features control availability; exact resource guards also protect
		// retained adapters and completion's language-only provider catalog.
		const register = <T>(feature: LanguageServerFeatureDto, registry: LanguageFeatureRegistry<T>, provider: T) => {
			const selector = folders.flatMap(folder => languageIds
				.filter(language => support.supports(folder.id, language) && this.capabilities.get(`${folder.id}:${language}`)?.features.has(feature))
				.map(language => ({ language, scheme: folder.uri.scheme, pattern: { base: folder.uri.fsPath, pattern: '**' } })));
			if (selector.length) registrations.add(registry.register(selector, provider));
		};
		register('hover', this.languageFeatures.hoverProvider, adapter);
		register('declaration', this.languageFeatures.declarationProvider, adapter);
		register('definition', this.languageFeatures.definitionProvider, adapter);
		register('implementation', this.languageFeatures.implementationProvider, adapter);
		register('typeDefinition', this.languageFeatures.typeDefinitionProvider, adapter);
		register('references', this.languageFeatures.referenceProvider, adapter);
		register('callHierarchy', this.languageFeatures.callHierarchyProvider, adapter);
		register('typeHierarchy', this.languageFeatures.typeHierarchyProvider, adapter);
		register('rename', this.languageFeatures.renameProvider, adapter);
		register('codeActions', this.languageFeatures.codeActionProvider, adapter);
		register('documentFormatting', this.languageFeatures.documentFormattingEditProvider, adapter);
		register('rangeFormatting', this.languageFeatures.documentRangeFormattingEditProvider, adapter);
		for (const folder of folders) {
			for (const language of languageIds) {
				const capabilities = this.capabilities.get(`${folder.id}:${language}`);
				if (!support.supports(folder.id, language) || !capabilities?.features.has('onTypeFormatting') || !capabilities.onType.length) continue;
				registrations.add(this.languageFeatures.onTypeFormattingEditProvider.register({ language, scheme: folder.uri.scheme, pattern: { base: folder.uri.fsPath, pattern: '**' } }, {
					autoFormatTriggerCharacters: [...capabilities.onType],
					provideOnTypeFormattingEdits: (model, position, character, options, token) => adapter.provideOnTypeFormattingEdits(model, position, character, options, token),
				}));
			}
		}
		register('signatureHelp', this.languageFeatures.signatureHelpProvider, adapter);
		register('inlayHints', this.languageFeatures.inlayHintsProvider, adapter);
		register('linkedEditingRanges', this.languageFeatures.linkedEditingRangeProvider, adapter);
		register('semanticTokens', this.languageFeatures.documentSemanticTokensProvider, adapter);
		register('documentSymbols', this.languageFeatures.documentSymbolProvider, adapter);
		register('codeLens', this.languageFeatures.codeLensProvider, adapter);
		register('documentLinks', this.languageFeatures.linkProvider, adapter);
		register('documentColors', this.languageFeatures.colorProvider, adapter);
		register('foldingRanges', this.languageFeatures.foldingRangeProvider, adapter);
		if (completionLanguages.length) registrations.add(this.languageFeatures.completionProvider.register(adapter));
		if ([...this.capabilities.values()].some(value => value.features.has('workspaceSymbols'))) {
			registrations.add(this.languageFeatures.workspaceSymbolProvider.register('*', new AppServerWorkspaceSymbolProvider(this.api, this.workspace, support, this.capabilities)));
		}
		return registrations;
	}

	private queueRefresh(): void {
		if (!this.alive || !this.started) return;
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
		const access = await resolveAppServerLanguageDirAccess(this.workspace, this.workspaceTrust, this.options.checkWorkspaceTrust);
		if (!this.alive || generation !== this.refreshGeneration || this.workspace.getWorkspace().id !== access.workspaceId) return;
		if (access.allowed) {
			const support = await AppServerLanguageSupport.read(this.api, this.workspace, this.configuration);
			if (!this.alive || generation !== this.refreshGeneration) return;
			this.registrations.clear();
			if (support.languageIds.length > 0) this.registrations.value = this.install(support);
		} else {
			this.registrations.clear();
		}
	}
}

export interface AppServerLanguageProvidersOptions {
	/** Desktop inspects exact grants; Web retains backend authorization for its authenticated workspace. */
	readonly checkWorkspaceTrust: boolean;
}

class AppServerLanguageProvider implements languages.LanguageCompletionProvider, languages.LanguageHoverProvider, languages.LanguageDeclarationProvider, languages.LanguageDefinitionProvider, languages.LanguageImplementationProvider, languages.LanguageTypeDefinitionProvider, languages.LanguageReferenceProvider, languages.LanguageCallHierarchyProvider, languages.LanguageTypeHierarchyProvider, languages.LanguageRenameProvider, languages.LanguageCodeActionProvider, languages.DocumentFormattingEditProvider, languages.DocumentRangeFormattingEditProvider, languages.LanguageParameterHintsProvider, languages.LanguageInlayHintsProvider, languages.LinkedEditingRangeProvider, languages.LanguageSemanticTokensProvider, languages.LanguageDocumentSymbolProvider, languages.CodeLensProvider, languages.LanguageLinkProvider, languages.LanguageColorProvider, languages.LanguageFoldingRangeProvider {
	readonly signatureHelpTriggerCharacters: readonly string[];
	readonly signatureHelpRetriggerCharacters: readonly string[];
	readonly id = "ash.appServer.completions";
	readonly triggerCharacters: readonly string[];

	constructor(private readonly api: ILanguageApi, private readonly workspace: IWorkspaceContextService, readonly languageIds: readonly string[], private readonly capabilities: ReadonlyMap<string, ServerCapabilities>) {
		const all = [...this.capabilities.values()];
		this.triggerCharacters = Object.freeze([...new Set(all.flatMap(value => value.completion))]);
		this.signatureHelpTriggerCharacters = Object.freeze([...new Set(all.flatMap(value => value.signature))]);
		this.signatureHelpRetriggerCharacters = Object.freeze([...new Set(all.flatMap(value => value.retrigger))]);
	}

	async provideHover(request: languages.LanguageHoverRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageSnapshotDocument(root, request);
		if (!document) return undefined;
		const result = await this.requestFeature('hover', document, signal, signal => this.api.hover({ document, position: dtoPosition(request.position) }, { signal }));
		if (!result || result.revision !== request.snapshot.version || !result.contents) return undefined;
		return Object.freeze({ ...(result.range ? { range: range(result.range) } : {}), contents: Object.freeze([result.contents]) });
	}

	async provideCompletions(request: languages.LanguageCompletionProviderRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		if (request.context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter && !this.capabilities.get(`${root.id}:${request.languageId}`)?.completion.includes(request.context.triggerCharacter)) return undefined;
		const document = languageCompletionDocument(root, request);
		if (!document) return undefined;
		const result = await this.requestFeature('completion', document, signal, signal => this.api.completions({
			document,
			position: dtoPosition(request.position),
			triggerKind: request.context.kind === languages.LanguageCompletionTriggerKind.Invoke ? "invoke" : request.context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter ? "triggerCharacter" : "incompleteRefresh",
			triggerCharacter: request.context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter ? request.context.triggerCharacter : null,
		}, { signal }));
		if (!result || result.revision !== request.snapshot.version) return undefined;
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
				...(result.canResolve ? { resolveData: Object.freeze({ document, providerData: item.providerData, generation: this.capabilities.get(`${root.id}:${request.languageId}`)?.generation }) } : {}),
			}))),
		});
	}

	async resolveCompletionItem(request: languages.LanguageCompletionProviderResolveRequest, signal: AbortSignal) {
		const data = appServerCompletionResolveData(request.item.resolveData);
		if (data.generation !== this.capabilities.get(`${data.document.dirId ?? this.workspace.getWorkspace().folders[0]?.id}:${data.document.languageId}`)?.generation) return undefined;
		const result = await this.requestFeature('completionResolve', data.document, signal, signal => this.api.resolveCompletion({ document: data.document, providerData: data.providerData }, { signal }));
		return Object.freeze({ ...(result?.detail ? { detail: result.detail } : {}), ...(result?.documentation ? { documentation: result.documentation } : {}) });
	}

	async executeCompletionCommand(request: languages.LanguageCompletionProviderCommandRequest): Promise<void> {
		const document = languageSnapshotDocument(workspaceRootForResource(this.workspace, request.resource), request);
		if (!document) return;
		await this.requestFeature('executeCommand', document, undefined, () => this.api.executeCommand({ document, command: { id: request.command.id, title: request.command.title, arguments: [...request.command.arguments] } }));
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
	async prepareRename(request: languages.LanguageRenameRequest, signal: AbortSignal): Promise<{ readonly range: Range; readonly placeholder: string; } | undefined> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return undefined;
		if (!this.capabilities.get(`${root.id}:${request.languageId}`)?.features.has('rename')) return undefined;
		if (!this.capabilities.get(`${root.id}:${request.languageId}`)?.features.has('renamePrepare')) {
			const word = request.model.getWordAtPosition(request.position);
			return word ? { range: new Range(request.position.lineNumber, word.startColumn, request.position.lineNumber, word.endColumn), placeholder: word.word } : undefined;
		}
		const result = await this.requestFeature('renamePrepare', document, signal, signal => this.api.prepareRename({ document, position: dtoPosition(request.position) }, { signal }));
		return result?.preparation ? Object.freeze({ range: range(result.preparation.range), placeholder: result.preparation.placeholder }) : undefined;
	}
	async provideRenameEdits(request: languages.LanguageRenameRequest, signal: AbortSignal) {
		if (!request.newName) throw new Error("Rename request requires a new name");
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) throw new Error("Rename is unavailable because this file is too large for App Server language synchronization");
		const result = await this.requestFeature('rename', document, signal, signal => this.api.rename({ document, position: dtoPosition(request.position), newName: request.newName! }, { signal }));
		return result ? workspaceEdit(root, result) : Object.freeze({ entries: Object.freeze([]) });
	}
	async provideCodeActions(request: languages.LanguageCodeActionRequest, signal: AbortSignal): Promise<readonly languages.LanguageCodeAction[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const key = `${root.id}:${request.languageId}`;
		const capabilities = this.capabilities.get(key);
		if (!capabilities?.features.has('codeActions')) return Object.freeze([]);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.requestFeature('codeActions', document, signal, signal => this.api.codeActions({
			document,
			range: dtoRange(request.range),
			diagnostics: request.diagnostics.map(diagnostic => ({ range: dtoRange(diagnostic.range), severity: diagnosticSeverity(diagnostic.severity), message: diagnostic.message, code: diagnostic.code ?? null, source: diagnostic.source ?? null })),
			only: [...(request.only ?? [])],
		}, { signal }));
		if (!result || signal.aborted || this.capabilities.get(key) !== capabilities) return Object.freeze([]);
		return Object.freeze(result.actions.map(action => codeAction(root, action)));
	}
	async resolveCodeAction(action: languages.LanguageCodeAction, request: languages.LanguageCodeActionRequest, signal: AbortSignal): Promise<languages.LanguageCodeAction> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const capabilities = this.capabilities.get(`${root.id}:${request.languageId}`);
		if (!capabilities?.features.has('codeActions') || !capabilities.features.has('codeActionResolve')) return action;
		const document = languageDocument(root, request);
		if (!document) return action;
		const result = await this.requestFeature('codeActionResolve', document, signal, signal => this.api.resolveCodeAction({ document, providerData: action.data }, { signal }));
		return result && !signal.aborted && this.capabilities.get(`${root.id}:${request.languageId}`) === capabilities ? codeAction(root, result) : action;
	}
	async provideDocumentFormattingEdits(model: ITextModel, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> {
		const document = this.documentForModel(model);
		if (!document) return [];
		const result = await withAbortSignal(token, signal => this.requestFeature('documentFormatting', document, signal, signal => this.api.formatDocument({ document, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: options.trimTrailingWhitespace ?? null } }, { signal })));
		return !model.isDisposed() && result?.revision === document.revision && model.getVersionId() === document.revision ? [...formattingEdits(result.edits)] : [];
	}
	async provideDocumentRangeFormattingEdits(model: ITextModel, range: Range, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> {
		const document = this.documentForModel(model);
		if (!document) return [];
		const result = await withAbortSignal(token, signal => this.requestFeature('rangeFormatting', document, signal, signal => this.api.formatRange({ document, range: dtoRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: options.trimTrailingWhitespace ?? null } }, { signal })));
		return !model.isDisposed() && result?.revision === document.revision && model.getVersionId() === document.revision ? [...formattingEdits(result.edits)] : [];
	}
	async provideOnTypeFormattingEdits(model: ITextModel, position: Position, character: string, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> {
		const document = this.documentForModel(model);
		if (!document || !this.capabilities.get(`${document.dirId ?? this.workspace.getWorkspace().folders[0]?.id}:${document.languageId}`)?.onType.includes(character)) return [];
		const result = await withAbortSignal(token, signal => this.requestFeature('onTypeFormatting', document, signal, signal => this.api.formatOnType({ document, position: dtoPosition(position), character, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: options.trimTrailingWhitespace ?? null } }, { signal })));
		return !model.isDisposed() && result?.revision === document.revision && model.getVersionId() === document.revision ? [...formattingEdits(result.edits)] : [];
	}
	async provideParameterHints(request: languages.LanguageParameterHintsRequest, signal: AbortSignal) {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const triggers = this.capabilities.get(`${root.id}:${request.languageId}`);
		if (request.context.kind === 'triggerCharacter' && !triggers?.signature.includes(request.context.triggerCharacter) && !(request.context.isRetrigger && triggers?.retrigger.includes(request.context.triggerCharacter))) return undefined;
		const document = languageParameterHintsDocument(root, request);
		if (!document) return undefined;
		const result = await this.requestFeature('signatureHelp', document, signal, signal => this.api.signatureHelp({
			document,
			position: dtoPosition(request.position),
			triggerKind: request.context.kind,
			isRetrigger: request.context.isRetrigger ?? false,
			triggerCharacter: request.context.kind === "triggerCharacter" ? request.context.triggerCharacter : null,
		}, { signal }));
		if (!result || result.revision !== request.snapshot.version || result.signatures.length === 0) return undefined;
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
		const result = await this.requestFeature('inlayHints', document, signal, signal => this.api.inlayHints({ document, range: dtoRange(request.range) }, { signal }));
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
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
		const result = await withAbortSignal(token, signal => this.requestFeature('linkedEditingRanges', document, signal, signal => this.api.linkedEditingRanges({ document, position: dtoPosition(position) }, { signal })));
		if (!result || result.revision !== model.getVersionId() || result.ranges.length < 2) return undefined;
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
		const result = await this.requestFeature('semanticTokens', document, signal, signal => this.api.semanticTokens({ document }, { signal }));
		signal.throwIfAborted();
		if (!result || result.revision !== request.snapshot.version) return undefined;
		return Object.freeze({ tokens: Object.freeze(result.tokens.map(token => Object.freeze({ range: range(token.range), tokenType: token.tokenType, modifiers: Object.freeze([...token.modifiers]) }))) });
	}

	async provideDocumentSymbols(request: languages.LanguageDocumentSymbolRequest, signal: AbortSignal): Promise<readonly languages.LanguageDocumentSymbol[]> {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.requestFeature('documentSymbols', document, signal, signal => this.api.documentSymbols({ document }, { signal }));
		signal.throwIfAborted();
		return result && result.revision === request.snapshot.version ? Object.freeze(result.symbols.map(documentSymbol)) : Object.freeze([]);
	}

	async provideCodeLenses(model: ITextModel, token: CancellationToken): Promise<languages.CodeLensList> {
		const document = this.documentForModel(model);
		if (!document) return Object.freeze({ lenses: Object.freeze([]) });
		const result = await withAbortSignal(token, signal => this.requestFeature('codeLens', document, signal, signal => this.api.codeLenses({ document }, { signal })));
		return Object.freeze({
			lenses: result && result.revision === model.getVersionId() ? Object.freeze(result.lenses.map(codeLens)) : Object.freeze([]),
		});
	}

	async resolveCodeLens(model: ITextModel, lens: languages.CodeLens, token: CancellationToken): Promise<languages.CodeLens> {
		const document = this.documentForModel(model);
		if (!document) return lens;
		const result = await withAbortSignal(token, signal => this.requestFeature('codeLensResolve', document, signal, signal => this.api.resolveCodeLens({ document, lens: codeLensDto(lens) }, { signal })));
		return result && result.revision === model.getVersionId() && result.lenses[0] ? codeLens(result.lenses[0]) : lens;
	}

	async provideLinks(request: languages.LanguageLinkRequest, signal: AbortSignal): Promise<readonly languages.LanguageLink[]> {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		const key = `${workspaceRootForResource(this.workspace, request.resource).id}:${request.languageId}`;
		const capabilities = this.capabilities.get(key);
		signal.throwIfAborted();
		const result = await this.requestFeature('documentLinks', document, signal, signal => this.api.documentLinks({ document }, { signal }));
		signal.throwIfAborted();
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
		const resolved = await Promise.all(result.links.map(async link => link.target ? link : this.resolveDocumentLink(document, link, signal)));
		signal.throwIfAborted();
		if (this.capabilities.get(key) !== capabilities) return Object.freeze([]);
		return Object.freeze(resolved.flatMap(link => link.target ? [Object.freeze({ range: range(link.range), target: link.target, ...(link.tooltip ? { tooltip: link.tooltip } : {}) })] : []));
	}

	async provideDocumentColors(request: languages.LanguageColorRequest, signal: AbortSignal) {
		const document = this.documentForRequest(request);
		if (!document || !this.capabilities.get(`${workspaceRootForResource(this.workspace, request.resource).id}:${request.languageId}`)?.features.has('documentColors')) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.requestFeature('documentColors', document, signal, signal => this.api.documentColors({ document }, { signal }));
		signal.throwIfAborted();
		return result && result.revision === request.snapshot.version ? Object.freeze(result.colors.map(item => Object.freeze({ range: range(item.range), color: Object.freeze({ red: item.color.red / 255, green: item.color.green / 255, blue: item.color.blue / 255, alpha: item.color.alpha / 255 }) }))) : Object.freeze([]);
	}

	async provideColorPresentations(request: languages.LanguageColorPresentationRequest, signal: AbortSignal) {
		const document = this.documentForRequest(request);
		if (!document || !this.capabilities.get(`${workspaceRootForResource(this.workspace, request.resource).id}:${request.languageId}`)?.features.has('documentColors')) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.requestFeature('documentColors', document, signal, signal => this.api.colorPresentations({ document, range: dtoRange(request.range), color: { red: Math.round(request.color.red * 255), green: Math.round(request.color.green * 255), blue: Math.round(request.color.blue * 255), alpha: Math.round(request.color.alpha * 255) } }, { signal }));
		signal.throwIfAborted();
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.presentations.map(item => ({ label: item.label, ...(item.textEdit ? { textEdit: { range: range(item.textEdit.range), text: item.textEdit.newText } } : {}), ...(item.additionalTextEdits.length > 0 ? { additionalTextEdits: item.additionalTextEdits.map(edit => ({ range: range(edit.range), text: edit.newText })) } : {}) })));
	}

	async provideFoldingRanges(request: languages.LanguageFoldingRangeRequest, signal: AbortSignal) {
		const document = this.documentForRequest(request);
		if (!document) return Object.freeze([]);
		signal.throwIfAborted();
		const result = await this.requestFeature('foldingRanges', document, signal, signal => this.api.foldingRanges({ document }, { signal }));
		signal.throwIfAborted();
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.ranges.map(item => Object.freeze({ startLineIndex: item.startLineIndex, endLineIndex: item.endLineIndex, ...(item.kind ? { kind: item.kind } : {}), ...(item.collapsedText ? { collapsedText: item.collapsedText } : {}) })));
	}

	private requestFeature<T>(feature: LanguageServerFeatureDto, document: { readonly dirId?: string; readonly languageId: string; }, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		return requestWithCapability(this.capabilities, this.workspace, feature, document, signal, invoke);
	}

	private documentForRequest(request: { readonly resource?: URI; readonly languageId: string; readonly snapshot: { readonly version: number; getText(): string; }; readonly model: { readonly largeFile: { readonly tooLargeForSynchronization: boolean; }; }; }) {
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
		const result = await this.requestFeature('documentLinkResolve', document, signal, signal => this.api.resolveDocumentLink({ document, link }, { signal }));
		signal.throwIfAborted();
		return result && result.revision === document.revision && result.links[0] ? result.links[0] : link;
	}

	private async request(kind: LocationKind, request: languages.LanguageLocationRequest, includeDeclaration: boolean, signal: AbortSignal): Promise<readonly languages.LanguageLocation[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.requestFeature(kind, document, signal, signal => this.api.locations({
			document,
			position: dtoPosition(request.position),
			kind,
			includeDeclaration,
		}, { signal }));
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
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
		const result = await this.requestFeature(kind === 'prepareCall' ? 'callHierarchy' : 'typeHierarchy', document, signal, signal => this.api.hierarchy({ document, kind, position: dtoPosition(request.position), item: null }, { signal }));
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.entries.map(entry => hierarchyItem(root, entry.item)));
	}

	private async followCallHierarchy(kind: "incomingCalls" | "outgoingCalls", request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageCallHierarchyEntry[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.requestFeature('callHierarchy', document, signal, signal => this.api.hierarchy({ document, kind, position: null, item: hierarchyItemDto(root, request.item) }, { signal }));
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.entries.map(entry => Object.freeze({ item: hierarchyItem(root, entry.item), ...(entry.fromPath ? { fromResource: workspaceResource(root, entry.fromPath) } : {}), fromRanges: Object.freeze(entry.fromRanges.map(range)) })));
	}

	private async followTypeHierarchy(kind: "supertypes" | "subtypes", request: languages.LanguageHierarchyFollowupRequest, signal: AbortSignal): Promise<readonly languages.LanguageHierarchyItem[]> {
		const root = workspaceRootForResource(this.workspace, request.resource);
		const document = languageDocument(root, request);
		if (!document) return Object.freeze([]);
		const result = await this.requestFeature('typeHierarchy', document, signal, signal => this.api.hierarchy({ document, kind, position: null, item: hierarchyItemDto(root, request.item) }, { signal }));
		if (!result || result.revision !== request.snapshot.version) return Object.freeze([]);
		return Object.freeze(result.entries.map(entry => hierarchyItem(root, entry.item)));
	}
}

class AppServerWorkspaceSymbolProvider implements languages.LanguageWorkspaceSymbolProvider {
	constructor(private readonly api: ILanguageApi, private readonly workspace: IWorkspaceContextService, private readonly support: AppServerLanguageSupport, private readonly capabilities: ReadonlyMap<string, ServerCapabilities>) { }

	async provideWorkspaceSymbols(query: string, signal: AbortSignal): Promise<readonly languages.LanguageWorkspaceSymbol[]> {
		const folders = this.workspace.getWorkspace().folders;
		const roots = folders.map(folder => ({ id: folder.id, uri: folder.uri, ...(folders.length > 1 ? { wireId: folder.id } : {}) }));
		const responses = await Promise.all(roots.flatMap(root => this.support.workspaceLanguageIds(root.id).map(async languageId => {
			const document = { ...(root.wireId ? { dirId: root.wireId } : {}), languageId };
			const result = await requestWithCapability(this.capabilities, this.workspace, 'workspaceSymbols', document, signal, signal => this.api.directorySymbols({ ...document, query }, { signal }));
			return result?.symbols.map(symbol => ({ root, symbol })) ?? [];
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

function sameCapabilities(left: ServerCapabilities, right: ServerCapabilities): boolean {
	const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
	return left.server === right.server && left.features.size === right.features.size && [...left.features].every(feature => right.features.has(feature)) && same(left.completion, right.completion) && same(left.onType, right.onType) && same(left.signature, right.signature) && same(left.retrigger, right.retrigger);
}

async function requestWithCapability<T>(capabilities: ReadonlyMap<string, ServerCapabilities>, workspace: IWorkspaceContextService, feature: LanguageServerFeatureDto, document: { readonly dirId?: string; readonly languageId: string; }, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
	const key = `${document.dirId ?? workspace.getWorkspace().folders[0]?.id}:${document.languageId}`;
	const current = capabilities.get(key);
	if (!current?.features.has(feature)) return undefined;
	const combined = signal ? AbortSignal.any([signal, current.lifetime.signal]) : current.lifetime.signal;
	try {
		combined.throwIfAborted();
		const result = await invoke(combined);
		return !combined.aborted && capabilities.get(key) === current ? result : undefined;
	} catch (error) {
		if (current.lifetime.signal.aborted) return undefined;
		throw error;
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

function languageSnapshotDocument(root: LanguageWorkspaceRoot, request: { readonly resource?: URI; readonly languageId: string; readonly snapshot: { readonly version: number; getText(): string; }; }) {
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

function appServerCompletionResolveData(value: unknown): { readonly document: NonNullable<ReturnType<typeof languageCompletionDocument>>; readonly providerData: unknown; readonly generation?: number; } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("App Server completion resolve data must be an object");
	const data = value as { readonly document?: unknown; readonly providerData?: unknown; };
	if (typeof data.document !== "object" || data.document === null) throw new TypeError("App Server completion resolve data must include its document snapshot");
	return data as { readonly document: NonNullable<ReturnType<typeof languageCompletionDocument>>; readonly providerData: unknown; readonly generation?: number; };
}

function languageSemanticTokensDocument(root: LanguageWorkspaceRoot, request: languages.LanguageSemanticTokensRequest) {
	if (!request.resource || request.model.largeFile.tooLargeForTokenization || request.model.largeFile.tooLargeForSynchronization) return undefined;
	return languageSnapshotDocument(root, request);
}

function formattingEdits(edits: readonly { readonly range: { readonly start: { readonly lineIndex: number; readonly columnIndex: number; }; readonly end: { readonly lineIndex: number; readonly columnIndex: number; }; }; readonly newText: string; }[]) {
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

function dtoPosition(position: Position): { readonly lineIndex: number; readonly columnIndex: number; } { return { lineIndex: position.lineNumber - 1, columnIndex: position.column - 1 }; }

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
	return Object.freeze({
		entries: Object.freeze(edit.entries.map(entry => {
			switch (entry.kind) {
				case "textDocument": return Object.freeze({ kind: entry.kind, resource: workspaceResource(root, entry.document.path), expectedText: entry.document.expectedText, edits: Object.freeze(entry.document.edits.map(edit => Object.freeze({ range: range(edit.range), text: edit.newText }))) });
				case "create": return Object.freeze({ kind: entry.kind, resource: workspaceResource(root, entry.path), existing: entry.existing });
				case "rename": return Object.freeze({ kind: entry.kind, source: workspaceResource(root, entry.source), target: workspaceResource(root, entry.target), existing: entry.existing });
				case "delete": return Object.freeze({ kind: entry.kind, resource: workspaceResource(root, entry.path), missing: entry.missing, mode: entry.mode });
			}
		}))
	});
}

function codeAction(root: LanguageWorkspaceRoot, action: LanguageCodeActionDto): languages.LanguageCodeAction {
	return Object.freeze({ title: action.title, ...(action.kind ? { kind: action.kind } : {}), isPreferred: action.isPreferred, ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}), ...(action.edit ? { edit: workspaceEdit(root, action.edit) } : {}), data: action.providerData });
}

function documentSymbol(value: LanguageDocumentSymbolDto): languages.LanguageDocumentSymbol {
	return Object.freeze({ name: value.name, ...(value.detail ? { detail: value.detail } : {}), kind: value.symbolKind, range: range(value.range), selectionRange: range(value.selectionRange), ...(value.children.length > 0 ? { children: Object.freeze(value.children.map(documentSymbol)) } : {}) });
}

type AppServerCodeLens = languages.CodeLens & { readonly providerData?: unknown; };

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
			if (!match || folder.uri.toEncodedComponents().path.length > match.uri.toEncodedComponents().path.length) match = { id: folder.id, uri: folder.uri, ...(folders.length > 1 ? { wireId: folder.id } : {}) };
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

function range(value: { readonly start: { readonly lineIndex: number; readonly columnIndex: number; }; readonly end: { readonly lineIndex: number; readonly columnIndex: number; }; }): Range {
	return Range.fromPositions(new Position((value.start.lineIndex) + 1, (value.start.columnIndex) + 1), new Position((value.end.lineIndex) + 1, (value.end.columnIndex) + 1));
}
