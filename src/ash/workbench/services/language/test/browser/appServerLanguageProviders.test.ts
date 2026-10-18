import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageDiagnosticSeverity, createLanguageCompletionInvokeContext, createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { LanguageCompletionService } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { getWorkspaceSymbols } from '../../../../contrib/search/common/search.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { type ILanguageApi } from "../../../../../platform/language/common/languageApi.js";
import { IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { IWorkspaceTrustManagementService, type WorkspaceTrustPermission } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { type ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { TestWorkspaceService } from "../../../configuration/test/common/testServices.js";
import { AppServerLanguageProviders } from "../../browser/appServerLanguageProviders.js";

function createProviders(languages: LanguageFeaturesService, api: ILanguageApi, workspace: TestWorkspaceService, options: { workspaceTrust?: IWorkspaceTrustManagementService; events?: IServerEventApi; } = {}): AppServerLanguageProviders {
	using services = new InstantiationService();
	services.registerInstance(ILanguageFeaturesService, languages);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IServerEventApi, options.events ?? new FakeServerEvents());
	services.registerInstance(IWorkspaceTrustManagementService, options.workspaceTrust ?? {
		onDidChangeTrust: Event.None,
		getUriTrustInfo: async () => { throw new Error('Backend-authorized language requests must not inspect host grants'); },
		getWorkspaceTrustInfo: async () => undefined,
	});
	return services.createInstance(AppServerLanguageProviders, api, { checkWorkspaceTrust: !!options.workspaceTrust });
}

test('language providers require the scoped trust registration even when the backend authorizes Web requests', () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'empty' });
	using languages = new LanguageFeaturesService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(ILanguageFeaturesService, languages);
	services.registerInstance(IServerEventApi, new FakeServerEvents());
	assert.throws(() => services.createInstance(AppServerLanguageProviders, {} as ILanguageApi, { checkWorkspaceTrust: false }), /Unknown service: workspaceTrustManagementService/);
});

const DTO_RANGE = Object.freeze({ start: Object.freeze({ lineIndex: 0, columnIndex: 0 }), end: Object.freeze({ lineIndex: 0, columnIndex: 5 }) });

function definition(languages: LanguageFeaturesService, model: TextModel, resource: URI, position: Position) {
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource, position };
	return languages.definitionProvider.ordered(model)[0]!.provideDefinition(request, signal);
}

test("App Server language providers map cross-resource locations without double-encoding paths", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	const source = URI.file("C:/project/main file.ts");
	using model = new TextModel("value", { languageId: "typescript", resource: source });

	const locations = await definition(languages, model, source, new Position((0) + 1, (2) + 1));

	assert.equal(api.locationRequests.length, 1);
	assert.equal(api.locationRequests[0]!.document.path, "main file.ts");
	assert.equal(api.locationRequests[0]!.document.text, "value");
	assert.deepEqual(api.locationRequests[0]!.position, { lineIndex: 0, columnIndex: 2 });
	assert.equal(locations[0]!.resource.toString(), "file:///C:/project/src/with%20space.ts");
	assert.equal(locations[0]!.selectionRange!.endColumn, 6);
});

test('App Server Shell registration uses the editor grammar language identity', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	using model = new TextModel('value', { languageId: 'shellscript', resource: URI.file('/project/main.sh') });
	await definition(languages, model, URI.file('/project/main.sh'), new Position(1, 2));
	assert.equal(api.locationRequests[0]!.document.languageId, 'shellscript');
	assert.equal(languages.completionProvider.getProvider('ash.appServer.completions')!.languageIds.includes('shellscript'), true);
});

