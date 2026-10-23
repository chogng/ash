import { ITextFileService } from '../../../textfile/common/textfiles.js';
import type { ITextFileSaveEvent } from '../../../textfile/common/textFileService.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Emitter, Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageDiagnosticSeverity } from '../../../../../editor/common/languages.js';
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { AppServerRemoteError } from "../../../../../platform/agentHost/common/appServerError.js";
import { type ILanguageApi } from "../../../../../platform/language/common/languageApi.js";
import { IWorkspaceTrustManagementService, type WorkspaceTrustPermission } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { type ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { TestWorkspaceService } from "../../../configuration/test/common/testServices.js";
import { type CodeIntelligenceDocumentSnapshot, type ICodeIntelligenceDocumentService } from "../../../codeIntelligence/common/codeIntelligenceDocumentService.js";
import { AppServerLanguageDiagnosticsService } from "../../browser/appServerLanguageDiagnosticsService.js";

function createDiagnosticsService(api: FakeLanguageApi, events: FakeServerEvents, workspace: TestWorkspaceService, documents?: ICodeIntelligenceDocumentService, trust?: IWorkspaceTrustManagementService, saves: Event<ITextFileSaveEvent> = Event.None): AppServerLanguageDiagnosticsService {
	using services = new InstantiationService();
	services.registerInstance(IServerEventApi, events);
	services.registerInstance(ITextFileService, { onDidSave: saves, onDidChangeFiles: Event.None, resolve: async () => { throw new Error('unexpected resolve'); }, save: async () => { throw new Error('unexpected save'); } });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IConfigurationService, workspace);
	services.registerInstance(IWorkspaceTrustManagementService, trust ?? {
		onDidChangeTrust: Event.None,
		getUriTrustInfo: async () => { throw new Error('Backend-authorized diagnostics must not inspect host grants'); },
		getWorkspaceTrustInfo: async () => undefined,
	});
	const service = services.createInstance(AppServerLanguageDiagnosticsService, api, documents, !!trust);
	api.onServers = params => {
		if (!api.negotiateCapabilities) return;
		const dirId = params.dirId ?? workspace.getWorkspace().folders[0]?.id;
		for (const server of api.availableServers) events.fire({
			method: 'language/serverCapabilities', params: {
				...(dirId ? { dirId } : {}), server: server.id, languageIds: server.languageIds,
				features: api.pullSupported ? ['pullDiagnostics'] : [],
				completionTriggerCharacters: [], onTypeFormattingTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
			}
		});
	};
	service.start();
	return service;
}

