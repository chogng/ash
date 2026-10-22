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
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { type LanguageServerFeatureDto, type ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { TestWorkspaceService } from "../../../configuration/test/common/testServices.js";
import { AppServerLanguageProviders } from "../../browser/appServerLanguageProviders.js";

function notifyFeatures(events: FakeServerEvents, features: readonly LanguageServerFeatureDto[], dirId?: string): void {
	events.fire({
		method: 'language/serverCapabilities', params: {
			...(dirId ? { dirId } : {}), server: 'fixture', languageIds: ['rust'], features: [...features],
			completionTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
		}
	});
}

test('every model provider requires its own negotiated capability in the owning directory', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({
		id: 'team', folders: [
			{ id: 'one', name: 'one', uri: URI.file('/one'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/two'), index: 1 },
		]
	});
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	using first = new TextModel('value', { languageId: 'rust', resource: URI.file('/one/main.rs') });
	using second = new TextModel('value', { languageId: 'rust', resource: URI.file('/two/main.rs') });
	const registries = [
		['hover', languages.hoverProvider], ['declaration', languages.declarationProvider], ['definition', languages.definitionProvider],
		['implementation', languages.implementationProvider], ['typeDefinition', languages.typeDefinitionProvider], ['references', languages.referenceProvider],
		['callHierarchy', languages.callHierarchyProvider], ['typeHierarchy', languages.typeHierarchyProvider], ['rename', languages.renameProvider],
		['codeActions', languages.codeActionProvider], ['documentFormatting', languages.documentFormattingEditProvider], ['rangeFormatting', languages.documentRangeFormattingEditProvider],
		['signatureHelp', languages.signatureHelpProvider], ['inlayHints', languages.inlayHintsProvider], ['linkedEditingRanges', languages.linkedEditingRangeProvider],
		['semanticTokens', languages.documentSemanticTokensProvider], ['documentSymbols', languages.documentSymbolProvider], ['codeLens', languages.codeLensProvider],
		['documentLinks', languages.linkProvider], ['documentColors', languages.colorProvider], ['foldingRanges', languages.foldingRangeProvider],
	] as const;
	await tick();
	for (const [, registry] of registries) assert.equal(registry.has(first), false);
	assert.equal(languages.completionProvider.getProvider('ash.appServer.completions'), undefined);
	assert.deepEqual(languages.workspaceSymbolProvider.allNoModel(), []);
	for (const [feature] of registries) {
		notifyFeatures(events, [feature], 'one');
		await tick();
		for (const [candidate, registry] of registries) {
			assert.equal(registry.has(first), candidate === feature, `${feature}: ${candidate}`);
			assert.equal(registry.has(second), false, `${candidate} must not leak into another root`);
		}
	}
});

test('retained adapters filter every request after capability revocation and across directories', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({
		id: 'team', folders: [
			{ id: 'one', name: 'one', uri: URI.file('/one'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/two'), index: 1 },
		]
	});
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	const calls: PropertyKey[] = [];
	const traced = new Proxy(api, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			return typeof value === 'function' ? (...args: unknown[]) => { calls.push(key); return Reflect.apply(value, target, args); } : value;
		}
	});
	const events = new FakeServerEvents();
	using providers = createProviders(languages, traced, workspace, { events });
	notifyFeatures(events, [...baselineFeatures, 'documentColors', 'codeActions', 'codeActionResolve'], 'one');
	await tick();
	using first = new TextModel('value', { languageId: 'rust', resource: URI.file('/one/main.rs') });
	using second = new TextModel('value', { languageId: 'rust', resource: URI.file('/two/main.rs') });
	const signal = new AbortController().signal;
	const hover = languages.hoverProvider.ordered(first)[0]!;
	const completion = languages.completionProvider.getProvider('ash.appServer.completions')!;
	const declaration = languages.declarationProvider.ordered(first)[0]!;
	const definition = languages.definitionProvider.ordered(first)[0]!;
	const implementation = languages.implementationProvider.ordered(first)[0]!;
	const typeDefinition = languages.typeDefinitionProvider.ordered(first)[0]!;
	const references = languages.referenceProvider.ordered(first)[0]!;
	const callHierarchy = languages.callHierarchyProvider.ordered(first)[0]!;
	const typeHierarchy = languages.typeHierarchyProvider.ordered(first)[0]!;
	const rename = languages.renameProvider.ordered(first)[0]!;
	const formatting = languages.documentFormattingEditProvider.ordered(first)[0]!;
	const rangeFormatting = languages.documentRangeFormattingEditProvider.ordered(first)[0]!;
	const signature = languages.signatureHelpProvider.ordered(first)[0]!;
	const inlay = languages.inlayHintsProvider.ordered(first)[0]!;
	const linked = languages.linkedEditingRangeProvider.ordered(first)[0]!;
	const semantic = languages.documentSemanticTokensProvider.ordered(first)[0]!;
	const symbols = languages.documentSymbolProvider.ordered(first)[0]!;
	const lenses = languages.codeLensProvider.ordered(first)[0]!;
	const links = languages.linkProvider.ordered(first)[0]!;
	const colors = languages.colorProvider.ordered(first)[0]!;
	const folding = languages.foldingRangeProvider.ordered(first)[0]!;
	const workspaceSymbols = languages.workspaceSymbolProvider.allNoModel()[0]!;
	const invokeAll = async (model: TextModel) => {
		const request = { ...createLanguageFeatureRequest(model, 'rust', signal), requestId: 1, resource: model.uri, position: new Position(1, 2), range: model.getFullModelRange() };
		await hover.provideHover(request, signal);
		await completion.provideCompletions({ ...request, requestId: 1, context: createLanguageCompletionInvokeContext() }, signal);
		await completion.executeCompletionCommand!({ ...request, command: { id: 'test.command', title: 'Test', arguments: [] } }, signal);
		await declaration.provideDeclaration(request, signal);
		await definition.provideDefinition(request, signal);
		await implementation.provideImplementation(request, signal);
		await typeDefinition.provideTypeDefinition(request, signal);
		await references.provideReferences({ ...request, includeDeclaration: true }, signal);
		await callHierarchy.prepareCallHierarchy(request, signal);
		await typeHierarchy.prepareTypeHierarchy(request, signal);
		await rename.prepareRename!(request, signal);
		await rename.provideRenameEdits({ ...request, newName: 'newValue' }, signal);
		await formatting.provideDocumentFormattingEdits(model, { tabSize: 4, insertSpaces: true }, CancellationToken.None);
		await rangeFormatting.provideDocumentRangeFormattingEdits(model, model.getFullModelRange(), { tabSize: 4, insertSpaces: true }, CancellationToken.None);
		await signature.provideParameterHints({ ...request, context: { kind: 'invoke' } }, signal);
		await inlay.provideInlayHints(request, signal);
		await linked.provideLinkedEditingRanges(model, request.position, CancellationToken.None);
		await semantic.provideSemanticTokens(request, signal);
		await symbols.provideDocumentSymbols(request, signal);
		await lenses.provideCodeLenses(model, CancellationToken.None);
		await lenses.resolveCodeLens!(model, { range: model.getFullModelRange() }, CancellationToken.None);
		await links.provideLinks(request, signal);
		await colors.provideDocumentColors(request, signal);
		await colors.provideColorPresentations({ ...request, color: { red: 1, green: 0, blue: 0, alpha: 1 } }, signal);
		await folding.provideFoldingRanges(request, signal);
		await workspaceSymbols.provideWorkspaceSymbols('value', signal);
	};
	calls.length = 0;
	await invokeAll(first);
	assert.equal(calls.filter(key => key !== 'servers').length, 26, 'each supported entry reaches its existing API');
	calls.length = 0;
	// Workspace symbols cover every root independently, so retire its supported root
	// before exercising the adapter with a document from an unsupported root.
	notifyFeatures(events, [], 'one');
	await invokeAll(second);
	await invokeAll(first);
	assert.deepEqual(calls.filter(key => key !== 'servers'), [], 'retained providers cannot bypass the live capability check');
});

function createProviders(languages: LanguageFeaturesService, api: FakeLanguageApi, workspace: TestWorkspaceService, options: { workspaceTrust?: IWorkspaceTrustManagementService; events?: FakeServerEvents; } = {}): AppServerLanguageProviders {
	using services = new InstantiationService();
	services.registerInstance(ILanguageFeaturesService, languages);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IConfigurationService, workspace);
	const events = options.events ?? new FakeServerEvents();
	services.registerInstance(IServerEventApi, events);
	services.registerInstance(IWorkspaceTrustManagementService, options.workspaceTrust ?? {
		onDidChangeTrust: Event.None,
		getUriTrustInfo: async () => { throw new Error('Backend-authorized language requests must not inspect host grants'); },
		getWorkspaceTrustInfo: async () => undefined,
	});
	const service = services.createInstance(AppServerLanguageProviders, api, { checkWorkspaceTrust: !!options.workspaceTrust });
	api.onServers = params => {
		if (!api.negotiateCapabilities) return;
		const dirId = params.dirId ?? workspace.getWorkspace().folders[0]?.id;
		for (const server of api.availableServers) {
			const languageIds = server.languageIds.filter(language => !events.capabilityNotifications.some(value => (value.dirId ?? workspace.getWorkspace().folders[0]?.id) === dirId && value.languageIds.includes(language)));
			if (languageIds.length) events.fire({
				method: 'language/serverCapabilities', params: {
					...(dirId ? { dirId } : {}), server: server.id, languageIds, features: [...baselineFeatures], completionTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
				}
			});
		}
	};
	service.start();
	return service;
}