test("App Server language providers route resources through their owning Workspace folder", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({
		id: "multi-root",
		folders: [
			{ id: "frontend", uri: URI.file("C:/frontend"), name: "frontend", index: 0 },
			{ id: "backend", uri: URI.file("C:/backend"), name: "backend", index: 1 },
		],
		configuration: URI.file("C:/project.code-workspace"),
	});
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	const source = URI.file("C:/backend/main.ts");
	using model = new TextModel("value", { languageId: "typescript", resource: source });

	const locations = await definition(languages, model, source, new Position((0) + 1, (2) + 1));

	assert.equal(api.locationRequests[0]!.document.dirId, "backend");
	assert.equal(api.locationRequests[0]!.document.path, "main.ts");
	assert.equal(locations[0]!.resource.toString(), "file:///C:/backend/src/with%20space.ts");
});

test("App Server workspace symbols query every supported Code language and deduplicate results", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();

	const result = await getWorkspaceSymbols(languages.workspaceSymbolProvider.allNoModel(), "answer");

	assert.deepEqual(api.workspaceSymbolLanguages.sort(), ["json", "rust", "shellscript", "typescript"]);
	assert.equal(result.length, 1);
	assert.equal(result[0]!.resource.toString(), "file:///C:/project/src/with%20space.ts");
});

test("App Server hover and completion providers keep revision, resource, and insertion semantics", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	await tick();
	events.fire({ method: 'language/serverCapabilities', params: { server: 'fixture', languageIds: ['rust'], completionTriggerCharacters: ['.'], signatureHelpTriggerCharacters: ['('], signatureHelpRetriggerCharacters: [','] } });
	await tick();
	const resource = URI.file("C:/project/main.rs");
	using model = new TextModel("pri", { languageId: "rust", resource });
	using completions = new LanguageCompletionService(model, languages.completionProvider, { resource });

	const hoverSignal = new AbortController().signal;
	const hoverResult = await languages.hoverProvider.ordered(model)[0]!.provideHover({
		...createLanguageFeatureRequest(model, model.getLanguageId(), hoverSignal),
		resource,
		position: new Position(1, 2),
	}, hoverSignal);
	await completions.request("rust", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	const completionResult = completions.results.result!;
	const completionItem = completionResult.value.items[0]!;
	const resolved = await completions.resolveCompletionItem({ completionRequestId: completionResult.requestId, modelVersion: completionResult.modelVersion, providerId: completionItem.providerId, itemId: completionItem.id }, new AbortController().signal);
	await completions.executeCompletionCommand("rust", completionItem, new AbortController().signal);
	const signal = new AbortController().signal;
	const hints = await languages.signatureHelpProvider.ordered(model)[0]!.provideParameterHints({
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		resource,
		position: new Position(1, 4),
		context: { kind: 'triggerCharacter', triggerCharacter: '(' },
	}, signal);
	const inlays = await languages.inlayHintsProvider.ordered(model)[0]!.provideInlayHints({
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		resource,
		range: model.getFullModelRange(),
	}, signal);
	const linkedEditing = languages.linkedEditingRangeProvider.ordered(model)[0]!;
	const linked = await linkedEditing.provideLinkedEditingRanges(model, new Position((0) + 1, (1) + 1), CancellationToken.None);

	assert.equal(hoverResult?.contents[0], "hover docs");
	assert.equal(api.hoverRequests[0]!.document.path, "main.rs");
	assert.equal(api.completionRequests[0]!.document.text, "pri");
	assert.equal(completions.results.result?.value.items[0]!.insertText, "println!($0)");
	assert.equal(completions.results.result?.value.items[0]!.range.getEndPosition().column, 4);
	assert.equal(completionItem.hasDeferredDetails, true);
	assert.equal(completionItem.command?.id, "rust-analyzer.runSingle");
	assert.equal(resolved.documentation, "Resolved completion docs");
	assert.equal(api.executeCommandRequests[0]!.document.text, "pri");
	assert.equal(hints?.signatures[0]!.parameters[1]!.label, "value");
	assert.equal(api.signatureHelpRequests[0]!.triggerCharacter, "(");
	assert.equal(inlays[0]!.label, ": &str");
	assert.equal(Range.lift(linked?.ranges[1]!).getStartPosition().column, 9);
	assert.equal(linked?.wordPattern?.test("value"), true);
});