test("App Server diagnostics service synchronizes, filters revisions, and closes once", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	const documents = new FakeCodeIntelligenceDocuments();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	using service = createDiagnosticsService(api, events, workspace, documents);
	using model = new TextModel("fn main() {}\n");
	const resource = URI.file("C:/project/main.rs");
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

suite('App Server diagnostics shutdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const disposed of [false, true]) {
		test(`a rejected synchronization ${disposed ? 'after disposal releases its error' : 'in a live service reports its error'}`, async () => {
			const api = new FakeLanguageApi();
			let rejectSynchronization: ((error: Error) => void) | undefined;
			api.synchronize = request => {
				api.synchronized.push(request);
				return new Promise((_, reject) => { rejectSynchronization = reject; });
			};
			using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
			using service = createDiagnosticsService(api, new FakeServerEvents(), workspace);
			using model = new TextModel('fn main() {}\n');
			using acquisition = service.acquire(URI.file('/project/main.rs'), 'rust', model);
			await tick();
			assert.equal(api.synchronized.length, 1);
			assert.ok(rejectSynchronization);
			const error = new Error('test language transport stopped');
			const reported: unknown[][] = [];
			const original = console.error;
			console.error = (...arguments_: unknown[]) => reported.push(arguments_);
			try {
				if (disposed) service.dispose();
				rejectSynchronization(error);
				await tick();
				assert.deepEqual(reported, disposed ? [] : [['App Server language document synchronization failed', error]]);
			} finally { console.error = original; }
		});
	}

	for (const disposed of [false, true]) {
		test(`workspace diagnostic rejection ${disposed ? 'after disposal is released' : 'while live is reported'}`, async () => {
			const api = new FakeLanguageApi();
			let rejectReport: ((error: Error) => void) | undefined;
			api.directoryDiagnostics = async () => {
				api.workspaceDiagnosticPulls++;
				if (api.workspaceDiagnosticPulls > 1) return api.workspaceReport;
				return new Promise((_, reject) => { rejectReport = reject; });
			};
			using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
			using service = createDiagnosticsService(api, new FakeServerEvents(), workspace);
			await tick();
			assert.ok(rejectReport);
			const error = new Error('test workspace transport stopped');
			const reported: unknown[][] = [];
			const original = console.error;
			console.error = (...arguments_: unknown[]) => reported.push(arguments_);
			try {
				if (disposed) service.dispose();
				rejectReport(error);
				await tick();
				assert.deepEqual(reported, disposed ? [] : [['App Server language document synchronization failed', error]]);
			} finally { console.error = original; }
		});
	}

	test('disposal cancels queued document closes before the transport stops', async () => {
		const api = new FakeLanguageApi();
		const documents = new FakeCodeIntelligenceDocuments();
		using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
		using service = createDiagnosticsService(api, new FakeServerEvents(), workspace, documents);
		using model = new TextModel('fn main() {}\n');
		using acquisition = service.acquire(URI.file('/project/main.rs'), 'rust', model);
		await tick();
		assert.equal(api.synchronized.length, 1);
		assert.equal(documents.synchronized.length, 1);
		acquisition.dispose();
		service.dispose();
		await tick();
		assert.deepEqual({ language: api.closed, codeIntelligence: documents.closed, diagnostics: service.getAllDiagnostics() }, { language: [], codeIntelligence: [], diagnostics: [] });
	});
});

test("App Server diagnostics retain pushes received before the editor acquires its model", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("/project") });
	using service = createDiagnosticsService(api, events, workspace);
	await tick();
	const resource = URI.file("/project/main.rs");
	const diagnostic = { range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } }, severity: "error" as const, message: "server diagnostic", code: null, source: "fixture" };
	events.fire({ method: "language/diagnostics", params: { path: "main.rs", revision: 1, diagnostics: [diagnostic] } });
	using model = new TextModel("fn main() {}\n");
	using acquisition = service.acquire(resource, "rust", model);
	await tick();
	assert.deepEqual(service.getAllDiagnostics().map(snapshot => ({ revision: snapshot.revision, messages: snapshot.diagnostics.map(diagnostic => diagnostic.message) })), [{ revision: 1, messages: ["server diagnostic"] }]);
	acquisition.dispose();
	await tick();
	assert.deepEqual(service.getAllDiagnostics(), []);
});

test("App Server diagnostics discard a push from a different revision when acquiring a model", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("/project") });
	using service = createDiagnosticsService(api, events, workspace);
	await tick();
	const resource = URI.file("/project/main.rs");
	events.fire({ method: "language/diagnostics", params: { path: "main.rs", revision: 2, diagnostics: [{ range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } }, severity: "error", message: "different revision", code: null, source: "fixture" }] } });
	using model = new TextModel("fn main() {}\n");
	using acquisition = service.acquire(resource, "rust", model);
	await tick();
	assert.deepEqual(service.getAllDiagnostics(), []);
});

test("App Server diagnostics keep equal relative paths isolated by Workspace folder", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	const documents = new FakeCodeIntelligenceDocuments();
	using workspace = new TestWorkspaceService({
		id: "multi-root",
		folders: [
			{ id: "one", uri: URI.file("C:/one"), name: "one", index: 0 },
			{ id: "two", uri: URI.file("C:/two"), name: "two", index: 1 },
		],
		configuration: URI.file("C:/project.code-workspace"),
	});
	using service = createDiagnosticsService(api, events, workspace, documents);
	using model = new TextModel("fn second() {}\n");
	const resource = URI.file("C:/two/main.rs");
	using acquisition = service.acquire(resource, "rust", model);
	await tick();

	assert.equal(api.synchronized[0]!.document.dirId, "two");
	assert.deepEqual(documents.synchronized, [], 'path-only code-intelligence overlays cannot identify a multi-root document');
	events.fire({ method: "language/diagnostics", params: { dirId: "two", path: "main.rs", revision: 1, diagnostics: [{ range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 9 } }, severity: "warning", message: "second root", code: null, source: "fixture" }] } });
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, "second root");
});