test('optional prepare and resolve capabilities preserve direct rename, lens and link behavior', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'one', uri: URI.file('/one') });
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	let prepared = 0, resolvedLenses = 0, resolvedLinks = 0;
	api.prepareRename = async () => { prepared++; return { preparation: { range: DTO_RANGE, placeholder: 'prepared' } }; };
	api.resolveCodeLens = async request => { resolvedLenses++; return { revision: request.document.revision, lenses: [request.lens] }; };
	api.documentLinks = async request => ({ revision: request.document.revision, links: [{ range: DTO_RANGE, target: null, tooltip: null, providerData: 'unresolved' }] });
	api.resolveDocumentLink = async request => { resolvedLinks++; return { revision: request.document.revision, links: [{ ...request.link, target: 'https://example.com' }] }; };
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	using model = new TextModel('value', { languageId: 'rust', resource: URI.file('/one/main.rs') });
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, 'rust', signal), resource: model.uri, position: new Position(1, 2) };
	const lens = { range: model.getFullModelRange() };
	notifyFeatures(events, ['rename', 'codeLens', 'documentLinks']);
	await tick();
	assert.deepEqual(await languages.renameProvider.ordered(model)[0]!.prepareRename!(request, signal), { range: new Range(1, 1, 1, 6), placeholder: 'value' });
	assert.equal(await languages.codeLensProvider.ordered(model)[0]!.resolveCodeLens!(model, lens, CancellationToken.None), lens);
	assert.deepEqual(await languages.linkProvider.ordered(model)[0]!.provideLinks(request, signal), []);
	assert.deepEqual([prepared, resolvedLenses, resolvedLinks], [0, 0, 0]);
	notifyFeatures(events, ['rename', 'renamePrepare', 'codeLens', 'codeLensResolve', 'documentLinks', 'documentLinkResolve']);
	await tick();
	assert.equal((await languages.renameProvider.ordered(model)[0]!.prepareRename!(request, signal))?.placeholder, 'prepared');
	await languages.codeLensProvider.ordered(model)[0]!.resolveCodeLens!(model, lens, CancellationToken.None);
	const links = await languages.linkProvider.ordered(model)[0]!.provideLinks(request, signal);
	assert.equal(links?.[0]?.target, 'https://example.com');
	assert.deepEqual([prepared, resolvedLenses, resolvedLinks], [1, 1, 1]);
});