test("App Server rename and code actions preserve ordered workspace file operations", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	const resource = URI.file("C:/project/main.ts");
	using model = new TextModel("value", { languageId: "typescript", resource });
	const signal = new AbortController().signal;
	const request = {
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		resource,
		position: new Position(1, 3),
	};
	const rename = languages.renameProvider.ordered(model)[0]!;
	const preparation = await rename.prepareRename!(request, signal);
	const edit = await rename.provideRenameEdits({ ...request, newName: 'renamed' }, signal);
	const available = await languages.codeActionProvider.ordered(model)[0]!.provideCodeActions({
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		resource,
		range: model.getFullModelRange(),
		diagnostics: [{ range: model.getFullModelRange(), severity: LanguageDiagnosticSeverity.Warning, message: "demo", source: "test" }],
	}, signal);

	assert.equal(preparation?.placeholder, "value");
	assert.equal(edit.entries[0]!.kind, "create");
	assert.equal(edit.entries[1]!.kind, "textDocument");
	assert.ok(Array.isArray(available), 'the App Server provider continues to return an action array');
	assert.equal(available[0]!.edit?.entries[0]!.kind, "rename");
	assert.equal(api.codeActionRequests[0]!.diagnostics[0]!.severity, "warning");
});

test("App Server formatting providers preserve snapshot, options, range, and edits", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	using model = new TextModel("value", { languageId: "typescript", resource: URI.file("C:/project/main.ts") });
	const options = { tabSize: 4, insertSpaces: false, trimTrailingWhitespace: true };
	assert.deepEqual(languages.onTypeFormattingEditProvider.ordered(model), []);

	const documentEdits = await languages.documentFormattingEditProvider.ordered(model)[0]!.provideDocumentFormattingEdits(model, { tabSize: 2, insertSpaces: true }, CancellationToken.None);
	const rangeEdits = await languages.documentRangeFormattingEditProvider.ordered(model)[0]!.provideDocumentRangeFormattingEdits(model, new Range(1, 1, 1, 6), options, CancellationToken.None);

	assert.equal(api.documentFormattingRequests[0]!.document.path, "main.ts");
	assert.deepEqual(api.documentFormattingRequests[0]!.options, { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: null });
	assert.deepEqual(api.rangeFormattingRequests[0]!.range, DTO_RANGE);
	assert.deepEqual(api.rangeFormattingRequests[0]!.options, options);
	assert.equal(documentEdits?.[0]!.text, "formatted");
	assert.equal(Range.lift(rangeEdits![0]!.range).getEndPosition().column, 6);
});

test('App Server range formatting discards a response after the model changes', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	const api = new FakeLanguageApi();
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	api.formatRange = async params => {
		await pending;
		return { revision: params.document.revision, edits: [{ range: DTO_RANGE, newText: 'formatted' }] };
	};
	using providers = createProviders(languages, api, workspace);
	await tick();
	using model = new TextModel('value', { languageId: 'typescript', resource: URI.file('/project/main.ts') });
	const result = languages.documentRangeFormattingEditProvider.ordered(model)[0]!.provideDocumentRangeFormattingEdits(model, new Range(1, 1, 1, 6), { tabSize: 4, insertSpaces: true }, CancellationToken.None);
	model.setValue('changed');
	release();
	assert.deepEqual(await result, []);
});

test("App Server language providers do not send documents above their transport limit", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	const source = URI.file("C:/project/large.ts");
	using model = new TextModel("界".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3)), { languageId: "typescript", resource: source });

	assert.deepEqual(await definition(languages, model, source, new Position((0) + 1, (0) + 1)), []);
	assert.equal(api.locationRequests.length, 0);
});