test('App Server diagnostics synchronize Shell documents using the grammar language identity', async () => {
	const api = new FakeLanguageApi();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, new FakeServerEvents(), workspace);
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
	negotiateCapabilities = true;
	pullSupported = true;
	onServers: (params: Parameters<ILanguageApi['servers']>[0]) => void = () => { };
	async save(_params: Parameters<ILanguageApi['save']>[0]): Promise<void> { }

	availableServers = [
		{ id: "typescript", languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
		{ id: "rust", languageIds: ["rust"] },
		{ id: "json", languageIds: ["json", "jsonc"] },
		{ id: "shell", languageIds: ["shellscript"] },
	];
	readonly serverReads: Parameters<ILanguageApi['servers']>[0][] = [];
	async servers(params: Parameters<ILanguageApi['servers']>[0]): ReturnType<ILanguageApi["servers"]> {
		this.serverReads.push(params);
		this.onServers(params);
		return { servers: this.availableServers };
	}

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
	async documentDiagnostics(params: Parameters<ILanguageApi["documentDiagnostics"]>[0], _options?: Parameters<ILanguageApi['documentDiagnostics']>[1]): ReturnType<ILanguageApi["documentDiagnostics"]> { this.diagnosticPulls.push(params); if (this.documentDiagnosticsError) throw this.documentDiagnosticsError; return { revision: params.document.revision, kind: "unchanged", diagnostics: [] }; }
	async directoryDiagnostics(): ReturnType<ILanguageApi["directoryDiagnostics"]> { this.workspaceDiagnosticPulls += 1; if (this.directoryDiagnosticsError) throw this.directoryDiagnosticsError; return this.workspaceReport; }
	formatDocument(): ReturnType<ILanguageApi["formatDocument"]> { throw new Error("unused"); }
	formatOnType(): ReturnType<ILanguageApi["formatOnType"]> { throw new Error("unused"); }
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

function notifyPull(events: FakeServerEvents, supported: boolean, dirId?: string): void {
	events.fire({
		method: 'language/serverCapabilities', params: {
			...(dirId ? { dirId } : {}), server: 'rust', languageIds: ['rust'],
			features: supported ? ['pullDiagnostics'] : [],
			completionTriggerCharacters: [], onTypeFormattingTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
		}
	});
}

const pullDiagnostic = { range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } }, severity: 'warning' as const, message: 'negotiated diagnostic', code: null, source: 'rust' };

test('document diagnostics wait for negotiated pull support while synchronization and push remain active', async () => {
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, events, workspace);
	using model = new TextModel('fn main() {}');
	const resource = URI.file('/project/main.rs');
	using acquisition = service.acquire(resource, 'rust', model);
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.diagnosticPulls.length, 0);
	notifyPull(events, false);
	events.fire({ method: 'language/diagnostics', params: { path: 'main.rs', revision: 1, diagnostics: [pullDiagnostic] } });
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, pullDiagnostic.message);
	assert.ok(api.workspaceDiagnosticPulls > 0, 'workspace bootstrap must still initialize servers');
	notifyPull(events, true);
	await tick();
	assert.equal(api.diagnosticPulls.length, 1);
	notifyPull(events, true);
	await tick();
	assert.equal(api.diagnosticPulls.length, 1, 'identical capability notifications do not repull');
	events.fire({ method: 'language/serverState', params: { server: 'rust', state: { type: 'starting' } } });
	events.fire({ method: 'language/serverState', params: { server: 'rust', state: { type: 'ready' } } });
	await tick();
	assert.equal(api.diagnosticPulls.length, 1, 'ready alone does not restore stale pull support');
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, pullDiagnostic.message);
});