test('capability retirement aborts backend operations, ignores late replies and preserves real errors', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'one', uri: URI.file('/one') });
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	let complete!: (value: Awaited<ReturnType<ILanguageApi['hover']>>) => void;
	let requestSignal: AbortSignal | undefined;
	api.hover = (_request, options) => { requestSignal = options?.signal; return new Promise(resolve => { complete = resolve; }); };
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	using model = new TextModel('value', { languageId: 'rust', resource: URI.file('/one/main.rs') });
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, 'rust', signal), resource: model.uri, position: new Position(1, 2) };
	notifyFeatures(events, ['hover']);
	await tick();
	const provider = languages.hoverProvider.ordered(model)[0]!;
	const pending = provider.provideHover(request, signal);
	notifyFeatures(events, []);
	assert.equal(requestSignal?.aborted, true);
	complete({ revision: 1, contents: 'late', range: DTO_RANGE });
	assert.equal(await pending, undefined);
	notifyFeatures(events, ['hover', 'workspaceSymbols']);
	await tick();
	const error = new Error('real language failure');
	api.hover = async () => { throw error; };
	api.directorySymbols = async () => { throw error; };
	await assert.rejects(async () => languages.hoverProvider.ordered(model)[0]!.provideHover(request, signal), candidate => candidate === error);
	await assert.rejects(async () => languages.workspaceSymbolProvider.allNoModel()[0]!.provideWorkspaceSymbols('value', signal), candidate => candidate === error);
});

