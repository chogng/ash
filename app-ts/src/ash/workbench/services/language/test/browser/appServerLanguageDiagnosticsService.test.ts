import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageDiagnosticSeverity } from '../../../../../editor/common/languages.js';
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { type IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import { AppServerRemoteError } from "../../../../../platform/app-server/common/appServerError.js";
import { type ILanguageApi } from "../../../../../platform/language/common/languageApi.js";
import { type IDirPermissionsService } from "../../../../../platform/dirPermissions/common/dirPermissionsService.js";
import { type PermissionDto, type ServerNotification } from '../../../../../platform/app-server/common/generated/index.js';
import { WorkspaceContextService } from "../../../workspaces/browser/workspaceContextService.js";
import { type CodeIntelligenceDocumentSnapshot, type ICodeIntelligenceDocumentService } from "../../../codeIntelligence/common/codeIntelligenceDocumentService.js";
import { AppServerLanguageDiagnosticsService } from "../../browser/appServerLanguageDiagnosticsService.js";

test("App Server diagnostics service synchronizes, filters revisions, and closes once", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	const documents = new FakeCodeIntelligenceDocuments();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace, documents);
	using model = new TextModel("fn main() {}\n");
	const resource = URI.file("C:\\project\\main.rs");
	using first = service.acquire(resource, "rust", model);
	using second = service.acquire(resource, "rust", model);
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.diagnosticPulls.length, 1);
	assert.equal(api.synchronized[0]!.document.path, "main.rs");
	assert.deepEqual(documents.synchronized, api.synchronized.map(request => request.document));

	events.fire({ method: "language/diagnostics", params: { path: "main.rs", revision: 1, diagnostics: [{ range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } }, severity: "error", message: "broken", code: "E1", source: "fixture" }] } });
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]!.message, "broken");
	using publisher = service.createPublisher(resource);
	publisher.update(1, [{ range: Range.fromPositions(new Position((0) + 1, (3) + 1), new Position((0) + 1, (7) + 1)), severity: LanguageDiagnosticSeverity.Error, message: "broken", code: "E1", source: "fixture" }]);
	assert.equal(service.getDiagnostics(resource)?.diagnostics.length, 1);
	assert.equal(service.getAllDiagnostics().length, 1);
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "// " }]);
	assert.equal(service.getDiagnostics(resource)?.revision, 1);
	publisher.update(2, [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)), severity: LanguageDiagnosticSeverity.Warning, message: "local warning", source: "syntax" }]);
	assert.equal(service.getDiagnostics(resource)?.revision, 2);
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]!.message, "local warning");

	events.fire({ method: "language/diagnostics", params: { path: "main.rs", revision: 0, diagnostics: [] } });
	assert.equal(service.getDiagnostics(resource)?.revision, 2);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(api.synchronized.at(-1)!.document.revision, 2);
	second.dispose();
	await tick();
	assert.equal(api.closed.length, 0);
	first.dispose();
	await tick();
	assert.deepEqual(api.closed, [{ path: "main.rs" }]);
	assert.deepEqual(documents.closed, api.closed.map(request => request.path));
	assert.equal(service.getAllDiagnostics().length, 1);
	publisher.dispose();
	assert.equal(service.getAllDiagnostics().length, 0);
});

test("App Server diagnostics keep equal relative paths isolated by Workspace folder", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using workspace = new WorkspaceContextService({
		id: "multi-root",
		folders: [
			{ id: "one", uri: URI.file("C:\\one"), name: "one", index: 0 },
			{ id: "two", uri: URI.file("C:\\two"), name: "two", index: 1 },
		],
		configuration: URI.file("C:\\project.code-workspace"),
	});
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace);
	using model = new TextModel("fn second() {}\n");
	const resource = URI.file("C:\\two\\main.rs");
	using acquisition = service.acquire(resource, "rust", model);
	await tick();

	assert.equal(api.synchronized[0]!.document.dirId, "two");
	events.fire({ method: "language/diagnostics", params: { dirId: "two", path: "main.rs", revision: 1, diagnostics: [{ range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 9 } }, severity: "warning", message: "second root", code: null, source: "fixture" }] } });
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, "second root");
});