for (const pushed of [false, true]) test(`retiring pull support cancels pending work and preserves push ownership=${pushed}`, async () => {
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	let complete!: (value: Awaited<ReturnType<ILanguageApi['documentDiagnostics']>>) => void;
	let signal: AbortSignal | undefined;
	api.documentDiagnostics = (params, options) => {
		api.diagnosticPulls.push(params);
		signal = options?.signal;
		return new Promise(resolve => { complete = resolve; });
	};
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, events, workspace);
	using model = new TextModel('fn main() {}');
	const resource = URI.file('/project/main.rs');
	using acquisition = service.acquire(resource, 'rust', model);
	await tick();
	notifyPull(events, true);
	await tick();
	complete({ revision: 1, kind: 'full', diagnostics: [pullDiagnostic] });
	await tick();
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, pullDiagnostic.message);
	if (pushed) events.fire({ method: 'language/diagnostics', params: { path: 'main.rs', revision: 1, diagnostics: [pullDiagnostic] } });
	notifyPull(events, false);
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, pushed ? pullDiagnostic.message : undefined);
	notifyPull(events, true);
	await tick();
	assert.equal(signal?.aborted, false);
	notifyPull(events, false);
	assert.equal(signal?.aborted, true);
	complete({ revision: 1, kind: 'full', diagnostics: [{ ...pullDiagnostic, message: 'late response' }] });
	await tick();
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, pushed ? pullDiagnostic.message : undefined);
});

test('pull capability is scoped to each directory for the same language', async () => {
	const api = new FakeLanguageApi();
	api.negotiateCapabilities = false;
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({
		id: 'team', folders: [
			{ id: 'one', name: 'one', uri: URI.file('/one'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/two'), index: 1 },
		]
	});
	using service = createDiagnosticsService(api, events, workspace);
	using first = new TextModel('fn main() {}');
	using second = new TextModel('fn main() {}');
	using a = service.acquire(URI.file('/one/main.rs'), 'rust', first);
	using b = service.acquire(URI.file('/two/main.rs'), 'rust', second);
	await tick();
	notifyPull(events, true, 'one');
	notifyPull(events, false, 'two');
	await tick();
	assert.deepEqual(api.diagnosticPulls.map(request => request.document.dirId), ['one']);
});

test("App Server diagnostics service includes unopened workspace reports", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	api.workspaceReport = { supported: true, snapshots: [{ path: "src/unopened.rs", diagnostics: [{ range: { start: { lineIndex: 2, columnIndex: 1 }, end: { lineIndex: 2, columnIndex: 4 } }, severity: "warning", message: "workspace warning", code: null, source: "fixture" }] }] };
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	using service = createDiagnosticsService(api, events, workspace);
	await tick();
	await tick();
	const resource = URI.file("C:/project/src/unopened.rs");
	assert.equal(service.getDiagnostics(resource)?.revision, 0);
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, "workspace warning");
	assert.equal(service.getAllDiagnostics().length, 1);

	using model = new TextModel("fn open() {}\n");
	using acquisition = service.acquire(resource, "rust", model);
	await tick();
	assert.equal(service.getDiagnostics(resource), undefined);
});

test("App Server diagnostics reports real pull failures while retaining typed availability handling", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	api.documentDiagnosticsError = new AppServerRemoteError(-32000, "Language request failed", { kind: "LanguageRequestFailed" });
	api.directoryDiagnosticsError = new AppServerRemoteError(-32000, "Language service unavailable", { kind: "LanguageServiceUnavailable" });
	const reported: unknown[][] = [];
	const originalConsoleError = console.error;
	console.error = (...arguments_: unknown[]) => reported.push(arguments_);
	try {
		using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
		using service = createDiagnosticsService(api, events, workspace);
		using model = new TextModel("fn main() {}\n");
		using acquisition = service.acquire(URI.file("C:/project/main.rs"), "rust", model);
		await tick();
		await tick();

		assert.equal(api.diagnosticPulls.length, 1);
		assert.ok(api.workspaceDiagnosticPulls > 0);
		assert.deepEqual(reported, [['App Server language document synchronization failed', api.documentDiagnosticsError]]);
	} finally {
		console.error = originalConsoleError;
	}
});