test("App Server language providers register only while directory permissions allow execution", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	const api = new FakeLanguageApi();
	const events = new FakeServerEvents();
	using permissions = new FakeWorkspaceTrustService([]);
	using providers = createProviders(languages, api, workspace, { workspaceTrust: permissions, events });
	await tick();
	const source = URI.file("C:/project/main.ts");
	using model = new TextModel("value", { languageId: "typescript", resource: source });

	await tick();
	assert.deepEqual(languages.definitionProvider.ordered(model), []);
	assert.equal(api.locationRequests.length, 0);

	permissions.value = ["executeCommands", "useLanguageServices"];
	permissions.notify();
	await tick();
	assert.equal((await definition(languages, model, source, new Position((0) + 1, (2) + 1))).length, 1);
	assert.equal(api.locationRequests.length, 1);

	permissions.value = [];
	permissions.notify();
	await tick();
	assert.deepEqual(languages.definitionProvider.ordered(model), []);
	assert.equal(api.locationRequests.length, 1);
});

class FakeServerEvents implements IServerEventApi {
	private listener: ((event: ServerNotification) => void) | undefined;
	subscribe(listener: (event: ServerNotification) => void) { this.listener = listener; return { dispose: () => { this.listener = undefined; } }; }
	fire(event: ServerNotification): void { this.listener?.(event); }
}

test('Desktop providers discover custom routes and retire disabled routes after a profile change', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using trust = new FakeWorkspaceTrustService(['executeCommands', 'useLanguageServices']);
	const api = new FakeLanguageApi();
	api.availableServers = [];
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { workspaceTrust: trust, events });
	using model = new TextModel('value', { languageId: 'python', resource: URI.file('/project/main.py') });
	await tick();
	assert.equal(languages.hoverProvider.ordered(model).length, 0);
	api.availableServers = [{ id: 'custom-python', languageIds: ['python'] }];
	events.fire({ method: 'config/changed', params: { revision: 1, generation: 1 } });
	await tick();
	assert.equal(languages.hoverProvider.ordered(model).length, 1);
	api.availableServers = [];
	events.fire({ method: 'config/changed', params: { revision: 2, generation: 2 } });
	await tick();
	assert.equal(languages.hoverProvider.ordered(model).length, 0);
});

class FakeWorkspaceTrustService extends Disposable implements IWorkspaceTrustManagementService {
	private readonly change = this._register(new Emitter<void>());
	readonly onDidChangeTrust = this.change.event;
	constructor(public value: readonly WorkspaceTrustPermission[]) { super(); }
	async getUriTrustInfo(uri: URI) { return { uri, trusted: false, permissions: this.value }; }
	async getWorkspaceTrustInfo() { return undefined; }
	notify() { this.change.fire(); }
}

async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

class FakeLanguageApi implements ILanguageApi {
	async save(_params: Parameters<ILanguageApi['save']>[0]): Promise<void> { }

