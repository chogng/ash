import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageDiagnosticSeverity } from "../../../../../editor/common/languages/languageResults.js";
import { createLanguageCompletionInvokeContext } from "../../../../../editor/common/languages/completion/languageCompletionProviders.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { LanguageCompletionService } from '../../../../../editor/common/languages/completion/languageCompletionService.js';
import { WorkspaceSymbolService } from '../../../../../editor/common/languages/workspaceSymbols.js';
import { CodeActionService } from '../../../../../editor/contrib/codeAction/common/languageCodeActions.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages/languageFeatureRequest.js';
import { LanguageNavigationService } from '../../../../../editor/contrib/gotoSymbol/common/languageNavigation.js';
import { LanguageHoverService } from '../../../../../editor/contrib/hover/common/hover.js';
import { InlayHintsService } from '../../../../../editor/contrib/inlayHints/common/languageInlayHints.js';
import { ParameterHintsService } from '../../../../../editor/contrib/parameterHints/common/languageParameterHints.js';
import { RenameService } from '../../../../../editor/contrib/rename/common/languageRename.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { type ILanguageApi } from "../../../../../platform/language/common/languageApi.js";
import { type IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import { type IDirPermissionsService } from "../../../../../platform/dirPermissions/common/dirPermissionsService.js";
import type { PermissionDto } from "../../../../../../../generated/app-server/index.js";
import { WorkspaceContextService } from "../../../workspaces/browser/workspaceContextService.js";
import { AppServerLanguageProviders } from "../../browser/appServerLanguageProviders.js";
import { type ServerNotification } from "../../../../../../../generated/app-server/index.js";

const DTO_RANGE = Object.freeze({ start: Object.freeze({ lineIndex: 0, columnIndex: 0 }), end: Object.freeze({ lineIndex: 0, columnIndex: 5 }) });

function createNavigationService(languages: LanguageFeaturesService, model: TextModel, resource: URI): LanguageNavigationService {
	return new LanguageNavigationService(model, resource, {
		definitions: languages.definitionProvider,
		declarations: languages.declarationProvider,
		implementations: languages.implementationProvider,
		typeDefinitions: languages.typeDefinitionProvider,
		references: languages.referenceProvider,
	});
}

test("App Server language providers map cross-resource locations without double-encoding paths", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	using model = new TextModel("value", { languageId: "typescript" });
	using navigation = createNavigationService(languages, model, URI.file("C:\\project\\main file.ts"));

	const locations = await navigation.provideDefinition("typescript", new Position((0) + 1, (2) + 1));

	assert.equal(api.locationRequests.length, 1);
	assert.equal(api.locationRequests[0]!.document.path, "main file.ts");
	assert.equal(api.locationRequests[0]!.document.text, "value");
	assert.deepEqual(api.locationRequests[0]!.position, { lineIndex: 0, columnIndex: 2 });
	assert.equal(locations[0]!.resource.toString(), "file:///C:/project/src/with%20space.ts");
	assert.equal(locations[0]!.selectionRange!.endColumn, 6);
});

test("App Server language providers route resources through their owning Workspace folder", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({
		id: "multi-root",
		folders: [
			{ id: "frontend", uri: URI.file("C:\\frontend"), name: "frontend", index: 0 },
			{ id: "backend", uri: URI.file("C:\\backend"), name: "backend", index: 1 },
		],
		configuration: URI.file("C:\\project.code-workspace"),
	});
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	using model = new TextModel("value", { languageId: "typescript" });
	using navigation = createNavigationService(languages, model, URI.file("C:\\backend\\main.ts"));

	const locations = await navigation.provideDefinition("typescript", new Position((0) + 1, (2) + 1));

	assert.equal(api.locationRequests[0]!.document.dirId, "backend");
	assert.equal(api.locationRequests[0]!.document.path, "main.ts");
	assert.equal(locations[0]!.resource.toString(), "file:///C:/backend/src/with%20space.ts");
});