test("App Server diagnostics service waits for a workspace folder before pulling workspace diagnostics", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using workspace = new TestWorkspaceService({ id: "empty-window" });
	using service = createDiagnosticsService(api, events, workspace);

	await tick();
	assert.equal(api.workspaceDiagnosticPulls, 0);

	workspace.updateWorkspace({ id: "workspace", uri: URI.file("C:/project") });
	await tick();
	await tick();
	assert.ok(api.workspaceDiagnosticPulls > 0);
});

test("App Server diagnostics service gates Editor synchronization on directory permissions and replays open models after access is allowed", async () => {
	const events = new FakeServerEvents();
	const api = new FakeLanguageApi();
	using permissions = new FakeWorkspaceTrustService([]);
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("C:/project") });
	using service = createDiagnosticsService(api, events, workspace, undefined, permissions);
	using model = new TextModel("fn main() {}\n");
	using acquisition = service.acquire(URI.file("C:/project/main.rs"), "rust", model);

	await tick();
	await tick();
	assert.equal(api.synchronized.length, 0);
	assert.equal(api.workspaceDiagnosticPulls, 0);

	permissions.value = ["executeCommands", "useLanguageServices"];
	permissions.notify();
	await tick();
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.synchronized[0]!.document.path, "main.rs");
	assert.ok(api.workspaceDiagnosticPulls > 0);

	permissions.value = [];
	permissions.notify();
	await tick();
	await tick();
	const synchronizedBeforeEdit = api.synchronized.length;
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "// " }]);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(api.synchronized.length, synchronizedBeforeEdit);
});

class FakeWorkspaceTrustService extends Disposable implements IWorkspaceTrustManagementService {
	private readonly change = this._register(new Emitter<void>());
	readonly onDidChangeTrust = this.change.event;
	constructor(public value: readonly WorkspaceTrustPermission[]) { super(); }
	async getUriTrustInfo(uri: URI) { return { uri, trusted: false, permissions: this.value }; }
	async getWorkspaceTrustInfo() { return undefined; }
	notify() { this.change.fire(); }
}

test("installing a language server synchronizes an already open document and uninstall stops it", async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [];
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("/project") });
	using service = createDiagnosticsService(api, events, workspace);
	using model = new TextModel("value = 1", { languageId: "python" });
	using acquisition = service.acquire(URI.file("/project/main.py"), "python", model);
	await tick();
	assert.equal(api.synchronized.length, 0);
	api.availableServers = [{ id: "pyright", languageIds: ["python"] }];
	events.fire({ method: "extensions/changed", params: { instanceId: "test", generation: 2 } });
	await tick();
	assert.equal(api.synchronized.length, 1);
	assert.equal(api.synchronized[0]!.document.languageId, "python");
	api.availableServers = [];
	events.fire({ method: "extensions/changed", params: { instanceId: "test", generation: 3 } });
	await tick();
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: "# comment\n" }]);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(api.synchronized.length, 1);
});

