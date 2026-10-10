import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { getNLSLanguage } from '../../../../../nls.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { MainThreadConfiguration } from '../../../../api/browser/mainThreadConfiguration.js';
import { MainThreadWorkspace } from '../../../../api/browser/mainThreadWorkspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { MockDebugSession } from '../../../../contrib/debug/test/common/mockDebug.js';
import { Event } from '../../../../../base/common/event.js';
import { IExtensionService } from '../../../extensions/common/extensionService.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { IDebugService, type IDebugConfigurationProvider, type DebugConfigurationProviderRegistration, type IDebugAdapterTrackerFactory, type DebugAdapterTrackerFactoryRegistration } from '../../../debug/common/debugService.js';
import { DebugAdapterFactoriesRegistry } from '../../../debug/common/debugAdapterFactory.js';
import { IHostService } from '../../../host/browser/host.js';
import { readFileSync } from 'node:fs';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService, UnavailableRemoteConnectionApi } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { CommandRegistry, CommandsRegistry } from "../../../../../platform/commands/common/commands.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { type ServicesAccessor } from "../../../../../platform/instantiation/common/instantiation.js";
import type { AppServerConnectionState } from "../../../../../platform/agentHost/common/appServerApi.js";
import { IExtensionHostApi, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type ExtensionHostOutputEvent, type ExtensionHostReconcileMode, type JsonValue } from "../../../../../platform/extensionHost/common/extensionHostApi.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from '../../../../../editor/common/core/range.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { ITaskService, type TaskProvider, type TaskProviderRegistration } from "../../../tasks/common/taskService.js";
import { ITestingService, type TestProfileProvider, type TestProfileProviderRegistration } from "../../../testing/common/testingService.js";
import { AppServerExtensionHostService } from "../../browser/appServerExtensionHostService.js";
import { MainThreadExtensionApi } from '../../../../api/browser/mainThreadExtensionApi.js';
import { IStatusbarService, StatusbarAlignment } from '../../../statusbar/browser/statusbar.js';
import { createExtensionHostLanguageProviderBatch } from '../../../../api/browser/extensionHostLanguageBridge.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IOutputService } from '../../../output/common/output.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../notification/common/notificationService.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';

import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { AbstractLifecycleService } from '../../../lifecycle/common/lifecycleService.js';
import { ILifecycleService, LifecyclePhase } from '../../../lifecycle/common/lifecycle.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IMarkerService, MarkerService } from '../../../../../platform/markers/common/markers.js';

const DIGEST = `sha256:${"b".repeat(64)}`;

test('extension command requests preserve value presence through the real CommandService owner', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.commands'));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	const values = [undefined, null, false, 0, { value: 7 }];
	using registration = CommandsRegistry.register('test.extension.commandValue', (_accessor, index, argument) => {
		assert.equal(argument, 'literal argument');
		return values[index as number];
	});
	await host.start();
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const signal = new AbortController().signal;
	const results = [];
	for (let index = 0; index < values.length; index++) {
		results.push(await api.clientHandler!({ operation: 'executeCommand', command: 'test.extension.commandValue', arguments: [index, 'literal argument'] }, signal, source));
	}
	assert.deepEqual(JSON.parse(JSON.stringify(results)), values.map(value => ({ result: 'command', value: value === undefined ? null : value, hasValue: value !== undefined })));
	await assert.rejects(api.clientHandler!({ operation: 'executeCommand', command: 'test.extension.missingCommand', arguments: [] }, signal, source), /Unknown command/);
});

test('task provider presentation retains optional panel and clear values and rejects invalid host data', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.panels'));
	using languages = new LanguageFeaturesService();
	const tasks = new ProviderSink<TaskProvider>();
	using services = createServices(api, languages, tasks, new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const provider = tasks.providers[0]!;
	const valid: readonly JsonValue[] = [{}, { panel: 'shared' }, { panel: 'dedicated', clear: false }, { panel: 'new', clear: true }, { clear: true }];
	for (const presentation of valid) {
		api.invocationResult = Promise.resolve({ tasks: [{ id: 'build', label: 'Build', command: 'builder', group: 'build', presentation }] });
		assert.deepEqual((await provider.provideTasks(new AbortController().signal))[0]!.presentation, presentation);
	}
	const invalid: readonly JsonValue[] = [null, [], { panel: 1 }, { panel: 'invalid' }, { clear: 'true' }, { focus: 'true' }];
	for (const presentation of invalid) {
		api.invocationResult = Promise.resolve({ tasks: [{ id: 'build', label: 'Build', command: 'builder', group: 'build', presentation }] });
		await assert.rejects(async () => provider.provideTasks(new AbortController().signal));
	}
});

test('document highlights translate protocol kinds into editor kinds', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('heading', { languageId: 'markdown' });
	using source = new CancellationTokenSource();
	using registration = languages.registerProviderBatch(createExtensionHostLanguageProviderBatch({
		kind: 'languageProvider', registrationId: 'highlights', languageIds: ['markdown'], operations: ['documentHighlights'],
	}, 'markdown', 'highlights', async () => [1, 2, 3].map(kind => ({
		kind, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 7 } },
	}))));
	const result = await languages.documentHighlightProvider.ordered(model)[0]!.provideDocumentHighlights(model, new Position(1, 3), source.token);
	assert.deepEqual(result?.map(highlight => highlight.kind), [0, 1, 2]);
});