	availableServers = [
		{ id: "typescript", languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
		{ id: "rust", languageIds: ["rust"] },
		{ id: "json", languageIds: ["json", "jsonc"] },
		{ id: "shell", languageIds: ["shellscript"] },
	];
	async servers(): ReturnType<ILanguageApi["servers"]> { return { servers: this.availableServers }; }

	readonly locationRequests: Parameters<ILanguageApi["locations"]>[0][] = [];
	readonly codeActionRequests: Parameters<ILanguageApi["codeActions"]>[0][] = [];
	readonly workspaceSymbolLanguages: string[] = [];
	readonly hoverRequests: Parameters<ILanguageApi["hover"]>[0][] = [];
	readonly completionRequests: Parameters<ILanguageApi["completions"]>[0][] = [];
	readonly executeCommandRequests: Parameters<ILanguageApi["executeCommand"]>[0][] = [];
	readonly documentFormattingRequests: Parameters<ILanguageApi["formatDocument"]>[0][] = [];
	readonly rangeFormattingRequests: Parameters<ILanguageApi["formatRange"]>[0][] = [];
	readonly signatureHelpRequests: Parameters<ILanguageApi["signatureHelp"]>[0][] = [];

	async synchronize(): Promise<void> { }
	async close(): Promise<void> { }

	async hover(params: Parameters<ILanguageApi["hover"]>[0]): ReturnType<ILanguageApi["hover"]> {
		this.hoverRequests.push(params);
		return { revision: params.document.revision, contents: "hover docs", range: DTO_RANGE };
	}

	async completions(params: Parameters<ILanguageApi["completions"]>[0]): ReturnType<ILanguageApi["completions"]> {
		this.completionRequests.push(params);
		return { revision: params.document.revision, isIncomplete: false, canResolve: true, items: [{ label: "println!", kind: "function", detail: "macro", documentation: "Prints text", filterText: null, sortText: "0", preselect: true, commitCharacters: ["("], insertTextFormat: "snippet", range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 3 } }, insertText: "println!($0)", additionalTextEdits: [], command: { id: "rust-analyzer.runSingle", title: "Run", arguments: [{ runnable: 1 }] }, providerData: { label: "println!" } }] };
	}

	async resolveCompletion(params: Parameters<ILanguageApi["resolveCompletion"]>[0]): ReturnType<ILanguageApi["resolveCompletion"]> { return { revision: params.document.revision, detail: "resolved macro", documentation: "Resolved completion docs" }; }
	async executeCommand(params: Parameters<ILanguageApi["executeCommand"]>[0]): Promise<void> { this.executeCommandRequests.push(params); }
	async documentDiagnostics(params: Parameters<ILanguageApi["documentDiagnostics"]>[0]): ReturnType<ILanguageApi["documentDiagnostics"]> { return { revision: params.document.revision, kind: "unchanged", diagnostics: [] }; }
	async directoryDiagnostics(): ReturnType<ILanguageApi["directoryDiagnostics"]> { return { supported: false, snapshots: [] }; }

	async formatDocument(params: Parameters<ILanguageApi["formatDocument"]>[0]): ReturnType<ILanguageApi["formatDocument"]> {
		this.documentFormattingRequests.push(params);
		return { revision: params.document.revision, edits: [{ range: DTO_RANGE, newText: "formatted" }] };
	}

	async formatRange(params: Parameters<ILanguageApi["formatRange"]>[0]): ReturnType<ILanguageApi["formatRange"]> {
		this.rangeFormattingRequests.push(params);
		return { revision: params.document.revision, edits: [{ range: DTO_RANGE, newText: "formatted range" }] };
	}

	async signatureHelp(params: Parameters<ILanguageApi["signatureHelp"]>[0]): ReturnType<ILanguageApi["signatureHelp"]> {
		this.signatureHelpRequests.push(params);
		return { revision: params.document.revision, activeSignature: 0, signatures: [{ label: "call(name, value)", documentation: "Calls it", activeParameter: 1, parameters: [{ label: "name", documentation: null }, { label: "value", documentation: "The value" }] }] };
	}

	async inlayHints(params: Parameters<ILanguageApi["inlayHints"]>[0]): ReturnType<ILanguageApi["inlayHints"]> {
		return { revision: params.document.revision, hints: [{ position: { lineIndex: 0, columnIndex: 3 }, label: ": &str", kind: "type", tooltip: "inferred", paddingLeft: true, paddingRight: false }] };
	}
	async linkedEditingRanges(params: Parameters<ILanguageApi["linkedEditingRanges"]>[0]): ReturnType<ILanguageApi["linkedEditingRanges"]> {
		return { revision: params.document.revision, ranges: [DTO_RANGE, { start: { lineIndex: 0, columnIndex: 8 }, end: { lineIndex: 0, columnIndex: 13 } }], wordPattern: "[A-Za-z]+" };
	}
	async semanticTokens(params: Parameters<ILanguageApi["semanticTokens"]>[0]): ReturnType<ILanguageApi["semanticTokens"]> {
		return { revision: params.document.revision, resultId: "1", tokens: [] };
	}
	async documentSymbols(params: Parameters<ILanguageApi["documentSymbols"]>[0]): ReturnType<ILanguageApi["documentSymbols"]> { return { revision: params.document.revision, symbols: [] }; }
	async codeLenses(params: Parameters<ILanguageApi["codeLenses"]>[0]): ReturnType<ILanguageApi["codeLenses"]> { return { revision: params.document.revision, lenses: [] }; }
	async resolveCodeLens(params: Parameters<ILanguageApi["resolveCodeLens"]>[0]): ReturnType<ILanguageApi["resolveCodeLens"]> { return { revision: params.document.revision, lenses: [params.lens] }; }
	async documentLinks(params: Parameters<ILanguageApi["documentLinks"]>[0]): ReturnType<ILanguageApi["documentLinks"]> { return { revision: params.document.revision, links: [] }; }
	async resolveDocumentLink(params: Parameters<ILanguageApi["resolveDocumentLink"]>[0]): ReturnType<ILanguageApi["resolveDocumentLink"]> { return { revision: params.document.revision, links: [params.link] }; }
	async documentColors(params: Parameters<ILanguageApi["documentColors"]>[0]): ReturnType<ILanguageApi["documentColors"]> { return { revision: params.document.revision, colors: [] }; }
	async colorPresentations(params: Parameters<ILanguageApi["colorPresentations"]>[0]): ReturnType<ILanguageApi["colorPresentations"]> { return { revision: params.document.revision, presentations: [] }; }
	async foldingRanges(params: Parameters<ILanguageApi["foldingRanges"]>[0]): ReturnType<ILanguageApi["foldingRanges"]> { return { revision: params.document.revision, ranges: [] }; }

	async locations(params: Parameters<ILanguageApi["locations"]>[0]): ReturnType<ILanguageApi["locations"]> {
		this.locationRequests.push(params);
		return { revision: params.document.revision, locations: [{ path: "src/with space.ts", range: DTO_RANGE, selectionRange: DTO_RANGE }] };
	}

	async hierarchy(params: Parameters<ILanguageApi["hierarchy"]>[0]): ReturnType<ILanguageApi["hierarchy"]> {
		return { revision: params.document.revision, entries: [] };
	}

	async directorySymbols(params: Parameters<ILanguageApi["directorySymbols"]>[0]): ReturnType<ILanguageApi["directorySymbols"]> {
		this.workspaceSymbolLanguages.push(params.languageId);
		return { symbols: [{ name: "answer", symbolKind: 12, containerName: "demo", path: "src/with space.ts", range: DTO_RANGE }] };
	}

	async prepareRename(): ReturnType<ILanguageApi["prepareRename"]> {
		return { preparation: { range: DTO_RANGE, placeholder: "value" } };
	}

	async rename(): ReturnType<ILanguageApi["rename"]> {
		return {
			entries: [
				{ kind: "create", path: "created.ts", existing: "error" },
				{ kind: "textDocument", document: { path: "main.ts", expectedText: "value", edits: [{ range: DTO_RANGE, newText: "renamed" }] } },
			]
		};
	}

	async codeActions(params: Parameters<ILanguageApi["codeActions"]>[0]): ReturnType<ILanguageApi["codeActions"]> {
		this.codeActionRequests.push(params);
		return { actions: [{ title: "Move file", kind: "refactor.move", isPreferred: true, disabledReason: null, edit: { entries: [{ kind: "rename", source: "main.ts", target: "moved.ts", existing: "error" }] }, providerData: { id: 1 } }] };
	}

	async resolveCodeAction(): ReturnType<ILanguageApi["resolveCodeAction"]> {
		return { title: "Resolved", kind: null, isPreferred: false, disabledReason: null, edit: null, providerData: null };
	}
}

