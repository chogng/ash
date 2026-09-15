import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { CommandRegistry } from "../../../../../platform/commands/common/commands.js";
import type { ServicesAccessor } from "../../../../../platform/instantiation/common/instantiation.js";
import type { AppServerConnectionState } from "../../../../../platform/app-server/common/appServerApi.js";
import type { ExtensionHostFleetSnapshot, ExtensionHostInvocationRequest, ExtensionHostOutputEvent, ExtensionHostReconcileMode, IExtensionHostApi, JsonValue } from "../../../../../platform/extensionHost/common/extensionHostApi.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageHoverService } from "../../../../../editor/contrib/hover/common/hover.js";
import { ParameterHintsService } from "../../../../../editor/contrib/parameterHints/common/languageParameterHints.js";
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import type { ITaskService, TaskProvider, TaskProviderRegistration } from "../../../tasks/common/taskService.js";
import type { ITestingService, TestProfileProvider, TestProfileProviderRegistration } from "../../../testing/common/testingService.js";
import { AppServerExtensionHostService } from "../../browser/appServerExtensionHostService.js";
import { createExtensionHostLanguageProviderBatch } from '../../browser/extensionHostLanguageBridge.js';
import { OutputService } from "../../../output/browser/outputService.js";

const DIGEST = `sha256:${"b".repeat(64)}`;

test('range formatting bridge preserves the request snapshot and forwards cancellation', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('alpha', { languageId: 'typescript', resource: URI.file('/project/main.ts') });
	using source = new CancellationTokenSource();
	const version = model.getVersionId();
	let payload: JsonValue | undefined;
	let signal: AbortSignal | undefined;
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	const range = { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 5 } };
	const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] }, 'formatter', async (operation, value, cancellation) => {
		assert.equal(operation, 'formatting');
		payload = value;
		signal = cancellation;
		await pending;
		return { edits: [{ range, text: 'ALPHA' }] };
	});
	using registration = languages.registerProviderBatch(batch);
	const result = languages.documentRangeFormattingEditProvider.ordered(model)[0]!.provideDocumentRangeFormattingEdits(model, new Range(1, 1, 1, 6), { tabSize: 2, insertSpaces: false }, source.token);
	assert.deepEqual(payload, { languageId: 'typescript', version, text: 'alpha', resource: model.uri.toString(), kind: 'range', range, options: { tabSize: 2, insertSpaces: false } });
	model.setValue('x');
	source.cancel();
	assert.ok(signal);
	assert.equal(signal.aborted, true);
	release();
	assert.deepEqual(await result, [{ range: new Range(1, 1, 1, 6), text: 'ALPHA' }]);
});

test('document formatting bridge captures model metadata and releases its cancellation listener', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('alpha', { languageId: 'typescript', resource: URI.file('/project/main.ts') });
	using source = new CancellationTokenSource();
	let payload: JsonValue | undefined;
	let signal: AbortSignal | undefined;
	const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] }, 'formatter', async (operation, value, cancellation) => {
		assert.equal(operation, 'formatting');
		payload = value;
		signal = cancellation;
		return { edits: [] };
	});
	using registration = languages.registerProviderBatch(batch);
	const provider = languages.documentFormattingEditProvider.ordered(model)[0]!;
	assert.deepEqual(languages.onTypeFormattingEditProvider.ordered(model), []);
	assert.deepEqual(await provider.provideDocumentFormattingEdits(model, { tabSize: 2, insertSpaces: true }, source.token), []);
	assert.deepEqual(payload, { languageId: 'typescript', version: model.getVersionId(), text: 'alpha', resource: model.uri.toString(), kind: 'document', options: { tabSize: 2, insertSpaces: true } });
	assert.ok(signal);
	source.cancel();
	assert.equal(signal.aborted, false);
});

test('document formatting bridge forwards cancellation while transport is pending', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('alpha', { languageId: 'typescript' });
	using source = new CancellationTokenSource();
	let signal: AbortSignal | undefined;
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] }, 'formatter', async (_operation, _payload, cancellation) => {
		signal = cancellation;
		await pending;
		return { edits: [] };
	});
	using registration = languages.registerProviderBatch(batch);
	const result = languages.documentFormattingEditProvider.ordered(model)[0]!.provideDocumentFormattingEdits(model, { tabSize: 4, insertSpaces: true }, source.token);
	source.cancel();
	assert.ok(signal);
	assert.equal(signal.aborted, true);
	release();
	await result;
});