test('document subscriptions deliver model commits in order and retire on restart and disconnect', async () => {
	const registration = { kind: 'textDocumentEvents' as const, registrationId: 'documents' };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [registration]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const models = services.get(IModelService);
	const model = models.createModel('😀', null, URI.file('/main.ts'));
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	await waitFor(() => api.invocations.length === 1);
	const pending = deferred<JsonValue>();
	api.invocationResult = pending.promise;
	model.applyEdits([{ range: new Range(1, 3, 1, 3), text: 'a' }]);
	model.applyEdits([{ range: new Range(1, 4, 1, 4), text: 'b' }]);
	await waitFor(() => api.invocations.length === 2);
	assert.equal(api.invocations.length, 2, 'second commit waits for the first callback');
	api.invocationResult = undefined;
	pending.resolve(null);
	await waitFor(() => api.invocations.length === 3);
	assert.deepEqual(api.invocations.map(request => request.payload), [
		{ type: 'open', document: { uri: model.uri.toString(), version: 1, languageId: 'plaintext', text: '😀' } },
		{ type: 'change', document: { uri: model.uri.toString(), version: 2, languageId: 'plaintext', text: '😀a' }, reason: 'edit', contentChanges: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, rangeOffset: 2, rangeLength: 0, text: 'a' }] },
		{ type: 'change', document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: '😀ab' }, reason: 'edit', contentChanges: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, rangeOffset: 3, rangeLength: 0, text: 'b' }] },
	]);
	api.current = { generation: 2, extensions: [{ ...api.current.extensions[0]!, incarnation: 4 }] };
	api.emitChanged(2);
	await waitFor(() => api.invocations.length === 4);
	assert.equal(api.invocationSignals[0]!.aborted, true);
	assert.equal(api.invocations[3]!.incarnation, 4);
	assert.deepEqual(api.invocations[3]!.payload, { type: 'open', document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: '😀ab' } });
	model.dispose();
	await waitFor(() => api.invocations.length === 5);
	assert.deepEqual(api.invocations[4]!.payload, { type: 'close', document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: '😀ab' } });
	api.emitConnection('restarting');
	assert.equal(api.invocationSignals[4]!.aborted, true);
	const next = models.createModel('after disconnect', null, URI.file('/next.ts'));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(api.invocations.length, 5);
	next.dispose();
});

test('diagnostic collections reject stale versions and keep extension ownership through retirement', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run'));
	api.current = { ...api.current, extensions: [...api.current.extensions, { ...api.current.extensions[0]!, id: 'acme.other', registrations: [] }] };
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const model = services.get(IModelService).createModel('bad', null, URI.file('/main.ts'));
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	const markers = services.get(IMarkerService);
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const other = { ...source, extensionId: 'acme.other' };
	const diagnostic = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, severity: 'warning' as const, message: 'Bad word', source: 'lint', code: 'W1' };
	const entries = [{ uri: model.uri.toString(), version: 1, diagnostics: [diagnostic] }];
	const signal = new AbortController().signal;
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries }, signal, source);
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries }, signal, other);
	assert.equal(markers.read(model.uri).length, 2);
	model.setValue('good');
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries: [{ ...entries[0]!, diagnostics: [] }] }, signal, source);
	assert.equal(markers.read(model.uri).length, 2, 'old replacement cannot clear current diagnostics');
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries: [] }, signal, source);
	assert.equal(markers.read(model.uri).length, 1, 'other extension owns its collection');
	api.current = { generation: 2, extensions: [{ ...api.current.extensions[0]!, incarnation: 4 }] };
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(markers.read(model.uri).length, 0);
	await assert.rejects(api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries: [] }, signal, source), /retired extension/);
	model.dispose();
});

test('document callback errors do not suppress later commits and language changes close then reopen', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'textDocumentEvents', registrationId: 'documents' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const model = services.get(IModelService).createModel('initial', null, URI.file('/main.ts'));
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	await waitFor(() => api.invocations.length === 1);
	api.invocationResult = Promise.reject(new Error('Extension listener failed'));
	// Dispatch in the same turn so the rejection is consumed by the real subscription.
	model.setValue('failed callback');
	await waitFor(() => api.invocations.length === 2);
	api.invocationResult = undefined;
	model.setValue('next commit');
	await waitFor(() => api.invocations.length === 3);
	using languageRegistration = services.get(ILanguageService).registerLanguage({ id: 'typescript' });
	model.setLanguage(services.get(ILanguageService).createById('typescript'));
	await waitFor(() => api.invocations.length === 5);
	assert.deepEqual(api.invocations.slice(3).map(request => request.payload), [
		{ type: 'close', document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: 'next commit' } },
		{ type: 'open', document: { uri: model.uri.toString(), version: 3, languageId: 'typescript', text: 'next commit' } },
	]);
	model.dispose();
});

test('extension editor menus capture the clicked input and reject malformed replacement menus before commit', async () => {
	const placement = { menu: 'editor/title/context', when: 'resourceLangId == markdown', group: 'navigation@1' };
	const registration = { kind: 'command' as const, registrationId: 'preview', command: 'acme.preview', title: 'Preview', menus: [placement] };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.old', [registration]));
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const inputs = [{ resource: URI.file('/notes/clicked.md') }, { resource: URI.file('/notes/active.md') }];
	const group = { id: 'clicked-group', inputs, activeInput: inputs[1] };
	services.registerInstance(IEditorPart, { groups: [group], activeGroup: group } as unknown as IEditorPart);
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	await services.invokeFunction(accessor => commands.getCommand('acme.preview')!(accessor, { groupId: group.id, editorIndex: 0 }));
	assert.deepEqual(JSON.parse(JSON.stringify(api.invocations[0]!.payload)), {
		arguments: [{ groupId: group.id, editorIndex: 0 }],
		activeEditor: { resource: inputs[0]!.resource.toJSON(), groupId: group.id, editorIndex: 0 },
	});
	const placements = MenusRegistry.getMenuItems(MenuId.EditorTitleContext).filter(item => 'command' in item && item.command.id === 'acme.preview');
	assert.equal(placements.length, 1);
	api.current = snapshot(2, 'acme.new', [{ ...registration, menus: [{ ...placement, group: 'navigation@bad-order' }] }]);
	await service.reload();
	assert.equal(service.state, 'degraded');
	assert.equal(commands.hasCommand('acme.old'), true);
	assert.equal(commands.hasCommand('acme.new'), false);
	assert.deepEqual(MenusRegistry.getMenuItems(MenuId.EditorTitleContext).filter(item => 'command' in item && item.command.id === 'acme.preview'), placements);
});

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
	const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] }, 'acme.formatter', 'formatter', async (operation, value, cancellation) => {
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
	const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] }, 'acme.formatter', 'formatter', async (operation, value, cancellation) => {
		assert.equal(operation, 'formatting');
		payload = value;
		signal = cancellation;
		return { edits: [] };
	});
	using registration = languages.registerProviderBatch(batch);
	const provider = languages.documentFormattingEditProvider.ordered(model)[0]!;
	assert.equal(provider.extensionId?.value, 'acme.formatter');
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
	const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] }, 'acme.formatter', 'formatter', async (_operation, _payload, cancellation) => {
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
	using services = createServices(api, languages, tasks, tests);
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));

	await service.start();
	assert.equal(service.currentSnapshot.fleetGeneration, 1);
	assert.equal(service.state, "ready");
	assert.equal(failures.length, 0);
	assert.ok(commands.hasCommand("acme.old"));

	const handler = commands.getCommand("acme.old")!;
	assert.deepEqual(await handler({} as ServicesAccessor, "argument"), { executed: true });
	assert.equal(api.invocations[0]?.activationGeneration, 11);
	assert.equal(api.invocations[0]?.incarnation, 3);
	const payload = api.invocations[0]?.payload;
	assert.deepEqual(typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as { readonly arguments?: JsonValue; }).arguments : undefined, ["argument"]);

	assert.deepEqual(await tasks.providers[0]!.provideTasks(new AbortController().signal), [{ id: "unit", label: "Unit", command: "pnpm test", group: "test" }]);
	assert.deepEqual(await tests.providers[0]!.provideTestProfiles(new AbortController().signal), [{ id: "unit", label: "Unit", taskId: "extension:extensionHost.61636d652e64656d6f.7461736b73:unit" }]);

	using descriptorSession = new MockDebugSession('debug-registration', 'Host', {});
	assert.deepEqual(await DebugAdapterFactoriesRegistry.get('acme')!.createDebugAdapterDescriptor!({ id: 'launch', name: 'Host', type: 'acme', request: 'launch', arguments: { program: '/workspace/app' } }, new AbortController().signal, descriptorSession), { program: 'hosted-adapter', arguments: ['', ' literal '] });
	assert.equal(api.invocations.at(-1)?.registrationId, 'debug');
	api.invocationResult = Promise.resolve(null);
	assert.equal(await DebugAdapterFactoriesRegistry.get('acme')!.createDebugAdapterDescriptor!({ id: 'empty', name: 'Empty', type: 'acme', request: 'launch', arguments: {} }, new AbortController().signal, descriptorSession), undefined);
	api.invocationResult = Promise.resolve({});
	await assert.rejects(Promise.resolve(DebugAdapterFactoriesRegistry.get('acme')!.createDebugAdapterDescriptor!({ id: 'invalid', name: 'Invalid', type: 'acme', request: 'launch', arguments: {} }, new AbortController().signal, descriptorSession)), /Extension Debug Adapter descriptor has an invalid shape/);
	api.invocationResult = undefined;

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
	assert.equal(DebugAdapterFactoriesRegistry.get("acme"), undefined);
	assert.equal(service.state, "failed");
	api.emitConnection("ready");
	await waitFor(() => commands.hasCommand("acme.latest"));
});