test('re-enabling a language rebinds an already open model without losing unsaved changes or undo', async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [];
	api.documentDiagnostics = async ({ document }) => ({
		revision: document.revision, kind: 'full', diagnostics: [{
			range: { start: { lineIndex: 1, columnIndex: 0 }, end: { lineIndex: 1, columnIndex: 2 } },
			severity: 'error', message: 'Rust diagnostic', code: 'fixture', source: 'rust',
		}],
	});
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, events, workspace);
	using languages = new LanguageService();
	using registration = languages.registerLanguages([]);
	const resource = URI.file('/project/main.rs');
	using model = new TextModel('fn main() {}', { resource, languageId: 'plaintext' });
	model.setLanguage(languages.createByFilepathOrFirstLine(resource));
	using first = service.acquire(resource, model.getLanguageId(), model);
	using second = service.acquire(resource, model.getLanguageId(), model);
	model.pushEditOperations(null, [{ range: new Range(1, 1, 1, 1), text: '// unsaved\n' }], () => null);
	const revision = model.version;
	let generation = 1;
	const enableRust = () => {
		api.availableServers = [{ id: 'rust', languageIds: ['rust'] }];
		registration.replace([{ description: { id: 'rust', extensions: ['.rs'] } }]);
		events.fire({ method: 'extensions/changed', params: { instanceId: 'test', generation: ++generation } });
	};
	await tick();
	assert.equal(api.synchronized.length, 0);
	enableRust();
	await tick();
	assert.equal(model.getLanguageId(), 'rust');
	assert.equal(api.synchronized.at(-1)?.document.languageId, 'rust');
	assert.equal(api.synchronized.at(-1)?.document.text, model.getText());
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, 'Rust diagnostic');
	api.availableServers = [];
	registration.replace([]);
	events.fire({ method: 'extensions/changed', params: { instanceId: 'test', generation: ++generation } });
	await tick();
	assert.equal(service.getDiagnostics(resource), undefined);
	const synchronized = api.synchronized.length;
	enableRust();
	await tick();
	assert.ok(api.synchronized.length > synchronized);
	assert.equal(api.synchronized.at(-1)?.document.languageId, 'rust');
	assert.equal(api.synchronized.at(-1)?.document.revision, revision);
	assert.equal(service.getDiagnostics(resource)?.revision, revision);
	assert.equal(service.getDiagnostics(resource)?.diagnostics[0]?.message, 'Rust diagnostic');
	assert.equal(model.getText(), '// unsaved\nfn main() {}');
	assert.equal(model.canUndo(), true);
	first.dispose();
	await tick();
	const closed = api.closed.length;
	second.dispose();
	await tick();
	assert.equal(api.closed.length, closed + 1, 'only the last reference closes the live binding');
});

test('language changes retire an in-flight diagnostic binding before synchronizing the new language', async () => {
	const api = new FakeLanguageApi();
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const synchronize = api.synchronize.bind(api);
	api.synchronize = async request => { await synchronize(request); if (api.synchronized.length === 1) await blocked; };
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, new FakeServerEvents(), workspace);
	using model = new TextModel('fn main() {}', { languageId: 'rust' });
	using acquisition = service.acquire(URI.file('/project/main.rs'), 'rust', model);
	await tick();
	model.setLanguage('typescript');
	model.setLanguage('rust');
	release();
	await tick(); await tick();
	assert.deepEqual(api.closed, [{ path: 'main.rs' }]);
	assert.deepEqual(api.synchronized.map(request => request.document.languageId), ['rust', 'rust']);
	assert.equal(api.diagnosticPulls.length, 1, 'the retired binding cannot pull diagnostics');
});

test('local JSON diagnostics follow the language of an acquired model', async () => {
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(new FakeLanguageApi(), new FakeServerEvents(), workspace);
	using model = new TextModel('{', { languageId: 'plaintext' });
	const resource = URI.file('/project/example.json');
	using acquisition = service.acquire(resource, 'plaintext', model);
	await tick();
	assert.equal(service.getDiagnostics(resource), undefined);
	model.setLanguage('json');
	assert.ok(service.getDiagnostics(resource)?.diagnostics.length);
	model.setLanguage('plaintext');
	assert.equal(service.getDiagnostics(resource), undefined);
});

test('a provider refresh retains the backend document binding until its last editor releases it', async () => {
	const api = new FakeLanguageApi();
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, events, workspace);
	using model = new TextModel('fn main() {}', { languageId: 'rust' });
	using acquisition = service.acquire(URI.file('/project/main.rs'), 'rust', model);
	await tick();
	assert.equal(api.synchronized.length, 1);
	api.availableServers = [];
	events.fire({ method: 'extensions/changed', params: { instanceId: 'test', generation: 2 } });
	await tick();
	acquisition.dispose();
	await tick();
	assert.deepEqual(api.closed, [{ path: 'main.rs' }]);
});