test("keeps last-good contributions while refreshing and revokes them synchronously on disconnect", async () => {
	const api = new FakeExtensionHostApi(snapshot(1, "acme.old"));
	const commands = new CommandRegistry();
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using service = new AppServerExtensionHostService({ api, commands, languageFeatures: languages, tasks: tasks as unknown as ITaskService, testing: tests as unknown as ITestingService, invocationTimeoutMillis: 1_000 });
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));

	await service.start();
	assert.equal(service.currentSnapshot.fleetGeneration, 1);
	assert.equal(service.state, "degraded");
	assert.ok(failures.includes("unsupportedRegistrationBridge"));
	assert.ok(commands.hasCommand("acme.old"));

	const handler = commands.getCommand("acme.old")!;
	assert.deepEqual(await handler({} as ServicesAccessor, "argument"), { executed: true });
	assert.equal(api.invocations[0]?.activationGeneration, 11);
	assert.equal(api.invocations[0]?.incarnation, 3);
	const payload = api.invocations[0]?.payload;
	assert.deepEqual(typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as { readonly arguments?: JsonValue }).arguments : undefined, ["argument"]);

	assert.deepEqual(await tasks.providers[0]!.provideTasks(new AbortController().signal), [{ id: "unit", label: "Unit", command: "pnpm test", group: "test" }]);
	assert.deepEqual(await tests.providers[0]!.provideTestProfiles(new AbortController().signal), [{ id: "unit", label: "Unit", taskId: "extension:extensionHost.61636d652e64656d6f.7461736b73:unit" }]);

	const pendingList = deferred<ExtensionHostFleetSnapshot>();
	api.listResult = pendingList.promise;
	api.emitChanged(2);
	assert.equal(commands.hasCommand("acme.old"), true);
	assert.equal(tasks.providers.length, 1);
	api.current = snapshot(2, "acme.new");
	pendingList.resolve(api.current);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.ok(commands.hasCommand("acme.new"));

	api.listResult = Promise.reject(new Error("temporary list failure"));
	api.emitChanged(3);
	await waitFor(() => failures.includes("extensionHostRefreshFailed"));
	assert.equal(service.currentSnapshot.fleetGeneration, 2);
	assert.ok(commands.hasCommand("acme.new"));
	assert.equal(service.state, "degraded");
	api.current = snapshot(3, "acme.latest");
	api.listResult = undefined;

	api.emitConnection("crashed");
	assert.equal(commands.hasCommand("acme.new"), false);
	assert.equal(service.state, "failed");
	api.emitConnection("ready");
	await waitFor(() => commands.hasCommand("acme.latest"));
});

test("projects supported language operations while diagnosing unsupported operations", async () => {
	const current = snapshot(1, "acme.run", [{ registrationId: "language", kind: "languageProvider", languageIds: ["typescript"], operations: ["hover", "parameterHints", "definition"] }]);
	const api = new FakeExtensionHostApi(current);
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using service = new AppServerExtensionHostService({ api, commands: new CommandRegistry(), languageFeatures: languages, tasks: tasks as unknown as ITaskService, testing: tests as unknown as ITestingService });
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));
	await service.start();

	using model = new TextModel("answer", { languageId: "typescript" });
	using hover = new LanguageHoverService(model, languages.hoverProvider);
	using parameterHints = new ParameterHintsService(model, languages.signatureHelpProvider);
	assert.deepEqual(await hover.provideHover("typescript", new Position((0) + 1, (1) + 1)), { contents: ["Host hover"] });
	assert.deepEqual(await parameterHints.provideParameterHints("typescript", new Position((0) + 1, (1) + 1)), { signatures: [{ label: "fn(value)", parameters: [{ label: "value" }], activeParameter: 0 }], activeSignature: 0 });
	assert.deepEqual((api.invocations.find(request => request.operation === "hover")!.payload as { readonly position: unknown }).position, { lineIndex: 0, columnIndex: 1 });
	assert.deepEqual((api.invocations.find(request => request.operation === "parameterHints")!.payload as { readonly position: unknown }).position, { lineIndex: 0, columnIndex: 1 });
	assert.equal(service.state, "degraded");
	assert.ok(failures.includes("unsupportedRegistrationBridge"));
});