test("projects supported language operations while diagnosing unsupported operations", async () => {
	const current = snapshot(1, "acme.run", [{ registrationId: "language", kind: "languageProvider", languageIds: ["typescript"], operations: ["hover", "parameterHints", "definition", "documentColors"] }]);
	const api = new FakeExtensionHostApi(current);
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, tests);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));
	await service.start();

	using model = new TextModel("answer", { languageId: "typescript" });
	const signal = new AbortController().signal;
	const request = {
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		position: new Position(1, 2),
		context: {
			kind: 'triggerCharacter' as const, triggerCharacter: ',', isRetrigger: true,
			activeSignatureHelp: { activeSignature: 0, signatures: [{ label: 'fn(value)', parameters: [{ label: 'value' }], activeParameter: 0 }] },
		},
	};
	assert.deepEqual(await languages.hoverProvider.ordered(model)[0]!.provideHover(request, signal), { contents: ["Host hover"] });
	assert.deepEqual(await languages.signatureHelpProvider.ordered(model)[0]!.provideParameterHints(request, signal), { signatures: [{ label: "fn(value)", parameters: [{ label: "value" }], activeParameter: 0 }], activeSignature: 0 });
	assert.deepEqual((api.invocations.find(request => request.operation === "hover")!.payload as { readonly position: unknown; }).position, { lineIndex: 0, columnIndex: 1 });
	assert.deepEqual((api.invocations.find(request => request.operation === "parameterHints")!.payload as { readonly position: unknown; }).position, { lineIndex: 0, columnIndex: 1 });
	assert.deepEqual((api.invocations.find(request => request.operation === 'parameterHints')!.payload as { readonly context: unknown; }).context, request.context);
	assert.equal(service.state, "degraded");
	assert.ok(failures.includes("unsupportedRegistrationBridge"));
});

test("keeps the service stopped when the negotiated Host capability is absent", async () => {
	const api = new FakeExtensionHostApi(snapshot(1, "acme.run"));
	api.available = false;
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, tests);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
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
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using services = createServices(api, languages, tasks, tests, output);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
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
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	const reveals: string[] = [];
	output.onDidRequestShowChannel(request => reveals.push(request.focus));
	using services = createServices(api, languages, tasks, tests, output);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
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

test('extension API requires its domain services before registering any contributions', () => {
	using services = new InstantiationService();
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using diagnostics = output.createChannel({ id: 'host-diagnostics', label: 'Host' });
	const commands = new CommandRegistry();
	services.registerInstance(IExtensionHostApi, new FakeExtensionHostApi(snapshot(1, 'acme.run')));
	assert.throws(() => services.createInstance(MainThreadExtensionApi, commands, 1_000, diagnostics), /Unknown service: ILanguageFeaturesService/);
	assert.deepEqual(commands.getCommandIds(), []);
	assert.deepEqual(output.channels.map(channel => channel.id), ['host-diagnostics']);
});

test('extension API restores all previous registrations when a provider rejects a replacement', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.old'));
	const commands = new CommandRegistry();
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, tests);
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const previousTasks = tasks.providers;
	const previousTests = tests.providers;
	const failures: string[] = [];
	using listener = service.onDidFail(failure => failures.push(failure.code));
	tests.rejectNextReplacement = new Error('Test provider rejected replacement');
	api.current = snapshot(2, 'acme.new');
	api.emitChanged(2);
	await waitFor(() => failures.includes('registrationProjectionFailed'));
	assert.deepEqual(commands.getCommandIds(), ['acme.old']);
	assert.deepEqual(tasks.providers, previousTasks);
	assert.deepEqual(tests.providers, previousTests);
	assert.equal(service.currentSnapshot.fleetGeneration, 1);
	assert.deepEqual(await commands.getCommand('acme.old')!({} as ServicesAccessor), { executed: true });
});