test("installed language servers register new languages and uninstall removes their providers", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("/project") });
	const api = new FakeLanguageApi();
	api.availableServers = [];
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	const resource = URI.file("/project/main.py");
	using model = new TextModel("value", { languageId: "python", resource });
	await tick();
	assert.deepEqual(languages.definitionProvider.ordered(model), []);

	api.availableServers = [{ id: "pyright", languageIds: ["python"] }];
	events.fire({ method: "extensions/changed", params: { instanceId: "test", generation: 2 } });
	await tick();
	assert.equal((await definition(languages, model, resource, new Position(1, 2))).length, 1);
	assert.equal(api.locationRequests[0]!.document.languageId, "python");

	api.availableServers = [];
	events.fire({ method: "extensions/changed", params: { instanceId: "test", generation: 3 } });
	await tick();
	assert.deepEqual(languages.definitionProvider.ordered(model), []);
	assert.equal(api.locationRequests.length, 1);
});


test('Workspace language providers leave committed Git snapshots to editor providers', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace);
	await tick();
	using working = new TextModel('value', { languageId: 'rust', resource: URI.file('/project/main.rs') });
	using history = new TextModel('committed value', { languageId: 'rust', resource: URI.parse('git:/repo/commit/main.rs') });
	for (const registry of [languages.definitionProvider, languages.hoverProvider, languages.inlayHintsProvider, languages.documentSemanticTokensProvider, languages.codeLensProvider, languages.linkProvider, languages.foldingRangeProvider]) {
		assert.equal(registry.has(working), true);
		assert.equal(registry.has(history), false);
	}
	await definition(languages, working, working.uri, new Position(1, 1));
	assert.equal(api.locationRequests.length, 1);
	assert.equal(api.locationRequests[0]!.document.path, 'main.rs');
});