test('diagnostic refresh coalesces bursts and only pulls from the matching workspace server', async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [{ id: 'rust-analyzer', languageIds: ['rust'] }];
	let ready = false;
	api.documentDiagnostics = async params => {
		api.diagnosticPulls.push(params);
		return {
			revision: params.document.revision, kind: 'full', diagnostics: ready ? [{
				range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } },
				severity: 'error', message: 'Workspace loaded', code: null, source: 'rust-analyzer',
			}] : []
		};
	};
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, events, workspace);
	using model = new TextModel('fn main() {}', { languageId: 'rust' });
	using acquisition = service.acquire(URI.file('/project/main.rs'), 'rust', model);
	await tick();
	const pulls = api.diagnosticPulls.length;
	for (const params of [{ server: 'other' }, { dirId: 'other', server: 'rust-analyzer' }]) {
		events.fire({ method: 'language/diagnosticsRefresh', params });
	}
	await tick();
	assert.equal(api.diagnosticPulls.length, pulls);
	assert.deepEqual(service.getDiagnostics(URI.file('/project/main.rs'))?.diagnostics, []);
	ready = true;
	for (let index = 0; index < 3; index++) events.fire({ method: 'language/diagnosticsRefresh', params: { server: 'rust-analyzer' } });
	await tick();
	assert.equal(api.diagnosticPulls.length, pulls + 1);
	assert.equal(service.getDiagnostics(URI.file('/project/main.rs'))?.diagnostics[0]?.message, 'Workspace loaded');
	acquisition.dispose();
	await tick();
	events.fire({ method: 'language/diagnosticsRefresh', params: { server: 'rust-analyzer' } });
	await tick();
	assert.equal(api.diagnosticPulls.length, pulls + 1);
});

for (const desktop of [false, true]) test(`profile configuration changes replay open documents and retire disabled diagnostics, desktop=${desktop}`, async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [];
	const events = new FakeServerEvents();
	using trust = new FakeWorkspaceTrustService(['executeCommands', 'useLanguageServices']);
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, events, workspace, undefined, desktop ? trust : undefined);
	using model = new TextModel('value = 1', { languageId: 'python' });
	const resource = URI.file('/project/main.py');
	using acquisition = service.acquire(resource, 'python', model);
	await tick();
	assert.equal(api.synchronized.length, 0);
	api.availableServers = [{ id: 'custom-python', languageIds: ['python'] }];
	events.fire({ method: 'config/changed', params: { revision: 1, generation: 1 } });
	await tick();
	assert.equal(api.synchronized.length, 1);
	events.fire({ method: 'language/diagnostics', params: { path: 'main.py', revision: 1, diagnostics: [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } }, severity: 'error', message: 'current server', code: null, source: 'custom-python' }] } });
	assert.equal(service.getDiagnostics(resource)?.diagnostics.length, 1);
	api.availableServers = [];
	events.fire({ method: 'config/changed', params: { revision: 2, generation: 2 } });
	await tick();
	assert.deepEqual(service.getAllDiagnostics(), []);
	assert.equal(api.synchronized.length, 1);
});