test('App Server diagnostics synchronize Shell documents using the grammar language identity', async () => {
	const api = new FakeLanguageApi();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/project') });
	using service = new AppServerLanguageDiagnosticsService(api, new FakeServerEvents(), workspace);
	using model = new TextModel('echo hello', { languageId: 'shellscript' });
	using acquisition = service.acquire(URI.file('/project/main.sh'), 'shellscript', model);
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.synchronized[0]!.document.languageId, 'shellscript');
	assert.equal(api.diagnosticPulls.length, 1);
});

class FakeServerEvents implements IServerEventApi {
	private listener: ((event: ServerNotification) => void) | undefined;
	subscribe(listener: (event: ServerNotification) => void) { this.listener = listener; return { dispose: () => { this.listener = undefined; } }; }
	fire(event: ServerNotification): void { this.listener?.(event); }
}

class FakeCodeIntelligenceDocuments implements ICodeIntelligenceDocumentService {
	readonly synchronized: CodeIntelligenceDocumentSnapshot[] = [];
	readonly closed: string[] = [];
	async synchronize(document: CodeIntelligenceDocumentSnapshot) { this.synchronized.push(document); }
	async close(path: string) { this.closed.push(path); }
}

class FakeLanguageApi implements ILanguageApi {
	availableServers = [
		{ id: "typescript", languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
		{ id: "rust", languageIds: ["rust"] },
		{ id: "json", languageIds: ["json", "jsonc"] },
		{ id: "shell", languageIds: ["shell"] },
	];
	async servers(): ReturnType<ILanguageApi["servers"]> { return { servers: this.availableServers }; }

	readonly synchronized: Parameters<ILanguageApi["synchronize"]>[0][] = [];
	readonly closed: Parameters<ILanguageApi["close"]>[0][] = [];
	readonly diagnosticPulls: Parameters<ILanguageApi["documentDiagnostics"]>[0][] = [];
	documentDiagnosticsError: Error | undefined;
	workspaceDiagnosticPulls = 0;
	directoryDiagnosticsError: Error | undefined;
	workspaceReport: Awaited<ReturnType<ILanguageApi["directoryDiagnostics"]>> = { supported: false, snapshots: [] };
	async synchronize(params: Parameters<ILanguageApi["synchronize"]>[0]): Promise<void> { this.synchronized.push(params); }
	async close(params: Parameters<ILanguageApi["close"]>[0]): Promise<void> { this.closed.push(params); }
	hover(): ReturnType<ILanguageApi["hover"]> { throw new Error("unused"); }
	completions(): ReturnType<ILanguageApi["completions"]> { throw new Error("unused"); }
	resolveCompletion(): ReturnType<ILanguageApi["resolveCompletion"]> { throw new Error("unused"); }
	executeCommand(): ReturnType<ILanguageApi["executeCommand"]> { throw new Error("unused"); }
	async documentDiagnostics(params: Parameters<ILanguageApi["documentDiagnostics"]>[0]): ReturnType<ILanguageApi["documentDiagnostics"]> { this.diagnosticPulls.push(params); if (this.documentDiagnosticsError) throw this.documentDiagnosticsError; return { revision: params.document.revision, kind: "unchanged", diagnostics: [] }; }
	async directoryDiagnostics(): ReturnType<ILanguageApi["directoryDiagnostics"]> { this.workspaceDiagnosticPulls += 1; if (this.directoryDiagnosticsError) throw this.directoryDiagnosticsError; return this.workspaceReport; }
	formatDocument(): ReturnType<ILanguageApi["formatDocument"]> { throw new Error("unused"); }
	formatRange(): ReturnType<ILanguageApi["formatRange"]> { throw new Error("unused"); }
	signatureHelp(): ReturnType<ILanguageApi["signatureHelp"]> { throw new Error("unused"); }
	inlayHints(): ReturnType<ILanguageApi["inlayHints"]> { throw new Error("unused"); }
	linkedEditingRanges(): ReturnType<ILanguageApi["linkedEditingRanges"]> { throw new Error("unused"); }
	semanticTokens(): ReturnType<ILanguageApi["semanticTokens"]> { throw new Error("unused"); }
	documentSymbols(): ReturnType<ILanguageApi["documentSymbols"]> { throw new Error("unused"); }
	codeLenses(): ReturnType<ILanguageApi["codeLenses"]> { throw new Error("unused"); }
	resolveCodeLens(): ReturnType<ILanguageApi["resolveCodeLens"]> { throw new Error("unused"); }
	documentLinks(): ReturnType<ILanguageApi["documentLinks"]> { throw new Error("unused"); }
	resolveDocumentLink(): ReturnType<ILanguageApi["resolveDocumentLink"]> { throw new Error("unused"); }
	documentColors(): ReturnType<ILanguageApi["documentColors"]> { throw new Error("unused"); }
	colorPresentations(): ReturnType<ILanguageApi["colorPresentations"]> { throw new Error("unused"); }
	foldingRanges(): ReturnType<ILanguageApi["foldingRanges"]> { throw new Error("unused"); }
	locations(): ReturnType<ILanguageApi["locations"]> { throw new Error("unused"); }
	hierarchy(): ReturnType<ILanguageApi["hierarchy"]> { throw new Error("unused"); }
	directorySymbols(): ReturnType<ILanguageApi["directorySymbols"]> { throw new Error("unused"); }
	prepareRename(): ReturnType<ILanguageApi["prepareRename"]> { throw new Error("unused"); }
	rename(): ReturnType<ILanguageApi["rename"]> { throw new Error("unused"); }
	codeActions(): ReturnType<ILanguageApi["codeActions"]> { throw new Error("unused"); }
	resolveCodeAction(): ReturnType<ILanguageApi["resolveCodeAction"]> { throw new Error("unused"); }
}

async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

test("App Server diagnostics service includes unopened workspace reports", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	api.workspaceReport = { supported: true, snapshots: [{ path: "src/unopened.rs", diagnostics: [{ range: { start: { lineIndex: 2, columnIndex: 1 }, end: { lineIndex: 2, columnIndex: 4 } }, severity: "warning", message: "workspace warning", code: null, source: "fixture" }] }] };
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace);
	await tick();
	await tick();
	const resource = URI.file("C:\\project\\src\\unopened.rs");
	assert.equal(service.getDiagnostics(resource)?.revision, 0);
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, "workspace warning");
	assert.equal(service.getAllDiagnostics().length, 1);

	using model = new TextModel("fn open() {}\n");
	using acquisition = service.acquire(resource, "rust", model);
	await tick();
	assert.equal(service.getDiagnostics(resource), undefined);
});