test('extension API cancels old invocations and rejects results from replaced registrations', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.old'));
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const result = deferred<JsonValue>();
	api.invocationResult = result.promise;
	const oldHandler = commands.getCommand('acme.old')!;
	const pending = Promise.resolve(oldHandler({} as ServicesAccessor));
	const rejected = assert.rejects(pending, error => error === 'Extension Host fleet generation was replaced');
	api.current = snapshot(2, 'acme.new');
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(api.invocationSignals[0]?.aborted, true);
	result.resolve({ executed: true });
	await rejected;
	await assert.rejects(async () => oldHandler({} as ServicesAccessor), error => error === 'Extension Host fleet generation was replaced');
	assert.equal(api.invocations.length, 1);
	api.invocationResult = undefined;
	assert.deepEqual(await commands.getCommand('acme.new')!({} as ServicesAccessor), { executed: true });
});

test('status bar content snapshots keep a pending command alive and disconnect releases its entry', async () => {
	const status = { kind: 'statusBar' as const, registrationId: 'status', revision: 1, entries: [] };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [status]));
	const initialRuntime = { ...api.current.extensions[0]! };
	api.current = { ...api.current, extensions: [initialRuntime] };
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const result = deferred<JsonValue>();
	api.invocationResult = result.promise;
	const handler = commands.getCommand('acme.run')!;
	const pending = Promise.resolve(handler({} as ServicesAccessor));
	const entry = { id: 'item', text: 'Current', tooltip: null, ariaLabel: null, alignment: 'right' as const, priority: 1.5, command: null };
	api.current = snapshot(2, 'acme.run', [{ ...status, revision: 2, entries: [entry] }], '', [], 11);
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(commands.getCommand('acme.run'), handler);
	assert.equal(api.invocationSignals[0]!.aborted, false);
	result.resolve({ completed: true });
	assert.deepEqual(await pending, { completed: true });
	// The unchanged command belongs to the process, not to the retired UI snapshot.
	for (const property of ['id', 'activationGeneration', 'incarnation']) {
		Object.defineProperty(initialRuntime, property, { get: () => { throw new Error('Retired UI snapshot was accessed'); } });
	}
	assert.deepEqual(await handler({} as ServicesAccessor), { completed: true });
	const statusbar = services.get(IStatusbarService);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]!.entry.text, 'Current');
	api.emitConnection('restarting');
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
});

test('extension API releases named output and providers when its host stops', async () => {
	const events: readonly ExtensionHostOutputEvent[] = [
		{ sequence: 1, incarnation: 3, activationGeneration: 11, operation: { operation: 'create', channelId: 'review', label: 'Review', kind: 'output' } },
	];
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [], '', events));
	const commands = new CommandRegistry();
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, tests, output);
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	assert.ok(output.getChannel('extension.acme.demo.review'));
	await service.stop();
	assert.equal(output.getChannel('extension.acme.demo.review'), undefined);
	assert.deepEqual(commands.getCommandIds(), []);
	assert.deepEqual(tasks.providers, []);
	assert.deepEqual(tests.providers, []);
	await service.start();
	assert.ok(output.getChannel('extension.acme.demo.review'));
	api.emitConnection('crashed');
	assert.equal(output.getChannel('extension.acme.demo.review'), undefined);
});

test('extension API resets output for a new process and ignores stale output events', async () => {
	const events: readonly ExtensionHostOutputEvent[] = [
		{ sequence: 1, incarnation: 3, activationGeneration: 11, operation: { operation: 'create', channelId: 'review', label: 'Review', kind: 'output' } },
		{ sequence: 2, incarnation: 3, activationGeneration: 11, operation: { operation: 'append', channelId: 'review', text: 'old', severity: 'log', category: undefined } },
	];
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [], '', events));
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), output);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	const previous = output.getChannel('extension.acme.demo.review');
	assert.equal(previous?.getText(), 'old');
	const nextEvents: readonly ExtensionHostOutputEvent[] = [
		{ ...events[0]!, incarnation: 4 },
		{ sequence: 99, incarnation: 3, activationGeneration: 11, operation: { operation: 'append', channelId: 'review', text: 'stale', severity: 'log', category: undefined } },
		{ sequence: 2, incarnation: 4, activationGeneration: 11, operation: { operation: 'append', channelId: 'review', text: 'new', severity: 'log', category: undefined } },
	];
	api.current = { generation: 2, extensions: [{ ...api.current.extensions[0]!, incarnation: 4, outputEvents: nextEvents }] };
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.notEqual(output.getChannel('extension.acme.demo.review'), previous);
	assert.equal(output.getChannel('extension.acme.demo.review')?.getText(), 'new');
});

class FixtureLifecycleService extends AbstractLifecycleService { }