test('language providers require the scoped trust registration even when the backend authorizes Web requests', () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'empty' });
	using languages = new LanguageFeaturesService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(ILanguageFeaturesService, languages);
	services.registerInstance(IServerEventApi, new FakeServerEvents());
	assert.throws(() => services.createInstance(AppServerLanguageProviders, {} as ILanguageApi, { checkWorkspaceTrust: false }), /Unknown service: workspaceTrustManagementService/);
});

const baselineFeatures: readonly LanguageServerFeatureDto[] = ['hover', 'completion', 'completionResolve', 'executeCommand', 'declaration', 'definition', 'implementation', 'typeDefinition', 'references', 'callHierarchy', 'typeHierarchy', 'workspaceSymbols', 'rename', 'renamePrepare', 'documentFormatting', 'rangeFormatting', 'signatureHelp', 'inlayHints', 'linkedEditingRanges', 'semanticTokens', 'documentSymbols', 'codeLens', 'codeLensResolve', 'documentLinks', 'documentLinkResolve', 'foldingRanges'];

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
	events.fire({ method: 'language/serverCapabilities', params: { server: 'fixture', languageIds: ['rust'], features: [...baselineFeatures], completionTriggerCharacters: ['.'], signatureHelpTriggerCharacters: ['('], signatureHelpRetriggerCharacters: [','] } });
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
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	notifyCodeActions(events, 'typescript', true, true);
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

function notifyCodeActions(events: FakeServerEvents, language: string, codeActions: boolean, codeActionResolve: boolean, dirId?: string): void {
	events.fire({
		method: 'language/serverCapabilities', params: {
			...(dirId ? { dirId } : {}), server: 'fixture', languageIds: [language], features: [...baselineFeatures, ...(codeActions ? ['codeActions' as const] : []), ...(codeActionResolve ? ['codeActionResolve' as const] : [])],
			completionTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
		}
	});
}