test('negotiated triggers replace registrations and dynamic removal drops obsolete characters', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'triggers', uri: URI.file('/project') });
	const events = new FakeServerEvents();
	using providers = createProviders(languages, new FakeLanguageApi(), workspace, { events });
	await tick();
	const notify = (completionTriggerCharacters: string[], signatureHelpTriggerCharacters: string[], signatureHelpRetriggerCharacters: string[]) => events.fire({
		method: 'language/serverCapabilities', params: { server: 'fixture', languageIds: ['rust'], completionTriggerCharacters, signatureHelpTriggerCharacters, signatureHelpRetriggerCharacters },
	});
	notify(['\\', '='], ['['], [']']);
	await tick();
	assert.deepEqual(languages.completionProvider.getProvider('ash.appServer.completions')!.triggerCharacters, ['\\', '=']);
	using model = new TextModel('value', { languageId: 'rust', resource: URI.file('/project/main.rs') });
	const signature = languages.signatureHelpProvider.ordered(model)[0]!;
	assert.deepEqual(signature.signatureHelpTriggerCharacters, ['[']);
	assert.deepEqual(signature.signatureHelpRetriggerCharacters, [']']);
	events.fire({ method: 'config/changed', params: { revision: 2, generation: 2 } });
	await tick();
	assert.deepEqual(languages.completionProvider.getProvider('ash.appServer.completions')!.triggerCharacters, ['\\', '=']);
	notify(['='], [], []);
	await tick();
	assert.deepEqual(languages.completionProvider.getProvider('ash.appServer.completions')!.triggerCharacters, ['=']);
	assert.deepEqual(languages.signatureHelpProvider.ordered(model)[0]!.signatureHelpTriggerCharacters, []);
	events.fire({ method: 'language/serverState', params: { server: 'fixture', state: { type: 'backingOff', attempt: 1, retryAfterMillis: 10 } } });
	await tick();
	assert.deepEqual(languages.completionProvider.getProvider('ash.appServer.completions')!.triggerCharacters, []);
});