class FakeExtensionHostApi implements IExtensionHostApi {
	async start(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Startup is outside this fixture'); }
	public clientHandler: Parameters<IExtensionHostApi['registerClientHandler']>[0] | undefined;
	public registerClientHandler(handler: Parameters<IExtensionHostApi['registerClientHandler']>[0]): { dispose(): void; } {
		this.clientHandler = handler;
		return { dispose: () => { this.clientHandler = undefined; } };
	}
	readonly activations: Parameters<IExtensionHostApi['activateByEvent']>[0][] = [];
	activationResult: Promise<ExtensionHostFleetSnapshot> | undefined;
	async activateByEvent(request: Parameters<IExtensionHostApi['activateByEvent']>[0]): Promise<ExtensionHostFleetSnapshot> {
		this.activations.push(request);
		assert.ok(this.activationResult, 'Unexpected activation request');
		return this.activationResult;
	}
	invocationResult: Promise<JsonValue> | undefined;
	readonly invocationSignals: AbortSignal[] = [];
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
		this.invocationSignals.push(signal);
		if (this.invocationResult) return this.invocationResult;
		if (request.operation === 'documentEvent' || request.operation === 'workspaceEvent') return null;
		if (request.operation === 'resolveConnection') return { connectionName: 'build' };
		if (request.operation === "execute") return Object.freeze({ executed: true });
		if (request.operation === 'createDebugAdapterDescriptor') return { program: 'hosted-adapter', arguments: ['', ' literal '] };
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
	readonly onDidStartTask = Event.None;
	readonly onDidChangeTaskRun = Event.None;
	readonly onWillNewSession = Event.None;
	readonly onDidNewSession = Event.None;
	readonly onDidEndSession = Event.None;
	readonly onDidChangeSession = Event.None;
	readonly onDidFocusStackFrame = Event.None;
	readonly onDidChangeBreakpoints = Event.None;
	readonly breakpoints = [];
	readonly functionBreakpoints = [];
	readonly activeRuns = Object.freeze([]);
	readonly sessions = Object.freeze([]);
	readonly session = undefined;
	providers: readonly TProvider[] = Object.freeze([]);
	rejectNextReplacement: Error | undefined;

	registerDebugAdapterTrackerFactories(_providers: readonly IDebugAdapterTrackerFactory[]): DebugAdapterTrackerFactoryRegistration {
		const registration = toDisposable(() => { }) as DebugAdapterTrackerFactoryRegistration;
		registration.replace = () => { };
		return registration;
	}

	registerDebugConfigurationProviders(providers: readonly IDebugConfigurationProvider[]): DebugConfigurationProviderRegistration { return this.registration(providers as readonly TProvider[]) as DebugConfigurationProviderRegistration; }

	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration { return this.registration(providers as readonly TProvider[]) as TaskProviderRegistration; }
	registerTestProfileProviders(providers: readonly TestProfileProvider[]): TestProfileProviderRegistration { return this.registration(providers as readonly TProvider[]) as TestProfileProviderRegistration; }

	private registration(initial: readonly TProvider[]): TaskProviderRegistration | TestProfileProviderRegistration | DebugConfigurationProviderRegistration {
		let disposed = false;
		this.providers = Object.freeze([...initial]);
		const registration = toDisposable(() => { disposed = true; this.providers = Object.freeze([]); }) as TaskProviderRegistration;
		registration.replace = providers => {
			if (disposed) throw new ReferenceError("Provider registration is disposed");
			if (this.rejectNextReplacement) {
				const error = this.rejectNextReplacement;
				this.rejectNextReplacement = undefined;
				throw error;
			}
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

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; } {
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

function createServices(api: IExtensionHostApi, languages: ILanguageFeaturesService, tasks: ProviderSink<TaskProvider>, tests: ProviderSink<TestProfileProvider>, output?: IOutputService, debug = new ProviderSink<IDebugConfigurationProvider>(), remote?: { connections: IRemoteConnectionApi; confirm: IDialogService['confirm']; }): InstantiationService {
	const services = workbenchInstantiationService(undefined, undefined, { languageFeatures: languages, output });
	services.registerSingleton(IExtensionService, () => new TestExtensionService());
	services.registerInstance(IExtensionHostApi, api);
	services.registerInstance(IHostService, {
		hasFocus: true, onDidChangeFocus: Event.None, openWindow: async () => assert.fail('Unexpected window'),
		restart: async () => assert.fail('Unexpected restart'), getScreenshot: async () => undefined,
	});
	services.registerInstance(IRemoteConnectionApi, remote?.connections ?? UnavailableRemoteConnectionApi);
	services.registerSingleton(IRemoteConnectionService, () => services.createInstance(RemoteConnectionService));
	services.registerInstance(IDialogService, {
		onWillShowDialog: Event.None, onDidShowDialog: Event.None,
		confirm: remote?.confirm ?? (() => assert.fail('Unexpected Remote confirmation')),
		showMessage: () => assert.fail('Unexpected dialog'),
		info: () => assert.fail('Unexpected dialog'), warn: () => assert.fail('Unexpected dialog'), error: () => assert.fail('Unexpected dialog'),
		about: () => assert.fail('Unexpected dialog'), prompt: () => assert.fail('Unexpected dialog'), input: () => assert.fail('Unexpected dialog'),
	});
	services.registerSingleton(IMarkerService, () => services.createInstance(MarkerService));
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(ILifecycleService, () => services.createInstance(FixtureLifecycleService, undefined));
	services.registerInstance(ITaskService, tasks as unknown as ITaskService);
	services.registerInstance(IDebugService, debug as unknown as IDebugService);
	services.registerInstance(ITestingService, tests as unknown as ITestingService);
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerSingleton(INotificationService, () => services.createInstance(NotificationService));
	// These scenarios exercise registrations and provider calls, never edits or Quick Input UI.
	services.registerInstance(IBulkEditService, {
		_serviceBrand: undefined,
		hasPreviewHandler: () => assert.fail('Unexpected bulk edit request'),
		setPreviewHandler: () => assert.fail('Unexpected bulk edit request'),
		apply: () => assert.fail('Unexpected bulk edit request'),
	});
	services.registerInstance(IQuickInputService, {
		createQuickPick: () => assert.fail('Unexpected Quick Input request'),
		input: () => assert.fail('Unexpected Quick Input request'),
	});

	return services;
}

function dormantSnapshot(events: readonly string[] = ['onCommand:acme.lazy']): ExtensionHostFleetSnapshot {
	const ready = snapshot(1, 'acme.lazy');
	return Object.freeze({
		...ready, extensions: Object.freeze([Object.freeze({
			...ready.extensions[0]!, incarnation: undefined, lifecycle: 'dormant' as const,
			activation: Object.freeze({ events: Object.freeze([...events]), commands: Object.freeze([{ command: 'acme.lazy', title: 'Lazy command' }]) }),
			registrations: Object.freeze([]),
		})])
	});
}

test('declared command starts on first use and invokes the actual registered incarnation', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot());
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	assert.equal(service.state, 'ready');
	assert.equal(service.currentSnapshot.extensions[0]!.state, 'dormant');
	assert.equal(service.currentSnapshot.extensions[0]!.incarnation, undefined);
	assert.equal(commands.hasCommand('acme.lazy'), true);
	assert.equal(api.activations.length, 0);
	assert.equal(api.invocations.length, 0);
	// Publishing ready replaces the command batch while the original first-use handler waits.
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	const result = services.invokeFunction(accessor => commands.getCommand('acme.lazy')!(accessor, 'first'));
	api.current = snapshot(2, 'acme.lazy', [], '', [], 11);
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.extensions[0]?.state === 'ready');
	activation.resolve(api.current);
	assert.deepEqual(await result, { executed: true });
	assert.deepEqual(api.activations.map(({ initialization, ...request }) => request), [{ extensionId: 'acme.demo', activationGeneration: 11, event: { type: 'command', command: 'acme.lazy' } }]);
	assert.ok(api.activations[0]!.initialization);
	assert.deepEqual(api.activations[0]!.initialization!.workspaceFolders, services.get(IWorkspaceContextService).getWorkspace().folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name, index: folder.index })));
	assert.deepEqual(api.activations[0]!.initialization!.configurationValues, services.get(IConfigurationService).getValue());
	assert.equal(api.invocations.length, 1);
	assert.equal(api.invocations[0]!.incarnation, 3);
	assert.deepEqual(JSON.parse(JSON.stringify(api.invocations[0]!.payload)), { arguments: ['first'] });
});