test("App Server workspace symbols query every supported Code language and deduplicate results", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	using symbols = new WorkspaceSymbolService(languages.workspaceSymbolProvider);

	const result = await symbols.provideWorkspaceSymbols("answer");

	assert.deepEqual(api.workspaceSymbolLanguages.sort(), ["javascript", "javascriptreact", "json", "jsonc", "rust", "shell", "typescript", "typescriptreact"]);
	assert.equal(result.length, 1);
	assert.equal(result[0]!.resource.toString(), "file:///C:/project/src/with%20space.ts");
});

test("App Server hover and completion providers keep revision, resource, and insertion semantics", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	const resource = URI.file("C:\\project\\main.rs");
	using model = new TextModel("pri", { languageId: "rust", resource });
	using hover = new LanguageHoverService(model, languages.hoverProvider, resource);
	using completions = new LanguageCompletionService(model, languages.completionProvider, { resource });
	using parameterHints = new ParameterHintsService(model, languages.signatureHelpProvider, resource);
	using inlayHints = new InlayHintsService(model, languages.inlayHintsProvider, resource);

	const hoverResult = await hover.provideHover("rust", new Position((0) + 1, (1) + 1));
	await completions.request("rust", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	const completionResult = completions.results.result!;
	const completionItem = completionResult.value.items[0]!;
	const resolved = await completions.resolveCompletionItem({ completionRequestId: completionResult.requestId, modelVersion: completionResult.modelVersion, providerId: completionItem.providerId, itemId: completionItem.id }, new AbortController().signal);
	await completions.executeCompletionCommand("rust", completionItem, new AbortController().signal);
	const hints = await parameterHints.provideParameterHints("rust", new Position((0) + 1, (3) + 1), { kind: "triggerCharacter", triggerCharacter: "(" });
	const inlays = await inlayHints.provideInlayHints("rust", Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)));
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
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	using model = new TextModel("value", { languageId: "typescript" });
	const resource = URI.file("C:\\project\\main.ts");
	using rename = new RenameService(model, resource, languages.renameProvider);
	using actions = new CodeActionService(model, resource, languages.codeActionProvider);

	const preparation = await rename.prepareRename("typescript", new Position((0) + 1, (2) + 1));
	const edit = await rename.provideRenameEdits("typescript", new Position((0) + 1, (2) + 1), "renamed");
	const available = await actions.provideCodeActions("typescript", Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), severity: LanguageDiagnosticSeverity.Warning, message: "demo", source: "test" }]);

	assert.equal(preparation?.placeholder, "value");
	assert.equal(edit.entries[0]!.kind, "create");
	assert.equal(edit.entries[1]!.kind, "textDocument");
	assert.equal(available[0]!.edit?.entries[0]!.kind, "rename");
	assert.equal(api.codeActionRequests[0]!.diagnostics[0]!.severity, "warning");
});

test("App Server formatting providers preserve snapshot, options, range, and edits", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	using model = new TextModel("value", { languageId: "typescript" });
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, 'typescript', signal), resource: URI.file('C:\\project\\main.ts') };

	const documentEdits = await languages.documentFormattingEditProvider.ordered(model)[0]!.provideDocumentFormattingEdits!({ ...request, options: { tabSize: 2, insertSpaces: true } }, signal);
	const rangeEdits = await languages.documentRangeFormattingEditProvider.ordered(model)[0]!.provideRangeFormattingEdits!({ ...request, range: new Range(1, 1, 1, 6), options: { tabSize: 4, insertSpaces: false, trimTrailingWhitespace: true } }, signal);

	assert.equal(api.documentFormattingRequests[0]!.document.path, "main.ts");
	assert.deepEqual(api.documentFormattingRequests[0]!.options, { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: null });
	assert.deepEqual(api.rangeFormattingRequests[0]!.range, DTO_RANGE);
	assert.equal(documentEdits[0]!.text, "formatted");
	assert.equal(Range.lift(rangeEdits[0]!.range).getEndPosition().column, 6);
});

test("App Server language providers do not send documents above their transport limit", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	using providers = new AppServerLanguageProviders(languages, api, workspace);
	using model = new TextModel("界".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3)), { languageId: "typescript" });
	using navigation = createNavigationService(languages, model, URI.file("C:\\project\\large.ts"));

	assert.deepEqual(await navigation.provideDefinition("typescript", new Position((0) + 1, (0) + 1)), []);
	assert.equal(api.locationRequests.length, 0);
});