test("uninstall discards pending workspace diagnostic reports and late server notifications", async () => {
	const api = new FakeLanguageApi();
	api.availableServers = [{ id: "pyright", languageIds: ["python"] }];
	let complete!: (report: Awaited<ReturnType<ILanguageApi["directoryDiagnostics"]>>) => void;
	api.directoryDiagnostics = () => new Promise(resolve => { complete = resolve; });
	const events = new FakeServerEvents();
	using workspace = new TestWorkspaceService({ id: "workspace", uri: URI.file("/project") });
	using service = createDiagnosticsService(api, events, workspace);
	await tick();
	api.availableServers = [];
	events.fire({ method: "extensions/changed", params: { instanceId: "test", generation: 2 } });
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

for (const nested of [false, true]) test(`live folder edits rebind acquired documents and retire old overlays, nested=${nested}`, async () => {
	using workspace = new TestWorkspaceService({ id: 'one', uri: URI.file('/project') });
	const api = new FakeLanguageApi();
	const documents = new FakeCodeIntelligenceDocuments();
	using service = createDiagnosticsService(api, new FakeServerEvents(), workspace, documents);
	using model = new TextModel('fn main() {}');
	const resource = URI.file('/project/child/main.rs');
	using acquisition = service.acquire(resource, 'rust', model);
	await tick(); await tick();
	assert.equal(api.synchronized.length, 1);
	workspace.updateWorkspace({
		id: 'team', configuration: URI.file('/team.ash-workspace'), folders: [
			{ id: 'one', name: 'one', uri: URI.file('/project'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file(nested ? '/project/child' : '/other'), index: 1 },
		]
	});
	await tick(); await tick();
	assert.deepEqual(documents.closed, ['child/main.rs']);
	assert.equal(api.synchronized.at(-1)?.document.dirId, nested ? 'two' : 'one');
	assert.equal(api.synchronized.at(-1)?.document.path, nested ? 'main.rs' : 'child/main.rs');
	acquisition.dispose();
	await tick();
	assert.deepEqual(documents.closed, ['child/main.rs'], 'the old overlay closes exactly once');
});

test('a synchronization in flight retires its old binding before replaying into a new root', async () => {
	using workspace = new TestWorkspaceService({ id: 'one', uri: URI.file('/project') });
	const api = new FakeLanguageApi();
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const synchronize = api.synchronize.bind(api);
	api.synchronize = async request => { await synchronize(request); if (api.synchronized.length === 1) await blocked; };
	const documents = new FakeCodeIntelligenceDocuments();
	using service = createDiagnosticsService(api, new FakeServerEvents(), workspace, documents);
	using model = new TextModel('fn main() {}');
	using acquisition = service.acquire(URI.file('/project/child/main.rs'), 'rust', model);
	await tick();
	workspace.updateWorkspace({
		id: 'team', configuration: URI.file('/team.ash-workspace'), folders: [
			{ id: 'one', name: 'one', uri: URI.file('/project'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/project/child'), index: 1 },
		]
	});
	release();
	await tick(); await tick();
	assert.deepEqual(documents.closed, ['child/main.rs']);
	assert.deepEqual(api.closed, [{ path: 'child/main.rs' }]);
	assert.equal(api.synchronized.at(-1)?.document.dirId, 'two');
});

test('successful saves synchronize the current dirty snapshot before reporting exact saved content', async () => {
	using saves = new Emitter<ITextFileSaveEvent>();
	const api = new FakeLanguageApi();
	const operations: unknown[] = [];
	const synchronize = api.synchronize.bind(api);
	api.synchronize = async params => { operations.push(['synchronize', params.document.text]); await synchronize(params); };
	api.save = async params => { operations.push(['save', params.text]); };
	using workspace = new TestWorkspaceService({ id: 'save', uri: URI.file('/project') });
	using service = createDiagnosticsService(api, new FakeServerEvents(), workspace, undefined, undefined, saves.event);
	using model = new TextModel('saved');
	const resource = URI.file('/project/main.rs');
	using acquisition = service.acquire(resource, 'rust', model);
	await tick();
	operations.length = 0;
	model.applyEdits([{ range: new Range(1, 1, 1, 6), text: 'new dirty text' }]);
	saves.fire({ resource, content: 'saved', revision: 'disk-revision' });
	await tick();
	assert.deepEqual(operations, [['synchronize', 'new dirty text'], ['save', 'saved']]);
	service.dispose();
	saves.fire({ resource, content: 'saved', revision: 'disk-revision' });
	await tick();
	assert.equal(operations.length, 2);
});

test('language startup receives effective Rust settings and resynchronizes open models after external changes', async () => {
	const api = new FakeLanguageApi();
	using workspace = new TestWorkspaceService({ id: 'rust-settings', uri: URI.file('/project') });
	await workspace.write('{ "rust-analyzer.cargo.buildScripts.enable": false, "rust-analyzer.cargo.targetDir": ".build/analysis" }');
	using service = createDiagnosticsService(api, new FakeServerEvents(), workspace);
	using model = new TextModel('fn main() {}\n');
	using document = service.acquire(URI.file('/project/main.rs'), 'rust', model);
	await tick();
	assert.deepEqual(api.serverReads.at(-1)?.settings, { 'rust-analyzer': { cargo: { buildScripts: { enable: false }, targetDir: '.build/analysis' } } });
	const count = api.synchronized.length;
	await workspace.write('{}');
	await tick();
	assert.deepEqual(api.serverReads.at(-1)?.settings, { 'rust-analyzer': {} });
	assert.equal(api.synchronized.length, count + 1);
});