test('disconnect during first-use activation prevents command execution', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot());
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const result = services.invokeFunction(accessor => commands.getCommand('acme.lazy')!(accessor));
	api.emitConnection('stopped');
	activation.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
	await assert.rejects(Promise.resolve(result));
	assert.equal(api.invocations.length, 0);
	assert.equal(commands.hasCommand('acme.lazy'), false);
});

test('already open language models activate matching extensions once while startup awaits restoration', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onLanguage:typescript']));
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const models = services.get(IModelService);
	using language = services.get(ILanguageService).registerLanguage({ id: 'typescript' });
	using model = models.createModel('unsaved', services.get(ILanguageService).createById('typescript'), URI.file('/project/main.ts'));
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	await service.reload();
	assert.equal(api.activations.length, 1);
	assert.deepEqual(api.activations[0]!.event, { type: 'language', languageId: 'typescript' });
	activation.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
	await waitFor(() => service.currentSnapshot.extensions[0]?.state === 'ready');
});

test('new model and language change use current editor language for activation', async () => {
	for (const trigger of ['create', 'change']) {
		const api = new FakeExtensionHostApi(dormantSnapshot(['onLanguage:typescript']));
		api.activationResult = Promise.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
		using languages = new LanguageFeaturesService();
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
		const models = services.get(IModelService);
		const languageService = services.get(ILanguageService);
		using language = languageService.registerLanguage({ id: 'typescript' });
		using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
		await service.start();
		assert.equal(api.activations.length, 0);
		using model = models.createModel('text', languageService.createById(trigger === 'create' ? 'typescript' : 'plaintext'), URI.file('/project/main.ts'));
		if (trigger === 'change') { model.setLanguage(languageService.createById('typescript')); }
		await waitFor(() => service.currentSnapshot.extensions[0]?.state === 'ready');
		assert.equal(api.activations.length, 1);
	}
});

test('startupFinished waits for window restoration and ignores replies after stop', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onStartupFinished']));
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	assert.equal(api.activations.length, 0);
	services.get(ILifecycleService).phase = LifecyclePhase.Restored;
	await waitFor(() => api.activations.length === 1);
	assert.deepEqual(api.activations[0]!.event, { type: 'startupFinished' });
	await service.stop();
	activation.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
	await activation.promise;
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(service.state, 'stopped');
	assert.equal(service.currentSnapshot.extensions.length, 0);
});


test('Debug configuration callbacks receive the canonical folder and retire with the extension incarnation', async () => {
	const registration = { kind: 'debugConfigurationProvider' as const, registrationId: 'configurations', debuggerType: 'acme', triggerKind: 1 as const };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [registration]));
	using languages = new LanguageFeaturesService();
	const debug = new ProviderSink<IDebugConfigurationProvider>();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, debug);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	assert.equal(debug.providers.length, 1);
	const provider = debug.providers[0]!;
	const folder = URI.file('/workspace');
	const config = { name: 'Generated', type: 'acme', request: 'launch' as const, program: '${workspaceFolder}/app' };
	api.invocationResult = Promise.resolve({ configurations: [config] });
	assert.deepEqual(await provider.provideDebugConfigurations!(folder, new AbortController().signal), [config]);
	assert.deepEqual(api.invocations[0]!.payload, { folder: { uri: folder.toString(), name: 'workspace', index: 0 } });
	api.invocationResult = Promise.resolve({ configuration: config });
	assert.deepEqual(await provider.resolveDebugConfiguration!(folder, config, new AbortController().signal), config);
	assert.equal(api.invocations[1]!.operation, 'resolveDebugConfiguration');
	api.invocationResult = Promise.resolve({ configuration: null });
	assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables!(folder, config, new AbortController().signal), null);
	for (const callback of [provider.resolveDebugConfiguration!, provider.resolveDebugConfigurationWithSubstitutedVariables!]) {
		api.invocationResult = Promise.resolve({ cancelled: true });
		assert.equal(await callback(folder, config, new AbortController().signal), undefined);
		api.invocationResult = Promise.resolve({ configuration: null });
		assert.equal(await callback(folder, config, new AbortController().signal), null);
		for (const invalid of [null, config, { cancelled: false }, { cancelled: true, configuration: config }, { configuration: null, extra: true }] as JsonValue[]) {
			api.invocationResult = Promise.resolve(invalid);
			await assert.rejects(async () => callback(folder, config, new AbortController().signal), TypeError);
		}
	}
	api.emitConnection('restarting');
	assert.deepEqual(debug.providers, []);
	await assert.rejects(async () => provider.resolveDebugConfiguration!(folder, config, new AbortController().signal));
});

test('task discovery and debug phases activate only matching dormant extension owners', async () => {
	for (const { declarations, ignored, event, expected } of [
		{ declarations: ['onTaskType:build'], ignored: 'onTaskType:test', event: 'onTaskType', expected: { type: 'taskType', taskType: 'build' } },
		{ declarations: ['onTaskType'], ignored: 'onDebug', event: 'onTaskType', expected: { type: 'taskType', taskType: null } },
		{ declarations: ['onDebugResolve:node'], ignored: 'onDebugResolve:python', event: 'onDebugResolve:node', expected: { type: 'debug', phase: 'resolveConfiguration', debugType: 'node' } },
		{ declarations: ['onDebugInitialConfigurations'], ignored: 'onDebugDynamicConfigurations', event: 'onDebugInitialConfigurations', expected: { type: 'debug', phase: 'initialConfigurations', debugType: null } },
		{ declarations: ['onDebugDynamicConfigurations'], ignored: 'onDebugInitialConfigurations', event: 'onDebugDynamicConfigurations', expected: { type: 'debug', phase: 'dynamicConfigurations', debugType: null } },
		{ declarations: ['onDebugDynamicConfigurations:node'], ignored: 'onDebugDynamicConfigurations:python', event: 'onDebugDynamicConfigurations', expected: { type: 'debug', phase: 'dynamicConfigurations', debugType: 'node' } },
	]) {
		const api = new FakeExtensionHostApi(dormantSnapshot(declarations));
		api.activationResult = Promise.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
		using languages = new LanguageFeaturesService();
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
		using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
		await host.start();
		const extensions = services.get(IExtensionService);
		await extensions.activateByEvent(ignored);
		assert.equal(api.activations.length, 0);
		await extensions.activateByEvent(event);
		assert.deepEqual(api.activations.map(({ initialization, ...request }) => request), [{ extensionId: 'acme.demo', activationGeneration: 11, event: expected }]);
		assert.deepEqual(api.activations[0]!.initialization!.configurationValues, services.get(IConfigurationService).getValue());
		assert.equal(host.currentSnapshot.extensions[0]!.state, 'ready');
	}
});