test("App Server diagnostics service treats typed unavailable pulls as unsupported", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	api.documentDiagnosticsError = new AppServerRemoteError(-32000, "Language request failed", { kind: "LanguageRequestFailed" });
	api.directoryDiagnosticsError = new AppServerRemoteError(-32000, "Language service unavailable", { kind: "LanguageServiceUnavailable" });
	const reported: unknown[][] = [];
	const originalConsoleError = console.error;
	console.error = (...arguments_: unknown[]) => reported.push(arguments_);
	try {
		using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
		using service = new AppServerLanguageDiagnosticsService(api, events, workspace);
		using model = new TextModel("fn main() {}\n");
		using acquisition = service.acquire(URI.file("C:\\project\\main.rs"), "rust", model);
		await tick();
		await tick();

		assert.equal(api.diagnosticPulls.length, 1);
		assert.ok(api.workspaceDiagnosticPulls > 0);
		assert.deepEqual(reported, []);
	} finally {
		console.error = originalConsoleError;
	}
});

test("App Server diagnostics service waits for a workspace folder before pulling workspace diagnostics", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using workspace = new WorkspaceContextService({ id: "empty-window" });
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace);

	await tick();
	assert.equal(api.workspaceDiagnosticPulls, 0);

	workspace.updateWorkspace({ id: "workspace", uri: URI.file("C:\\project") });
	await tick();
	await tick();
	assert.ok(api.workspaceDiagnosticPulls > 0);
});