test('code actions and resolve follow negotiated capabilities and directory lifecycle', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({
		id: 'actions', folders: [
			{ id: 'one', name: 'one', uri: URI.file('/one'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/two'), index: 1 },
		]
	});
	const api = new FakeLanguageApi();
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	using first = new TextModel('value', { resource: URI.file('/one/main.ts'), languageId: 'typescript' });
	using second = new TextModel('value', { resource: URI.file('/two/main.ts'), languageId: 'typescript' });
	const signal = new AbortController().signal;
	const request = (model: TextModel) => ({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri, range: model.getFullModelRange(), diagnostics: [] });
	await tick();
	assert.equal(languages.codeActionProvider.has(first), false);
	notifyCodeActions(events, 'typescript', true, false, 'one');
	notifyCodeActions(events, 'typescript', false, false, 'two');
	await tick();
	assert.equal(languages.codeActionProvider.has(first), true);
	assert.equal(languages.codeActionProvider.has(second), false);
	const provider = languages.codeActionProvider.ordered(first)[0]!;
	const actions = await provider.provideCodeActions(request(first), signal);
	assert.ok(Array.isArray(actions));
	const action = actions[0]!;
	assert.equal(await provider.resolveCodeAction!(action, request(first), signal), action);
	assert.equal(api.resolvedCodeActions, 0);
	assert.deepEqual(await provider.provideCodeActions(request(second), signal), []);
	assert.equal(api.codeActionRequests.length, 1);
	notifyCodeActions(events, 'typescript', true, true, 'one');
	await tick();
	await languages.codeActionProvider.ordered(first)[0]!.resolveCodeAction!(action, request(first), signal);
	assert.equal(api.resolvedCodeActions, 1);
	notifyCodeActions(events, 'typescript', false, false, 'one');
	assert.deepEqual(await provider.provideCodeActions(request(first), signal), []);
	assert.equal(await provider.resolveCodeAction!(action, request(first), signal), action);
	await tick();
	assert.equal(languages.codeActionProvider.has(first), false);
	assert.equal(api.codeActionRequests.length, 1);
	notifyCodeActions(events, 'typescript', true, true, 'one');
	await tick();
	events.fire({ method: 'language/serverState', params: { dirId: 'one', server: 'fixture', state: { type: 'starting' } } });
	await tick();
	assert.equal(languages.codeActionProvider.has(first), false);
});

test('code actions discard responses from retired capabilities and still report real failures', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'actions', uri: URI.file('/project') });
	const api = new FakeLanguageApi();
	const events = new FakeServerEvents();
	using providers = createProviders(languages, api, workspace, { events });
	notifyCodeActions(events, 'typescript', true, true);
	await tick();
	using model = new TextModel('value', { resource: URI.file('/project/main.ts'), languageId: 'typescript' });
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri, range: model.getFullModelRange(), diagnostics: [] };
	const provider = languages.codeActionProvider.ordered(model)[0]!;
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const codeActions = api.codeActions.bind(api);
	api.codeActions = async params => { await blocked; return codeActions(params); };
	const pending = provider.provideCodeActions(request, signal);
	notifyCodeActions(events, 'typescript', false, false);
	release();
	assert.deepEqual(await pending, []);
	notifyCodeActions(events, 'typescript', true, true);
	const error = new Error('real code action failure');
	api.codeActions = async () => { throw error; };
	await assert.rejects(async () => provider.provideCodeActions(request, signal), candidate => candidate === error);
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
	readonly capabilityNotifications: Extract<ServerNotification, { method: 'language/serverCapabilities'; }>['params'][] = [];
	private listener: ((event: ServerNotification) => void) | undefined;
	subscribe(listener: (event: ServerNotification) => void) { this.listener = listener; return { dispose: () => { this.listener = undefined; } }; }
	fire(event: ServerNotification): void { if (event.method === 'language/serverCapabilities') this.capabilityNotifications.push(event.params); this.listener?.(event); }
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
	negotiateCapabilities = true;
	onServers: (params: Parameters<ILanguageApi['servers']>[0]) => void = () => { };
	async save(_params: Parameters<ILanguageApi['save']>[0]): Promise<void> { }

	availableServers = [
		{ id: "typescript", languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
		{ id: "rust", languageIds: ["rust"] },
		{ id: "json", languageIds: ["json", "jsonc"] },
		{ id: "shell", languageIds: ["shellscript"] },
	];
	async servers(params: Parameters<ILanguageApi["servers"]>[0]): ReturnType<ILanguageApi["servers"]> { this.onServers(params); return { servers: this.availableServers }; }

	readonly locationRequests: Parameters<ILanguageApi["locations"]>[0][] = [];
	readonly codeActionRequests: Parameters<ILanguageApi["codeActions"]>[0][] = [];
	resolvedCodeActions = 0;
	readonly workspaceSymbolLanguages: string[] = [];
	readonly hoverRequests: Parameters<ILanguageApi["hover"]>[0][] = [];
	readonly completionRequests: Parameters<ILanguageApi["completions"]>[0][] = [];
	readonly executeCommandRequests: Parameters<ILanguageApi["executeCommand"]>[0][] = [];
	readonly documentFormattingRequests: Parameters<ILanguageApi["formatDocument"]>[0][] = [];
	readonly rangeFormattingRequests: Parameters<ILanguageApi["formatRange"]>[0][] = [];
	readonly signatureHelpRequests: Parameters<ILanguageApi["signatureHelp"]>[0][] = [];
	readonly documentColorRequests: Parameters<ILanguageApi['documentColors']>[0][] = [];
	readonly colorPresentationRequests: Parameters<ILanguageApi['colorPresentations']>[0][] = [];
	documentColorsError: Error | undefined;

	async synchronize(): Promise<void> { }
	async close(): Promise<void> { }

	async hover(params: Parameters<ILanguageApi["hover"]>[0], _options?: Parameters<ILanguageApi['hover']>[1]): ReturnType<ILanguageApi["hover"]> {
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
	async documentColors(params: Parameters<ILanguageApi["documentColors"]>[0]): ReturnType<ILanguageApi["documentColors"]> {
		this.documentColorRequests.push(params);
		if (this.documentColorsError) throw this.documentColorsError;
		return { revision: params.document.revision, colors: [{ range: DTO_RANGE, color: { red: 255, green: 128, blue: 0, alpha: 255 } }] };
	}
	async colorPresentations(params: Parameters<ILanguageApi["colorPresentations"]>[0]): ReturnType<ILanguageApi["colorPresentations"]> {
		this.colorPresentationRequests.push(params);
		return { revision: params.document.revision, presentations: [] };
	}
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
		this.resolvedCodeActions += 1;
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
		method: 'language/serverCapabilities', params: { server: 'fixture', languageIds: ['rust'], features: [...baselineFeatures], completionTriggerCharacters, signatureHelpTriggerCharacters, signatureHelpRetriggerCharacters },
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

test('document colors require negotiated support in the exact directory and retire with the server', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({
		id: 'colors', folders: [
			{ id: 'first', name: 'first', uri: URI.file('/first'), index: 0 },
			{ id: 'second', name: 'second', uri: URI.file('/second'), index: 1 },
		]
	});
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace, { events });
	using first = new TextModel('paint', { languageId: 'rust', resource: URI.file('/first/main.rs') });
	using second = new TextModel('paint', { languageId: 'rust', resource: URI.file('/second/main.rs') });
	using history = new TextModel('paint', { languageId: 'rust', resource: URI.parse('git:/first/main.rs') });
	const signal = new AbortController().signal;
	const request = (model: TextModel) => ({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri });
	const notify = (dirId: string, documentColors: boolean) => events.fire({
		method: 'language/serverCapabilities', params: {
			dirId, server: 'fixture', languageIds: ['rust'], features: documentColors ? ['documentColors'] : [],
			completionTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
		}
	});
	await tick();
	assert.equal(languages.colorProvider.has(first), false, 'configuration is not a negotiated capability');
	notify('second', false);
	notify('first', true);
	await tick();
	assert.equal(languages.colorProvider.has(first), true);
	assert.equal(languages.colorProvider.has(second), false);
	assert.equal(languages.colorProvider.has(history), false);
	const provider = languages.colorProvider.ordered(first)[0]!;
	const colors = await provider.provideDocumentColors(request(first), signal);
	assert.deepEqual(colors, [{ range: new Range(1, 1, 1, 6), color: { red: 1, green: 128 / 255, blue: 0, alpha: 1 } }]);
	await provider.provideColorPresentations({ ...request(first), range: new Range(1, 1, 1, 2), color: colors![0]!.color }, signal);
	assert.equal(api.documentColorRequests[0]!.document.dirId, 'first');
	assert.equal(api.colorPresentationRequests.length, 1);
	assert.deepEqual(await provider.provideDocumentColors(request(second), signal), []);
	assert.equal(api.documentColorRequests.length, 1, 'another directory must not reach the RPC');
	notify('first', false);
	assert.deepEqual(await provider.provideDocumentColors(request(first), signal), [], 'revocation also applies to retained adapters before refresh');
	assert.deepEqual(await provider.provideColorPresentations({ ...request(first), range: new Range(1, 1, 1, 2), color: colors![0]!.color }, signal), []);
	await tick();
	assert.equal(languages.colorProvider.has(first), false);
	notify('first', true);
	await tick();
	events.fire({ method: 'language/serverState', params: { dirId: 'first', server: 'fixture', state: { type: 'backingOff', attempt: 1, retryAfterMillis: 10 } } });
	await tick();
	assert.equal(languages.colorProvider.has(first), false);
	events.fire({ method: 'language/serverState', params: { dirId: 'first', server: 'fixture', state: { type: 'ready' } } });
	await tick();
	assert.equal(languages.colorProvider.has(first), false, 'restart needs a fresh capability snapshot');
	notify('first', true);
	await tick();
	assert.equal(languages.colorProvider.has(first), true);
	providers.dispose();
	assert.equal(languages.colorProvider.has(first), false);
	assert.deepEqual(await provider.provideDocumentColors(request(first), signal), []);
	assert.equal(api.documentColorRequests.length, 1);
	assert.equal(api.colorPresentationRequests.length, 1);
});

test('a negotiated color provider preserves real language request errors', async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new TestWorkspaceService({ id: 'colors', uri: URI.file('/project') });
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using providers = createProviders(languages, api, workspace, { events });
	events.fire({ method: 'language/serverCapabilities', params: { server: 'fixture', languageIds: ['rust'], features: ['documentColors'], completionTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [] } });
	await tick();
	using model = new TextModel('paint', { languageId: 'rust', resource: URI.file('/project/main.rs') });
	const signal = new AbortController().signal;
	api.documentColorsError = new Error('LanguageRequestFailed');
	await assert.rejects(async () => languages.colorProvider.ordered(model)[0]!.provideDocumentColors({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri }, signal), api.documentColorsError);
});