test("keeps the service stopped when the negotiated Host capability is absent", async () => {
	const api = new FakeExtensionHostApi(snapshot(1, "acme.run"));
	api.available = false;
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using service = new AppServerExtensionHostService({ api, commands: new CommandRegistry(), languageFeatures: languages, tasks: tasks as unknown as ITaskService, testing: tests as unknown as ITestingService });
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));

	await service.start();
	assert.equal(service.state, "stopped");
	assert.equal(service.currentSnapshot.fleetGeneration, 0);
	assert.equal(api.reconciles, 0);
	assert.deepEqual(failures, []);
});

test("projects bounded Extension Host stderr incrementally into extension-owned Output", async () => {
	const api = new FakeExtensionHostApi(snapshot(1, "acme.run", [], "first diagnostic\n"));
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using output = new OutputService();
	using service = new AppServerExtensionHostService({ api, commands: new CommandRegistry(), languageFeatures: languages, tasks: tasks as unknown as ITaskService, testing: tests as unknown as ITestingService, output });
	await service.start();

	const channel = output.getChannel("extension-host.acme.demo");
	assert.equal(channel?.descriptor.source, "extension");
	assert.equal(channel?.descriptor.extensionId, "acme.demo");
	assert.match(channel?.getText() ?? "", /first diagnostic/);

	api.current = snapshot(2, "acme.run", [], "first diagnostic\nsecond diagnostic\n");
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal((channel?.getText().match(/first diagnostic/g) ?? []).length, 1);
	assert.equal((channel?.getText().match(/second diagnostic/g) ?? []).length, 1);
});

test("projects ordered extension-created named Output channels without replaying old reveal requests", async () => {
	const created: readonly ExtensionHostOutputEvent[] = Object.freeze([
		Object.freeze({ sequence: 1, incarnation: 3, activationGeneration: 11, operation: Object.freeze({ operation: "create", channelId: "review", label: "Review", kind: "log" }) }),
		Object.freeze({ sequence: 2, incarnation: 3, activationGeneration: 11, operation: Object.freeze({ operation: "append", channelId: "review", text: "first\n", severity: "information", category: "review" }) }),
		Object.freeze({ sequence: 3, incarnation: 3, activationGeneration: 11, operation: Object.freeze({ operation: "show", channelId: "review", preserveFocus: false }) }),
	]);
	const api = new FakeExtensionHostApi(snapshot(1, "acme.run", [], "", created, 11));
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using output = new OutputService();
	const reveals: string[] = [];
	output.onDidRequestShowChannel(request => reveals.push(request.focus));
	using service = new AppServerExtensionHostService({ api, commands: new CommandRegistry(), languageFeatures: languages, tasks: tasks as unknown as ITaskService, testing: tests as unknown as ITestingService, output });
	await service.start();

	const channelId = "extension.acme.demo.review";
	assert.equal(output.getChannel(channelId)?.getText(), "first\n");
	assert.deepEqual(reveals, []);

	const updated = Object.freeze([...created, Object.freeze({ sequence: 4, incarnation: 3, activationGeneration: 11, operation: Object.freeze({ operation: "append" as const, channelId: "review", text: "second\n", severity: "warning" as const, category: undefined }) }), Object.freeze({ sequence: 5, incarnation: 3, activationGeneration: 11, operation: Object.freeze({ operation: "show" as const, channelId: "review", preserveFocus: true }) })]);
	api.current = snapshot(2, "acme.run", [], "", updated, 11);
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(output.getChannel(channelId)?.getText(), "first\nsecond\n");
	assert.deepEqual(reveals, ["preserve"]);

	api.current = snapshot(3, "acme.run", [], "", Object.freeze([...updated, Object.freeze({ sequence: 6, incarnation: 3, activationGeneration: 11, operation: Object.freeze({ operation: "dispose" as const, channelId: "review" }) })]), 11);
	api.emitChanged(3);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 3);
	assert.equal(output.getChannel(channelId), undefined);
});

class FakeExtensionHostApi implements IExtensionHostApi {
	available = true;
	reconciles = 0;
	current: ExtensionHostFleetSnapshot;
	listResult: Promise<ExtensionHostFleetSnapshot> | undefined;
	readonly invocations: ExtensionHostInvocationRequest[] = [];
	private readonly changed = new Set<(generation: number) => void>();
	private readonly connections = new Set<(state: AppServerConnectionState) => void>();
	private connectionState: AppServerConnectionState = "ready";