test('canceling task activation releases the discovery waiter and never applies a reply after disconnect', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onTaskType:build']));
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const controller = new AbortController();
	const discovery = assert.rejects(services.get(IExtensionService).activateByEvent('onTaskType', controller.signal));
	await waitFor(() => api.activations.length === 1);
	controller.abort();
	await discovery;
	api.emitConnection('stopped');
	activation.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
	await activation.promise;
	assert.equal(host.currentSnapshot.extensions.length, 0);
});


test('a failed dormant owner rejects task discovery instead of presenting activation as successful', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onTaskType:build']));
	const ready = snapshot(2, 'acme.lazy', [], '', [], 11);
	api.activationResult = Promise.resolve({ ...ready, extensions: [{ ...ready.extensions[0]!, lifecycle: 'failed', incarnation: undefined, registrations: [] }] });
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	await assert.rejects(services.get(IExtensionService).activateByEvent('onTaskType'), /failed/);
	assert.equal(host.currentSnapshot.extensions[0]!.state, 'failed');
});

test('activating a task-only owner preserves existing debug providers and pending calls until their own owner retires', async () => {
	const configuration = { kind: 'debugConfigurationProvider' as const, registrationId: 'configurations', debuggerType: 'acme', triggerKind: 1 as const };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [configuration]));
	const original = api.current.extensions[0]!;
	const tasks = new ProviderSink<TaskProvider>();
	const debug = new ProviderSink<IDebugConfigurationProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, new ProviderSink<TestProfileProvider>(), undefined, debug);
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const provider = debug.providers[0]!;
	const adapter = DebugAdapterFactoriesRegistry.get('acme');
	const result = deferred<JsonValue>();
	api.invocationResult = result.promise;
	const pending = provider.resolveDebugConfiguration!(URI.file('/workspace'), { name: 'Resolve', type: 'acme', request: 'launch' }, new AbortController().signal);
	const next = { ...original, id: 'acme.lazy-task', registrations: [{ kind: 'taskProvider' as const, registrationId: 'build', taskType: 'builder' }] };
	api.current = { generation: 2, extensions: [original, next] };
	api.emitChanged(2);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 2);
	assert.equal(debug.providers[0], provider);
	assert.equal(DebugAdapterFactoriesRegistry.get('acme'), adapter);
	assert.equal(api.invocationSignals[0]!.aborted, false);
	result.resolve({ configuration: { name: 'Resolved', type: 'acme', request: 'launch' } });
	assert.equal((await pending)?.name, 'Resolved');
	assert.equal(tasks.providers.length, 2);
	const retiredResult = deferred<JsonValue>();
	api.invocationResult = retiredResult.promise;
	const retirement = assert.rejects(async () => provider.resolveDebugConfiguration!(URI.file('/workspace'), { name: 'Resolve', type: 'acme', request: 'launch' }, new AbortController().signal));
	api.current = { generation: 3, extensions: [next] };
	api.emitChanged(3);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 3);
	assert.equal(api.invocationSignals[1]!.aborted, true);
	retiredResult.resolve(null);
	await retirement;
	assert.equal(debug.providers.length, 0);
});


test('wildcard startup binds actual window facts before restoration', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['*']));
	api.activationResult = Promise.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	await waitFor(() => service.currentSnapshot.extensions[0]?.state === 'ready');
	assert.equal(api.activations.length, 1);
	assert.deepEqual(api.activations[0]!.event, { type: 'startupFinished' });
	assert.deepEqual(api.activations[0]!.initialization!.configurationValues, services.get(IConfigurationService).getValue());
	assert.deepEqual(api.activations[0]!.initialization!.workspaceFolders, services.get(IWorkspaceContextService).getWorkspace().folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name, index: folder.index })));
});

test('configuration bridge preserves owner commit order, falsy values, language changes and retirement', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'workspaceEvents', registrationId: 'window' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'sample.enabled', defaultValue: true, parse: value => Boolean(value) });
	registry.registerConfiguration({ key: 'sample.count', defaultValue: 1, parse: value => Number(value) });
	using configuration = new InMemoryConfigurationService(registry);
	using scope = services.createChild();
	scope.registerInstance(IConfigurationService, configuration);
	const errors: unknown[] = [];
	using bridge = scope.createInstance(MainThreadConfiguration, 1_000, (error: unknown) => errors.push(error));
	const gate = deferred<JsonValue>();
	api.invocationResult = gate.promise;
	bridge.update(api.current);
	await waitFor(() => api.invocations.length === 1);
	await configuration.updateValue('sample.enabled', false);
	await configuration.updateValue('sample.count', 0);
	assert.equal(api.invocations.length, 1, 'later commits wait for the earlier delivery');
	gate.resolve(null);
	await waitFor(() => api.invocations.length === 3);
	assert.deepEqual(api.invocations.map(request => (request.payload as Record<string, JsonValue>).configurationValues), normalizeExtensionHostPayload([
		{ sample: { enabled: true, count: 1 } }, { sample: { enabled: false, count: 1 } }, { sample: { enabled: false, count: 0 } },
	]));
	await configuration.updateValue('sample.enabled', true, { overrideIdentifiers: ['typescript'] });
	await waitFor(() => api.invocations.length === 4);
	assert.deepEqual((api.invocations[3]!.payload as Record<string, JsonValue>).change, normalizeExtensionHostPayload({ keys: [], overrides: [['typescript', ['sample.enabled']]] }));
	const previous = api.invocationSignals[3]!;
	bridge.update(snapshot(2, 'acme.run', [{ kind: 'workspaceEvents', registrationId: 'window' }]));
	assert.equal(previous.aborted, true);
	await waitFor(() => api.invocations.length === 5);
	assert.equal(api.invocations[4]!.activationGeneration, 12);
	bridge.clear();
	const count = api.invocations.length;
	await configuration.updateValue('sample.count', 2);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(api.invocations.length, count);
	assert.deepEqual(errors, []);
});