test("App Server diagnostics service gates Editor synchronization on directory permissions and replays open models after access is allowed", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	const permissions = new FakeDirPermissionsService("workspace", []);
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:\\project") });
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace, undefined, permissions);
	using model = new TextModel("fn main() {}\n");
	using acquisition = service.acquire(URI.file("C:\\project\\main.rs"), "rust", model);

	await tick();
	await tick();
	assert.equal(api.synchronized.length, 0);
	assert.equal(api.workspaceDiagnosticPulls, 0);

	permissions.value = ["executeCommands", "useLanguageServices"];
	events.fire({ method: "config/changed", params: { revision: 2, generation: 2 } });
	await tick();
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.synchronized[0]!.document.path, "main.rs");
	assert.ok(api.workspaceDiagnosticPulls > 0);

	permissions.value = [];
	events.fire({ method: "config/changed", params: { revision: 3, generation: 3 } });
	await tick();
	await tick();
	const synchronizedBeforeEdit = api.synchronized.length;
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "// " }]);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(api.synchronized.length, synchronizedBeforeEdit);
});

class FakeDirPermissionsService implements IDirPermissionsService {
	constructor(private readonly dir: string, public value: readonly PermissionDto[]) {}
	async list() { return { revision: 1, entries: [{ dir: this.dir, path: "C:\\project", permissions: this.value }] }; }
	async read(): ReturnType<IDirPermissionsService["read"]> { return this.value; }
	async set(): ReturnType<IDirPermissionsService["set"]> { throw new Error("unused"); }
	async forget(): ReturnType<IDirPermissionsService["forget"]> { throw new Error("unused"); }
}

test("installing a language server synchronizes an already open document and uninstall stops it", async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [];
	const events = new FakeServerEvents();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("/project") });
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace);
	using model = new TextModel("value = 1", { languageId: "python" });
	using acquisition = service.acquire(URI.file("/project/main.py"), "python", model);
	await tick();
	assert.equal(api.synchronized.length, 0);
	api.availableServers = [{ id: "pyright", languageIds: ["python"] }];
	events.fire({ method: "marketplace/changed", params: { instanceId: "test", generation: 2 } });
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.synchronized[0]!.document.languageId, "python");
	api.availableServers = [];
	events.fire({ method: "marketplace/changed", params: { instanceId: "test", generation: 3 } });
	await tick();
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: "# comment\n" }]);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(api.synchronized.length, 1);
});


test("uninstall discards pending workspace diagnostic reports and late server notifications", async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [{ id: "pyright", languageIds: ["python"] }];
	let complete!: (report: Awaited<ReturnType<ILanguageApi["directoryDiagnostics"]>>) => void;
	api.directoryDiagnostics = () => new Promise(resolve => { complete = resolve; });
	const events = new FakeServerEvents();
	using workspace = new WorkspaceContextService({ id: "workspace", uri: URI.file("/project") });
	using service = new AppServerLanguageDiagnosticsService(api, events, workspace);
	await tick();
	api.availableServers = [];
	events.fire({ method: "marketplace/changed", params: { instanceId: "test", generation: 2 } });
	await tick();
	const diagnostic = { range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } }, severity: "error" as const, message: "removed server", code: null, source: "pyright" };
	complete({ supported: true, snapshots: [{ path: "main.py", diagnostics: [diagnostic] }] });
	await tick();
	assert.deepEqual(service.getAllDiagnostics(), []);
	using model = new TextModel("x", { languageId: "python" });
	using acquisition = service.acquire(URI.file("/project/main.py"), "python", model);
	events.fire({ method: "language/diagnostics", params: { path: "main.py", revision: 1, diagnostics: [diagnostic] } });
	assert.deepEqual(service.getAllDiagnostics(), []);
});