	constructor(snapshotValue: ExtensionHostFleetSnapshot) { this.current = snapshotValue; }

	list(): Promise<ExtensionHostFleetSnapshot> { return this.listResult ?? Promise.resolve(this.current); }
	reconcile(_mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot> { this.reconciles += 1; return Promise.resolve(this.current); }
	isAvailable(): Promise<boolean> { return Promise.resolve(this.available); }
	getConnectionState(): Promise<AppServerConnectionState> { return Promise.resolve(this.connectionState); }
	onDidChange(listener: (generation: number) => void) { this.changed.add(listener); return { dispose: () => this.changed.delete(listener) }; }
	onConnectionState(listener: (state: AppServerConnectionState) => void) { this.connections.add(listener); return { dispose: () => this.connections.delete(listener) }; }

	async invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		signal.throwIfAborted();
		this.invocations.push(request);
		if (request.operation === "execute") return Object.freeze({ executed: true });
		if (request.operation === "provideTasks") return Object.freeze({ tasks: Object.freeze([{ id: "unit", label: "Unit", command: "pnpm test", group: "test" }]) });
		if (request.operation === "provideTestProfiles") return Object.freeze({ profiles: Object.freeze([{ id: "unit", label: "Unit", taskProviderRegistrationId: "tasks", taskId: "unit" }]) });
		if (request.operation === "hover") return Object.freeze({ contents: Object.freeze(["Host hover"]) });
		if (request.operation === "parameterHints") return Object.freeze({ signatures: Object.freeze([{ label: "fn(value)", parameters: Object.freeze([{ label: "value" }]), activeParameter: 0 }]), activeSignature: 0 });
		throw new Error(`Unexpected operation ${request.operation}`);
	}

	emitChanged(generation: number): void { for (const listener of this.changed) listener(generation); }
	emitConnection(state: AppServerConnectionState): void { this.connectionState = state; for (const listener of this.connections) listener(state); }
}

class ProviderSink<TProvider> {
	providers: readonly TProvider[] = Object.freeze([]);

	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration { return this.registration(providers as readonly TProvider[]) as TaskProviderRegistration; }
	registerTestProfileProviders(providers: readonly TestProfileProvider[]): TestProfileProviderRegistration { return this.registration(providers as readonly TProvider[]) as TestProfileProviderRegistration; }

	private registration(initial: readonly TProvider[]): TaskProviderRegistration | TestProfileProviderRegistration {
		let disposed = false;
		this.providers = Object.freeze([...initial]);
		const registration = toDisposable(() => { disposed = true; this.providers = Object.freeze([]); }) as TaskProviderRegistration;
		registration.replace = providers => {
			if (disposed) throw new ReferenceError("Provider registration is disposed");
			this.providers = Object.freeze([...(providers as readonly TProvider[])]);
		};
		return registration;
	}
}

function snapshot(generation: number, command: string, additional: readonly ExtensionHostFleetSnapshot["extensions"][number]["registrations"][number][] = [], stderr = "", outputEvents: readonly ExtensionHostOutputEvent[] = [], activationGeneration = 10 + generation): ExtensionHostFleetSnapshot {
	return Object.freeze({
		generation,
		extensions: Object.freeze([Object.freeze({
			id: "acme.demo",
			version: "1.0.0",
			packageDigest: DIGEST,
			runtimeApiVersion: 1,
			activationGeneration,
			incarnation: 3,
			lifecycle: "ready" as const,
			failure: undefined,
			stderr,
			outputEvents: Object.freeze([...outputEvents]),
			registrations: Object.freeze([
				Object.freeze({ registrationId: "command", kind: "command" as const, command, title: "Run" }),
				Object.freeze({ registrationId: "tasks", kind: "taskProvider" as const, taskType: "acme" }),
				Object.freeze({ registrationId: "tests", kind: "testProfileProvider" as const, providerId: "acme.tests", label: "Tests" }),
				Object.freeze({ registrationId: "debug", kind: "debugAdapter" as const, debuggerType: "acme" }),
				...additional,
			]),
		})]),
	});
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for Extension Host state");
}