test('workspace bridge reads the actual workspace owner and fences cleared subscriptions', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'workspaceEvents', registrationId: 'window' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using workspace = new WorkspaceContextService({ id: 'empty' });
	using scope = services.createChild();
	scope.registerInstance(IWorkspaceContextService, workspace);
	const errors: unknown[] = [];
	using bridge = scope.createInstance(MainThreadWorkspace, 1_000, (error: unknown) => errors.push(error));
	bridge.update(api.current);
	await waitFor(() => api.invocations.length === 1);
	const folders = [URI.file('/one'), URI.file('/two')].map((uri, index) => ({ id: String(index), uri, index, name: `Root ${index}` }));
	workspace.updateWorkspace({ id: 'two', name: 'Two roots', configuration: URI.file('/window.code-workspace'), folders });
	await waitFor(() => api.invocations.length === 2);
	const event = api.invocations[1]!.payload as Record<string, JsonValue>;
	assert.deepEqual(event.workspaceFolders, normalizeExtensionHostPayload(folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name, index: folder.index }))));
	assert.equal(event.workspaceFile, 'file:///window.code-workspace');
	assert.equal(event.workspaceName, 'Two roots');
	assert.equal(event.emit, true);
	const retired = api.invocationSignals[1]!;
	bridge.clear();
	assert.equal(retired.aborted, true);
	workspace.updateWorkspace({ id: 'one', folders: [{ ...folders[1]!, index: 0 }] });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(api.invocations.length, 2);
	bridge.update(api.current);
	await waitFor(() => api.invocations.length === 3);
	const fresh = api.invocations[2]!.payload as Record<string, JsonValue>;
	assert.ok((fresh.revision as number) > (event.revision as number));
	assert.deepEqual(fresh.workspaceFolders, normalizeExtensionHostPayload([{ uri: 'file:///two', name: 'Root 1', index: 0 }]));
	assert.deepEqual(errors, []);
});

test('Node startup and recovery requests read fresh facts from the existing window owners', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run'));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'sample.enabled', defaultValue: true, parse: value => Boolean(value) });
	using configuration = new InMemoryConfigurationService(registry);
	using workspace = new WorkspaceContextService({ id: 'empty' });
	using scope = services.createChild();
	scope.registerInstance(IConfigurationService, configuration);
	scope.registerInstance(IWorkspaceContextService, workspace);
	using host = scope.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const signal = new AbortController().signal;
	const before = await api.clientHandler!({ operation: 'readInitialization' }, signal, source);
	assert.ok(before.result === 'initialization');
	assert.equal(before.initialization.language, getNLSLanguage());
	await configuration.updateValue('sample.enabled', false);
	workspace.updateWorkspace({ id: 'folder', folders: [{ id: 'root', uri: URI.file('/changed'), name: 'Changed', index: 0 }] });
	const after = await api.clientHandler!({ operation: 'readInitialization' }, signal, source);
	assert.ok(after.result === 'initialization');
	assert.equal(after.initialization.language, getNLSLanguage());
	assert.deepEqual(before.initialization.workspaceFolders, []);
	assert.deepEqual(after.initialization.workspaceFolders, [{ uri: 'file:///changed', name: 'Changed', index: 0 }]);
	assert.equal((before.initialization.configurationValues.sample as { enabled: boolean; }).enabled, true);
	assert.equal((after.initialization.configurationValues.sample as { enabled: boolean; }).enabled, false);
	assert.deepEqual(after.initialization.configurationData, configuration.getConfigurationData());
});

test('Remote extension resolves a saved target and connects only after host confirmation', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'remoteConnectionResolver', registrationId: 'remote:team', authorityPrefix: 'team' }]));
	using languages = new LanguageFeaturesService();
	const connected: string[] = [];
	const confirmations: unknown[] = [];
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, {
		connections: {
			...UnavailableRemoteConnectionApi, available: true,
			list: async () => [{ name: 'build', host: 'build-linux', workspace: '/srv/project' }],
			connect: async name => { connected.push(name); },
		},
		confirm: async options => { confirmations.push(options); return { confirmed: true }; },
	});
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	setNlsMessages('zh-CN', JSON.parse(readFileSync('localization/zh-CN/workbench.json', 'utf8')));
	using restoreLocale = toDisposable(resetNlsResolver);
	const result = await api.clientHandler!({ operation: 'openRemoteConnection', authority: 'team+linux' }, new AbortController().signal, { extensionId: 'acme.demo', incarnation: 3, activationGeneration: 11 });
	assert.deepEqual(result, { result: 'done' });
	assert.deepEqual(connected, ['build']);
	assert.deepEqual(api.invocations.map(request => [request.registrationId, request.operation, request.payload, request.incarnation, request.activationGeneration]), [['remote:team', 'resolveConnection', { authority: 'team+linux' }, 3, 11]]);
	assert.match(JSON.stringify(confirmations), /build-linux:\/srv\/project/);
	assert.match(JSON.stringify(confirmations), /acme.demo/);
	assert.match(JSON.stringify(confirmations), /扩展.*请求打开/);
	assert.match(JSON.stringify(confirmations), /打开远程窗口/);
});

test('Remote extension cancellation and revocation cannot open a window', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'remoteConnectionResolver', registrationId: 'remote:team', authorityPrefix: 'team' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, {
		connections: {
			...UnavailableRemoteConnectionApi, available: true,
			list: async () => [{ name: 'build', host: 'build-linux', workspace: '/srv/project' }],
			connect: async () => assert.fail('Cancelled connection opened a window'),
		},
		confirm: async () => ({ confirmed: false }),
	});
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	const source = { extensionId: 'acme.demo', incarnation: 3, activationGeneration: 11 };
	await assert.rejects(api.clientHandler!({ operation: 'openRemoteConnection', authority: 'team+linux' }, new AbortController().signal, source), /[Cc]ancel/);
	const pendingResult = deferred<JsonValue>();
	api.invocationResult = pendingResult.promise;
	const pending = api.clientHandler!({ operation: 'openRemoteConnection', authority: 'team+linux' }, new AbortController().signal, source);
	api.emitConnection('restarting');
	assert.equal(api.invocationSignals.at(-1)!.aborted, true);
	pendingResult.resolve({ connectionName: 'build' });
	await assert.rejects(pending);
	await assert.rejects(api.clientHandler!({ operation: 'openRemoteConnection', authority: 'ssh+build' }, new AbortController().signal, source), /revoked/);
});