test("App Server language providers register only while directory permissions allow execution", async () => {
	using languages = new LanguageFeaturesService();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	const api = new FakeLanguageApi();
	const events = new FakeServerEvents();
	const permissions = new FakeDirPermissionsService("workspace", []);
	using providers = new AppServerLanguageProviders(languages, api, workspace, { dirPermissions: permissions, events });
	using model = new TextModel("value", { languageId: "typescript" });
	using navigation = createNavigationService(languages, model, URI.file("C:\\project\\main.ts"));

	await tick();
	assert.deepEqual(await navigation.provideDefinition("typescript", new Position((0) + 1, (2) + 1)), []);
	assert.equal(api.locationRequests.length, 0);

	permissions.value = ["executeCommands", "useLanguageServices"];
	events.fire({ method: "config/changed", params: { revision: 2, generation: 2 } });
	await tick();
	assert.equal((await navigation.provideDefinition("typescript", new Position((0) + 1, (2) + 1))).length, 1);
	assert.equal(api.locationRequests.length, 1);

	permissions.value = [];
	events.fire({ method: "config/changed", params: { revision: 3, generation: 3 } });
	await tick();
	assert.deepEqual(await navigation.provideDefinition("typescript", new Position((0) + 1, (2) + 1)), []);
	assert.equal(api.locationRequests.length, 1);
});

class FakeServerEvents implements IServerEventApi {
	private listener: ((event: ServerNotification) => void) | undefined;
	subscribe(listener: (event: ServerNotification) => void) { this.listener = listener; return { dispose: () => { this.listener = undefined; } }; }
	fire(event: ServerNotification): void { this.listener?.(event); }
}

class FakeDirPermissionsService implements IDirPermissionsService {
	constructor(private readonly dir: string, public value: readonly PermissionDto[]) {}
	async list() { return { revision: 1, entries: [{ dir: this.dir, path: "C:\\project", permissions: this.value }] }; }
	async read(): ReturnType<IDirPermissionsService["read"]> { return this.value; }
	async set(): ReturnType<IDirPermissionsService["set"]> { throw new Error("unused"); }
	async forget(): ReturnType<IDirPermissionsService["forget"]> { throw new Error("unused"); }
}

async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

class FakeLanguageApi implements ILanguageApi {
	readonly locationRequests: Parameters<ILanguageApi["locations"]>[0][] = [];
	readonly codeActionRequests: Parameters<ILanguageApi["codeActions"]>[0][] = [];
	readonly workspaceSymbolLanguages: string[] = [];
	readonly hoverRequests: Parameters<ILanguageApi["hover"]>[0][] = [];
	readonly completionRequests: Parameters<ILanguageApi["completions"]>[0][] = [];
	readonly executeCommandRequests: Parameters<ILanguageApi["executeCommand"]>[0][] = [];
	readonly documentFormattingRequests: Parameters<ILanguageApi["formatDocument"]>[0][] = [];
	readonly rangeFormattingRequests: Parameters<ILanguageApi["formatRange"]>[0][] = [];
	readonly signatureHelpRequests: Parameters<ILanguageApi["signatureHelp"]>[0][] = [];

	async synchronize(): Promise<void> {}
	async close(): Promise<void> {}

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
		return { entries: [
			{ kind: "create", path: "created.ts", existing: "error" },
			{ kind: "textDocument", document: { path: "main.ts", expectedText: "value", edits: [{ range: DTO_RANGE, newText: "renamed" }] } },
		] };
	}

	async codeActions(params: Parameters<ILanguageApi["codeActions"]>[0]): ReturnType<ILanguageApi["codeActions"]> {
		this.codeActionRequests.push(params);
		return { actions: [{ title: "Move file", kind: "refactor.move", isPreferred: true, disabledReason: null, edit: { entries: [{ kind: "rename", source: "main.ts", target: "moved.ts", existing: "error" }] }, providerData: { id: 1 } }] };
	}

	async resolveCodeAction(): ReturnType<ILanguageApi["resolveCodeAction"]> {
		return { title: "Resolved", kind: null, isPreferred: false, disabledReason: null, edit: null, providerData: null };
	}
}
