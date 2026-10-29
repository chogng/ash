import { ITerminalCompletionService, TerminalCompletionService } from '../../../../contrib/terminalContrib/suggest/browser/terminalCompletionService.js';
import { ITerminalQuickFixService } from '../../../../contrib/terminalContrib/quickFix/browser/quickFix.js';
import { TerminalQuickFixService } from '../../../../contrib/terminalContrib/quickFix/browser/terminalQuickFixService.js';
import { ITerminalLinkProviderService } from '../../../../contrib/terminalContrib/links/browser/links.js';
import { TerminalLinkProviderService } from '../../../../contrib/terminalContrib/links/browser/terminalLinkProviderService.js';
import {
	IAdapterManager,
	IDebugService,
	type IDebugConfigurationProvider,
	type DebugConfigurationProviderRegistration,
	type IDebugAdapterTrackerFactory,
	type DebugAdapterTrackerFactoryRegistration,
} from '../../../../contrib/debug/common/debug.js';
import { AdapterManager } from '../../../../contrib/debug/browser/debugAdapterManager.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../../contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { ISpeechService } from '../../../../contrib/speech/common/speechService.js';
import { SpeechService } from '../../../../contrib/speech/browser/speechService.js';
import '../../../../contrib/terminal/common/terminalExtensionPoints.contribution.js';
import { TerminalContributionService } from '../../../../contrib/terminal/common/terminalExtensionPoints.js';
import { IEnvironmentVariableService } from '../../../../contrib/terminal/common/environmentVariable.js';
import { EnvironmentVariableService } from '../../../../contrib/terminal/common/environmentVariableService.js';
import { ITerminalContributionService, ITerminalProfileService, ITerminalProfileResolverService } from '../../../../contrib/terminal/common/terminal.js';
import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { ITerminalGroupService, ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalProfileService } from '../../../../contrib/terminal/browser/terminalProfileService.js';
import { createEmptyTestLanguagePacks } from '../../../localization/test/common/localizationTestUtils.js';
import { ILanguagePackService } from '../../../../../platform/languagePacks/common/languagePacks.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import { IEditorService } from '../../../editor/common/editorService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';
import { IViewsService } from '../../../views/common/viewsService.js';
import { IPaneCompositePartService } from '../../../panecomposite/browser/panecomposite.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { ITextFileService } from '../../../textfile/common/textfiles.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from '../../../../contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { ExtensionClientHandler } from '../../../../api/common/extHost.protocol.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { getNLSLanguage } from '../../../../../nls.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { MainThreadConfiguration } from '../../../../api/browser/mainThreadConfiguration.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { MainThreadWorkspace } from '../../../../api/browser/mainThreadWorkspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { MockDebugSession } from '../../../../contrib/debug/test/common/mockDebug.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IExtensionService } from '../../../extensions/common/extensionService.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';

import { IHostService } from '../../../host/browser/host.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService, UnavailableRemoteConnectionApi } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestViewDescriptorService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../../common/views.js';
import { ITimelineService } from '../../../../contrib/timeline/common/timeline.js';
import { TimelineService } from '../../../../contrib/timeline/common/timelineService.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { CommandRegistry, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import type { AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import {
	IExtensionHostApi,
	type ExtensionHostFleetSnapshot,
	type ExtensionHostInvocationRequest,
	type ExtensionHostOutputEvent,
	type ExtensionHostReconcileMode,
	type JsonValue,
} from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { normalizeExtensionHostPayload } from '../../../../../platform/agentHost/browser/extensionHostProtocol.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { ITaskService } from '../../../../contrib/tasks/common/taskService.js';
import { type TaskProvider, type TaskProviderRegistration } from '../../../../contrib/tasks/common/tasks.js';
import { ITestingService, type TestProfileProvider, type TestProfileProviderRegistration } from '../../../testing/common/testingService.js';
import { AppServerExtensionHostService } from '../../browser/appServerExtensionHostService.js';
import { MainThreadExtensionApi } from '../../../../api/browser/mainThreadExtensionApi.js';
import { ISCMService, ISCMViewService } from '../../../../contrib/scm/common/scm.js';
import { SCMService } from '../../../../contrib/scm/common/scmService.js';
import { SCMViewService } from '../../../../contrib/scm/browser/scmViewService.js';
import { IQuickDiffService } from '../../../../contrib/scm/common/quickDiff.js';
import { QuickDiffService } from '../../../../contrib/scm/common/quickDiffService.js';
import { IDecorationsService } from '../../../decorations/common/decorations.js';
import { IExtensionApi } from '../../../../../platform/extensions/common/extensionApi.js';
import { IExtensionBackendApi } from '../../../../../platform/agentHost/common/extensionBackendApi.js';
import { IAppServerApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IStatusbarService, StatusbarAlignment } from '../../../statusbar/browser/statusbar.js';
import { createExtensionHostLanguageProviderBatch } from '../../../../api/browser/extensionHostLanguageBridge.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IOutputService } from '../../../output/common/output.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';

import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { AbstractLifecycleService } from '../../../lifecycle/common/lifecycleService.js';
import { ILifecycleService, LifecyclePhase } from '../../../lifecycle/common/lifecycle.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileTextModelService, type TextModelReference } from '../../../textmodelResolver/common/textModelResourceService.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';

import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;

test('a missing tree container isolates one registration while the fleet commits and activates other extensions', async () => {
	const initial = snapshot(1, 'acme.run', [
		{
			kind: 'treeDataProvider',
			registrationId: 'missing-tree',
			viewId: 'acme.missing',
			title: 'Missing tree',
			containerId: 'missing.container',
		},
		{ kind: 'treeDataProvider', registrationId: 'sibling-tree', viewId: 'acme.sibling', title: 'Sibling tree' },
	]);
	const healthy = {
		...initial.extensions[0]!,
		id: 'acme.healthy',
		registrations: [
			{
				kind: 'treeDataProvider' as const,
				registrationId: 'tree',
				viewId: 'acme.healthy',
				title: 'Healthy tree',
			},
		],
	};
	const dormant = { ...dormantSnapshot(['*']).extensions[0]!, id: 'acme.lazy' };
	const fleet = { ...initial, extensions: [...initial.extensions, healthy, dormant] };
	const api = new FakeExtensionHostApi(fleet);
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using registry = new WorkbenchViewRegistry();
	using container = registry.registerViewContainer({
		id: 'test.trees',
		title: 'Trees',
		location: ViewContainerLocation.Sidebar,
		isDefault: true,
	});
	using descriptors = new TestViewDescriptorService({ registry }, services.get(IContextKeyService));
	using treeServices = services.createChild();
	treeServices.registerInstance(IViewDescriptorService, descriptors);
	using host = treeServices.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	const failures: string[] = [];
	using failed = host.onDidFail(failure => failures.push(`${failure.extensionId}: ${failure.message}`));
	await host.start();
	await waitFor(() => api.activations.length === 1);
	assert.equal(host.currentSnapshot.fleetGeneration, 1);
	assert.deepEqual(
		host.currentSnapshot.extensions.map(runtime => runtime.id),
		['acme.demo', 'acme.healthy', 'acme.lazy'],
	);
	assert.equal(host.state, 'degraded');
	assert.deepEqual(failures, ['acme.demo: No container for tree view: acme.missing']);
	assert.ok(descriptors.getViewDescriptorById('acme.sibling'));
	assert.ok(descriptors.getViewDescriptorById('acme.healthy'));
	assert.equal(api.activations[0]!.extensionId, 'acme.lazy');
	assert.deepEqual(api.activations[0]!.event, { type: 'startupFinished' });
	using recovered = registry.registerViewContainer({
		id: 'missing.container',
		title: 'Recovered',
		location: ViewContainerLocation.Sidebar,
	});
	api.current = { ...fleet, generation: 2, extensions: fleet.extensions.slice(0, 2) };
	api.emitChanged(2);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 2);
	assert.equal(host.state, 'ready');
	assert.ok(descriptors.getViewDescriptorById('acme.missing'));
	await host.stop();
	activation.resolve({
		...api.current,
		extensions: [...api.current.extensions, { ...dormant, lifecycle: 'ready', incarnation: 4, registrations: [] }],
	});
	assert.equal(descriptors.getViewDescriptorById('acme.healthy'), null);
});

for (const stopBeforeReady of [false, true])
	test(`provider activation waits for declarative identity and configuration${stopBeforeReady ? ' and stays stopped after a late catalog' : ''}`, async () => {
		const api = new FakeExtensionHostApi(snapshot(1, 'acme.run'));
		using languages = new LanguageFeaturesService();
		const catalog = deferred<Awaited<ReturnType<IExtensionApi['list']>>>();
		let requested = false;
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, {
			list: () => {
				requested = true;
				return catalog.promise;
			},
			resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource')),
		});
		using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
		const starting = host.start();
		await waitFor(() => requested);
		assert.equal(api.reconciles, 0);
		if (stopBeforeReady) await host.stop();
		catalog.resolve({ generation: 1, extensions: [], diagnostics: [] });
		await starting;
		assert.equal(api.reconciles, stopBeforeReady ? 0 : 1);
		assert.equal(host.state, stopBeforeReady ? 'stopped' : 'ready');
	});

test('SCM registrations dispatch updates and Quick Diff, and retire before a restarted provider reuses its identity', async () => {
	const provider = {
		id: 'repository',
		providerId: 'git',
		label: 'Git',
		rootUri: 'file:///workspace',
		selected: true,
		groups: [],
		input: {
			value: '',
			placeholder: '',
			buttonLabel: 'Commit',
			buttonTooltip: 'Commit',
			enabled: true,
			canAccept: false,
		},
		statusMessage: '',
		isBusy: false,
		statusBarCommands: [],
		historyRef: null,
		historyRevision: 0,
		inputRevision: 0,
		hasHistory: false,
		hasMerge: false,
	};
	const registration = { kind: 'sourceControl' as const, registrationId: 'scm', revision: 1, providers: [provider] };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.scm', [registration]));
	api.invocationResult = Promise.resolve(null);
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const scm = services.get(ISCMService);
	const quickDiff = services.get(IQuickDiffService);
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const repository = scm.getRepository('repository')!;
	assert.equal(host.currentSnapshot.extensions[0]!.registrations.find(entry => entry.id === 'scm')?.kind, 'sourceControl');
	assert.equal(services.get(ISCMViewService).activeRepository, repository);
	let changes = 0;
	using changed = quickDiff.onDidChange(resource => {
		assert.equal(resource, undefined);
		changes++;
	});
	assert.deepEqual(
		await api.clientHandler!(
			{
				operation: 'scmUpdate',
				registrationId: 'scm',
				revision: 2,
				providers: [{ ...provider, label: 'Updated Git' }],
			},
			new AbortController().signal,
			source,
		),
		{ result: 'done' },
	);
	assert.equal(scm.getRepository('repository'), repository);
	assert.equal(changes, 1);
	api.invocationResult = Promise.resolve({
		providerId: 'acme.demo:repository',
		providerLabel: 'Updated Git',
		label: 'Updated Git',
		resource: 'git:///workspace/file.ts?ref=HEAD',
		text: 'original',
	});
	assert.deepEqual(await quickDiff.getQuickDiffs(URI.file('/workspace/file.ts'), new AbortController().signal), [
		{
			providerId: 'acme.demo:repository',
			providerLabel: 'Updated Git',
			label: 'Updated Git',
			originalResource: URI.parse('git:///workspace/file.ts?ref=HEAD'),
			revision: 2,
			text: 'original',
		},
	]);
	const count = api.invocations.length;
	assert.deepEqual(await quickDiff.getQuickDiffs(URI.file('/elsewhere/file.ts'), new AbortController().signal), []);
	await assert.rejects(quickDiff.getQuickDiffs(URI.file('/workspace/file.ts'), AbortSignal.abort()));
	assert.equal(api.invocations.length, count);
	const pending = deferred<JsonValue>();
	api.invocationResult = pending.promise;
	const reading = quickDiff.getQuickDiffs(URI.file('/workspace/file.ts'), new AbortController().signal);
	const signal = api.invocationSignals.at(-1)!;
	api.current = snapshot(2, 'acme.scm', [registration]);
	api.invocationResult = Promise.resolve(null);
	await host.reload();
	assert.notEqual(scm.getRepository('repository'), repository);
	assert.equal(quickDiff.providers.length, 1);
	assert.equal(signal.aborted, true);
	pending.resolve({ resource: 'git:///workspace/file.ts', text: 'late' });
	await assert.rejects(reading);
	await assert.rejects(api.clientHandler!({ operation: 'scmUpdate', registrationId: 'scm', revision: 3, providers: [] }, new AbortController().signal, source), /retired/);
	await host.stop();
	assert.equal(scm.getRepository('repository'), undefined);
	assert.equal(quickDiff.providers.length, 0);
});

test('SCM registrations reach their owner, preserve history on resource updates and retire with the host', async () => {
	const provider = {
		id: 'extension-repo',
		providerId: 'acme',
		label: 'Synthetic SCM',
		selected: true,
		groups: [],
		input: { value: '', placeholder: '', buttonLabel: '', buttonTooltip: '' },
		statusMessage: '',
		statusBarCommands: [],
		historyRevision: 1,
		inputRevision: 0,
		hasHistory: true,
		hasMerge: false,
	};
	const initial = snapshot(1, 'unused');
	const api = new FakeExtensionHostApi({
		...initial,
		extensions: initial.extensions.map(runtime => ({
			...runtime,
			registrations: [{ kind: 'sourceControl', registrationId: 'scm', revision: 1, providers: [provider] }],
		})),
	});
	api.invocationResult = Promise.resolve(null);
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	assert.equal(host.state, 'ready');
	assert.deepEqual(host.currentSnapshot.extensions[0]!.registrations, [{ id: 'scm', kind: 'sourceControl' }]);
	const scm = services.get(ISCMService);
	const repository = scm.getRepository(provider.id)!;
	assert.equal(repository.provider.label, provider.label);
	const quickDiff = services.get(IQuickDiffService);
	assert.equal(quickDiff.providers.length, 1);
	let historyChanges = 0;
	using historyListener = repository.provider.historyProvider!.onDidChange(() => historyChanges++);
	const invalidations: Array<URI | undefined> = [];
	using diffListener = quickDiff.onDidChange(resource => invalidations.push(resource));
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const signal = new AbortController().signal;
	assert.deepEqual(await api.clientHandler!({ operation: 'scmUpdate', registrationId: 'scm', revision: 2, providers: [provider] }, signal, source), { result: 'done' });
	assert.equal(historyChanges, 0);
	assert.deepEqual(invalidations, [], 'An identical resource snapshot does not invalidate working-tree consumers');
	await api.clientHandler!(
		{
			operation: 'scmUpdate',
			registrationId: 'scm',
			revision: 3,
			providers: [{ ...provider, historyRevision: 2 }],
		},
		signal,
		source,
	);
	assert.equal(historyChanges, 1);
	api.invocationResult = Promise.resolve({
		providerId: 'acme.demo:extension-repo',
		providerLabel: provider.label,
		label: provider.label,
		resource: 'git-original:/file.txt',
		text: 'base',
	});
	assert.deepEqual(await quickDiff.getQuickDiffs(URI.file('/workspace/file.txt'), signal), [
		{
			providerId: 'acme.demo:extension-repo',
			providerLabel: provider.label,
			label: provider.label,
			originalResource: URI.parse('git-original:/file.txt'),
			revision: 3,
			text: 'base',
		},
	]);
	const cancelled = new AbortController();
	cancelled.abort();
	const count = api.invocations.length;
	await assert.rejects(quickDiff.getQuickDiffs(URI.file('/workspace/file.txt'), cancelled.signal));
	assert.equal(api.invocations.length, count);
	api.emitConnection('stopped');
	assert.equal(scm.getRepository(provider.id), undefined);
	assert.equal(quickDiff.providers.length, 0);
	await assert.rejects(api.clientHandler!({ operation: 'scmUpdate', registrationId: 'scm', revision: 4, providers: [provider] }, signal, source), /retired registration/);
});

test('extension backend client operations reach the admitted capability owner', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.backend'));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	services.get(IExtensionApi).list = async () => ({
		generation: 1,
		diagnostics: [],
		extensions: [
			{
				id: 'acme.demo',
				name: 'demo',
				publisher: 'acme',
				version: '1',
				displayName: 'Demo',
				sourceKind: 'builtIn',
				manifestJson: JSON.stringify({
					ashFrontend: {
						capabilities: {
							catalog: {
								methods: { list: { route: 'session/list', fields: [], resultFields: ['sessions'] } },
								notifications: [],
							},
						},
					},
				}),
				manifestSha256: DIGEST,
				packageSha256: DIGEST,
			},
		],
	});
	const requests: unknown[] = [];
	services.get(IExtensionBackendApi).request = async (method, params) => {
		requests.push([method, params]);
		return { sessions: [], privateValue: 'hidden' };
	};
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const signal = new AbortController().signal;
	assert.deepEqual(await api.clientHandler!({ operation: 'backendRequest', capability: 'catalog', method: 'list', params: {} }, signal, source), { result: 'value', value: { sessions: [] } });
	assert.deepEqual(requests, [['session/list', {}]]);
	await assert.rejects(api.clientHandler!({ operation: 'backendRequest', capability: 'catalog', method: 'undeclared', params: {} }, signal, source), /not authorized/);
	await assert.rejects(api.clientHandler!({ operation: 'backendRequest', capability: 'catalog', method: 'list', params: { forbidden: true } }, signal, source), /exceed/);
	const result = await api.clientHandler!({ operation: 'backendState', capability: 'catalog', after: 0 }, signal, source);
	assert.equal(result.result, 'value');
	if (result.result !== 'value') {
		assert.fail('Expected backend state');
	}
	assert.deepEqual(JSON.parse(JSON.stringify(result.value)), {
		sequence: 0,
		connection: 'ready',
		generation: 1,
		reset: false,
		editorFoldersChanged: false,
		events: [],
		folders: services
			.get(IWorkspaceContextService)
			.getWorkspace()
			.folders.map(folder => ({ id: folder.id, name: folder.name, uri: folder.uri.toString() })),
	});
	assert.equal(requests.length, 1);
});

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
		results.push(
			await api.clientHandler!(
				{
					operation: 'executeCommand',
					command: 'test.extension.commandValue',
					arguments: [index, 'literal argument'],
				},
				signal,
				source,
			),
		);
	}
	assert.deepEqual(
		JSON.parse(JSON.stringify(results)),
		values.map(value => ({
			result: 'command',
			value: value === undefined ? null : value,
			hasValue: value !== undefined,
		})),
	);
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
		api.invocationResult = Promise.resolve({
			tasks: [{ id: 'build', label: 'Build', command: 'builder', group: 'build', presentation }],
		});
		assert.deepEqual((await provider.provideTasks(new AbortController().signal))[0]!.presentation, presentation);
	}
	const invalid: readonly JsonValue[] = [null, [], { panel: 1 }, { panel: 'invalid' }, { clear: 'true' }, { focus: 'true' }];
	for (const presentation of invalid) {
		api.invocationResult = Promise.resolve({
			tasks: [{ id: 'build', label: 'Build', command: 'builder', group: 'build', presentation }],
		});
		await assert.rejects(async () => provider.provideTasks(new AbortController().signal));
	}
});

test('document highlights translate protocol kinds into editor kinds', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('heading', { languageId: 'markdown' });
	using source = new CancellationTokenSource();
	using registration = languages.registerProviderBatch(
		createExtensionHostLanguageProviderBatch(
			{
				kind: 'languageProvider',
				registrationId: 'highlights',
				languageIds: ['markdown'],
				operations: ['documentHighlights'],
			},
			'markdown',
			'highlights',
			async () =>
				[1, 2, 3].map(kind => ({
					kind,
					range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 7 } },
				})),
		),
	);
	const result = await languages.documentHighlightProvider.ordered(model)[0]!.provideDocumentHighlights(model, new Position(1, 3), source.token);
	assert.deepEqual(
		result?.map(highlight => highlight.kind),
		[0, 1, 2],
	);
});

test('document subscriptions deliver model commits in order and retire on restart and disconnect', async () => {
	const registration = { kind: 'textDocumentEvents' as const, registrationId: 'documents' };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [registration]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using reference = await acquireFile(services, '😀', URI.file('/main.ts'));
	const model = reference.model;
	assert.equal(services.get(IModelService).getModel(model.uri), null, 'File models have a distinct owner');
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
	assert.deepEqual(
		api.invocations.map(request => request.payload),
		[
			{ type: 'open', document: { uri: model.uri.toString(), version: 1, languageId: 'plaintext', text: '😀' } },
			{
				type: 'change',
				document: { uri: model.uri.toString(), version: 2, languageId: 'plaintext', text: '😀a' },
				reason: 'edit',
				contentChanges: [
					{
						range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
						rangeOffset: 2,
						rangeLength: 0,
						text: 'a',
					},
				],
			},
			{
				type: 'change',
				document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: '😀ab' },
				reason: 'edit',
				contentChanges: [
					{
						range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
						rangeOffset: 3,
						rangeLength: 0,
						text: 'b',
					},
				],
			},
		],
	);
	api.current = { generation: 2, extensions: [{ ...api.current.extensions[0]!, incarnation: 4 }] };
	api.emitChanged(2);
	await waitFor(() => api.invocations.length === 4);
	assert.equal(api.invocationSignals[0]!.aborted, true);
	assert.equal(api.invocations[3]!.incarnation, 4);
	assert.deepEqual(api.invocations[3]!.payload, {
		type: 'open',
		document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: '😀ab' },
	});
	reference.dispose();
	await waitFor(() => api.invocations.length === 5);
	assert.deepEqual(api.invocations[4]!.payload, {
		type: 'close',
		document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: '😀ab' },
	});
	api.emitConnection('restarting');
	assert.equal(api.invocationSignals[4]!.aborted, true);
	using next = await acquireFile(services, 'after disconnect', URI.file('/next.ts'));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(api.invocations.length, 5);
	next.dispose();
});

test('diagnostic collections reject stale versions and keep extension ownership through retirement', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run'));
	api.current = {
		...api.current,
		extensions: [...api.current.extensions, { ...api.current.extensions[0]!, id: 'acme.other', registrations: [] }],
	};
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using reference = await acquireFile(services, 'bad', URI.file('/main.ts'));
	const model = reference.model;
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	const markers = services.get(IMarkerService);
	const source = { extensionId: 'acme.demo', activationGeneration: 11, incarnation: 3 };
	const other = { ...source, extensionId: 'acme.other' };
	const diagnostic = {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 3 },
		severity: 'warning' as const,
		message: 'Bad word',
		source: 'lint',
		code: 'W1',
	};
	const entries = [{ uri: model.uri.toString(), version: 1, diagnostics: [diagnostic] }];
	const signal = new AbortController().signal;
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries }, signal, source);
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries }, signal, other);
	assert.equal(markers.read({ resource: model.uri }).length, 2);
	assert.deepEqual(
		markers.read({ resource: model.uri }).map(marker => [marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn, marker.modelVersionId, marker.code]),
		[
			[1, 1, 1, 4, 1, 'W1'],
			[1, 1, 1, 4, 1, 'W1'],
		],
	);
	await assert.rejects(
		api.clientHandler!(
			{
				operation: 'setDiagnostics',
				collection: 'lint',
				entries: [{ ...entries[0]!, diagnostics: [{ ...diagnostic, message: '' }] }],
			},
			signal,
			source,
		),
		/Diagnostic message must not be empty/,
	);
	assert.equal(markers.read({ resource: model.uri }).length, 2, 'invalid replacement leaves current collections intact');
	using secondReference = await acquireFile(services, 'bad', URI.file('/second.ts'));
	const second = secondReference.model;
	await api.clientHandler!(
		{
			operation: 'setDiagnostics',
			collection: 'lint',
			merge: true,
			entries: [{ ...entries[0]!, uri: second.uri.toString() }],
		},
		signal,
		source,
	);
	await api.clientHandler!(
		{
			operation: 'setDiagnostics',
			collection: 'lint',
			merge: true,
			entries: [{ ...entries[0]!, diagnostics: [] }],
		},
		signal,
		source,
	);
	assert.equal(markers.read({ resource: model.uri }).length, 1, 'merge clears only the listed resource for this extension');
	assert.equal(markers.read({ resource: second.uri }).length, 1, 'merge retains unlisted resources');
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', merge: true, entries }, signal, source);
	model.setValue('good');
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries: [{ ...entries[0]!, diagnostics: [] }] }, signal, source);
	assert.equal(markers.read({ resource: model.uri }).length, 2, 'old replacement cannot clear current diagnostics');
	await api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries: [] }, signal, source);
	assert.equal(markers.read({ resource: model.uri }).length, 1, 'other extension owns its collection');
	assert.equal(markers.read({ resource: second.uri }).length, 0, 'whole replacement still clears unlisted resources');
	api.current = { generation: 2, extensions: [{ ...api.current.extensions[0]!, incarnation: 4 }] };
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(markers.read({ resource: model.uri }).length, 0);
	await assert.rejects(api.clientHandler!({ operation: 'setDiagnostics', collection: 'lint', entries: [] }, signal, source), /retired extension/);
	reference.dispose();
	secondReference.dispose();
});

test('document callback errors do not suppress later commits and language changes close then reopen', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'textDocumentEvents', registrationId: 'documents' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using reference = await acquireFile(services, 'initial', URI.file('/main.ts'));
	const model = reference.model;
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
	assert.deepEqual(
		api.invocations.slice(3).map(request => request.payload),
		[
			{
				type: 'close',
				document: { uri: model.uri.toString(), version: 3, languageId: 'plaintext', text: 'next commit' },
			},
			{
				type: 'open',
				document: { uri: model.uri.toString(), version: 3, languageId: 'typescript', text: 'next commit' },
			},
		],
	);
	reference.dispose();
});

test('extension command palette declarations replace implicit entries and retire with command authority', async () => {
	const registrations = [
		{
			kind: 'command' as const,
			registrationId: 'context',
			command: 'acme.graph.context',
			title: 'Context action',
			menus: [{ menu: 'commandPalette', when: 'false' }],
		},
		{
			kind: 'command' as const,
			registrationId: 'conditional',
			command: 'acme.graph.conditional',
			title: 'Conditional action',
			menus: [{ menu: 'commandPalette', when: 'graphReady' }],
		},
		{
			kind: 'command' as const,
			registrationId: 'ordinary',
			command: 'acme.graph.ordinary',
			title: 'Ordinary action',
		},
	];
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.old', registrations));
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const items = () => MenusRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && item.command.id.startsWith('acme.graph.'));
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	assert.equal(items().length, 3, 'Each registered command has one palette placement');
	const context = items().find(item => 'command' in item && item.command.id === 'acme.graph.context')!;
	const conditional = items().find(item => 'command' in item && item.command.id === 'acme.graph.conditional')!;
	const ordinary = items().find(item => 'command' in item && item.command.id === 'acme.graph.ordinary')!;
	using keys = new (await import('../../../../../platform/contextkey/browser/contextKeyService.js')).ContextKeyService();
	keys.setContext('graphReady', false);
	assert.equal(context.when?.evaluate(keys.getContext()), false);
	assert.equal(conditional.when?.evaluate(keys.getContext()), false);
	keys.setContext('graphReady', true);
	assert.equal(conditional.when?.evaluate(keys.getContext()), true);
	assert.equal(ordinary.when, undefined);
	await services.invokeFunction(accessor => commands.getCommand('acme.graph.context')!(accessor));
	assert.equal(api.invocations.at(-1)?.operation, 'execute', 'Palette visibility does not revoke the contextual command');
	service.dispose();
	assert.equal(items().length, 0);
	assert.equal(commands.hasCommand('acme.graph.context'), false);
});

test('extension editor menus capture the clicked input and reject malformed replacement menus before commit', async () => {
	const placement = { menu: 'editor/title/context', when: 'resourceLangId == markdown', group: 'navigation@1' };
	const registration = {
		kind: 'command' as const,
		registrationId: 'preview',
		command: 'acme.preview',
		title: 'Preview',
		category: 'Acme',
		enablement: 'editorTextFocus',
		menus: [placement],
	};
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.old', [registration]));
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const inputs = [{ resource: URI.file('/notes/clicked.md') }, { resource: URI.file('/notes/active.md') }];
	const group = { id: 1, inputs, activeInput: inputs[1] };
	Object.assign(services.get(IEditorPart), { groups: [group], activeGroup: group });
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	assert.equal(commands.getCommands().get('acme.preview')?.metadata?.description, 'Acme: Preview');
	await services.invokeFunction(accessor => commands.getCommand('acme.preview')!(accessor, { groupId: group.id, editorIndex: 0 }));
	assert.deepEqual(JSON.parse(JSON.stringify(api.invocations[0]!.payload)), {
		arguments: [{ groupId: group.id, editorIndex: 0 }],
		activeEditor: { resource: inputs[0]!.resource.toJSON(), groupId: group.id, editorIndex: 0 },
	});
	const placements = MenusRegistry.getMenuItems(MenuId.EditorTitleContext).filter(item => 'command' in item && item.command.id === 'acme.preview');
	assert.equal(placements.length, 1);
	assert.ok('command' in placements[0]!);
	assert.equal(placements[0].command.title, 'Preview');
	assert.deepEqual([...placements[0].command.precondition!.keys()], ['editorTextFocus']);
	api.current = snapshot(2, 'acme.new', [{ ...registration, menus: [{ ...placement, group: 'navigation@bad-order' }] }]);
	await service.reload();
	assert.equal(service.state, 'degraded');
	assert.match(services.get(IOutputService).getChannel('extension-host')!.getText(), /Invalid menu order.*acme.preview/);
	assert.equal(commands.hasCommand('acme.old'), true);
	assert.equal(commands.hasCommand('acme.new'), false);
	assert.deepEqual(
		MenusRegistry.getMenuItems(MenuId.EditorTitleContext).filter(item => 'command' in item && item.command.id === 'acme.preview'),
		placements,
	);
});

test('range formatting bridge preserves the request snapshot and forwards cancellation', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('alpha', { languageId: 'typescript', resource: URI.file('/project/main.ts') });
	using source = new CancellationTokenSource();
	const version = model.getVersionId();
	let payload: JsonValue | undefined;
	let signal: AbortSignal | undefined;
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	const range = { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 5 } };
	const batch = createExtensionHostLanguageProviderBatch(
		{ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] },
		'acme.formatter',
		'formatter',
		async (operation, value, cancellation) => {
			assert.equal(operation, 'formatting');
			payload = value;
			signal = cancellation;
			await pending;
			return { edits: [{ range, text: 'ALPHA' }] };
		},
	);
	using registration = languages.registerProviderBatch(batch);
	const result = languages.documentRangeFormattingEditProvider
		.ordered(model)[0]!
		.provideDocumentRangeFormattingEdits(model, new Range(1, 1, 1, 6), { tabSize: 2, insertSpaces: false }, source.token);
	assert.deepEqual(payload, {
		languageId: 'typescript',
		version,
		text: 'alpha',
		resource: model.uri.toString(),
		kind: 'range',
		range,
		options: { tabSize: 2, insertSpaces: false },
	});
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
	const batch = createExtensionHostLanguageProviderBatch(
		{ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] },
		'acme.formatter',
		'formatter',
		async (operation, value, cancellation) => {
			assert.equal(operation, 'formatting');
			payload = value;
			signal = cancellation;
			return { edits: [] };
		},
	);
	using registration = languages.registerProviderBatch(batch);
	const provider = languages.documentFormattingEditProvider.ordered(model)[0]!;
	assert.equal(provider.extensionId?.value, 'acme.formatter');
	assert.deepEqual(languages.onTypeFormattingEditProvider.ordered(model), []);
	assert.deepEqual(await provider.provideDocumentFormattingEdits(model, { tabSize: 2, insertSpaces: true }, source.token), []);
	assert.deepEqual(payload, {
		languageId: 'typescript',
		version: model.getVersionId(),
		text: 'alpha',
		resource: model.uri.toString(),
		kind: 'document',
		options: { tabSize: 2, insertSpaces: true },
	});
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
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	const batch = createExtensionHostLanguageProviderBatch(
		{ kind: 'languageProvider', registrationId: 'format', languageIds: ['typescript'], operations: ['formatting'] },
		'acme.formatter',
		'formatter',
		async (_operation, _payload, cancellation) => {
			signal = cancellation;
			await pending;
			return { edits: [] };
		},
	);
	using registration = languages.registerProviderBatch(batch);
	const result = languages.documentFormattingEditProvider.ordered(model)[0]!.provideDocumentFormattingEdits(model, { tabSize: 4, insertSpaces: true }, source.token);
	source.cancel();
	assert.ok(signal);
	assert.equal(signal.aborted, true);
	release();
	await result;
});

test('keeps last-good contributions while refreshing and revokes them synchronously on disconnect', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.old'));
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
	assert.equal(service.state, 'ready');
	assert.equal(failures.length, 0);
	assert.ok(commands.hasCommand('acme.old'));

	const handler = commands.getCommand('acme.old')!;
	assert.deepEqual(await handler({} as ServicesAccessor, 'argument'), { executed: true });
	assert.equal(api.invocations[0]?.activationGeneration, 11);
	assert.equal(api.invocations[0]?.incarnation, 3);
	const payload = api.invocations[0]?.payload;
	assert.deepEqual(typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as { readonly arguments?: JsonValue }).arguments : undefined, ['argument']);

	assert.deepEqual(await tasks.providers[0]!.provideTasks(new AbortController().signal), [{ id: 'unit', label: 'Unit', command: 'pnpm test', group: 'test' }]);
	assert.deepEqual(await tests.providers[0]!.provideTestProfiles(new AbortController().signal), [
		{ id: 'unit', label: 'Unit', taskId: 'extension:extensionHost.61636d652e64656d6f.7461736b73:unit' },
	]);

	using descriptorSession = new MockDebugSession('debug-registration', 'Host', {});
	const preparingAt = Date.now();
	assert.deepEqual(
		await services.get(IAdapterManager).get('acme')!.createDebugAdapterDescriptor!(
			{ id: 'launch', name: 'Host', type: 'acme', request: 'launch', arguments: { program: '/workspace/app' } },
			new AbortController().signal,
			descriptorSession,
		),
		{ program: 'hosted-adapter', arguments: ['', ' literal '] },
	);
	assert.equal(api.invocations.at(-1)?.registrationId, 'debug');
	assert.ok(api.invocations.at(-1)!.deadlineUnixMillis >= preparingAt + 300_000, 'first-use adapter preparation has a bounded download budget');
	api.invocationResult = Promise.resolve(null);
	assert.equal(
		await services.get(IAdapterManager).get('acme')!.createDebugAdapterDescriptor!(
			{ id: 'empty', name: 'Empty', type: 'acme', request: 'launch', arguments: {} },
			new AbortController().signal,
			descriptorSession,
		),
		undefined,
	);
	api.invocationResult = Promise.resolve({});
	await assert.rejects(
		Promise.resolve(
			services.get(IAdapterManager).get('acme')!.createDebugAdapterDescriptor!(
				{ id: 'invalid', name: 'Invalid', type: 'acme', request: 'launch', arguments: {} },
				new AbortController().signal,
				descriptorSession,
			),
		),
		/Extension Debug Adapter descriptor has an invalid shape/,
	);
	api.invocationResult = undefined;

	const pendingList = deferred<ExtensionHostFleetSnapshot>();
	api.listResult = pendingList.promise;
	api.emitChanged(2);
	assert.equal(commands.hasCommand('acme.old'), true);
	assert.equal(tasks.providers.length, 1);
	api.current = snapshot(2, 'acme.new');
	pendingList.resolve(api.current);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.ok(commands.hasCommand('acme.new'));

	api.listResult = Promise.reject(new Error('temporary list failure'));
	api.emitChanged(3);
	await waitFor(() => failures.includes('extensionHostRefreshFailed'));
	assert.equal(service.currentSnapshot.fleetGeneration, 2);
	assert.ok(commands.hasCommand('acme.new'));
	assert.equal(service.state, 'degraded');
	api.current = snapshot(3, 'acme.latest');
	api.listResult = undefined;

	api.emitConnection('crashed');
	assert.equal(commands.hasCommand('acme.new'), false);
	assert.equal(services.get(IAdapterManager).get('acme'), undefined);
	assert.equal(service.state, 'failed');
	api.emitConnection('ready');
	await waitFor(() => commands.hasCommand('acme.latest'));
});

test('projects supported language operations while diagnosing unsupported operations', async () => {
	const current = snapshot(1, 'acme.run', [
		{
			registrationId: 'language',
			kind: 'languageProvider',
			languageIds: ['typescript'],
			operations: ['hover', 'parameterHints', 'definition', 'documentColors'],
		},
	]);
	const api = new FakeExtensionHostApi(current);
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, tests);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));
	await service.start();

	using model = new TextModel('answer', { languageId: 'typescript' });
	const signal = new AbortController().signal;
	const request = {
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		position: new Position(1, 2),
		context: {
			kind: 'triggerCharacter' as const,
			triggerCharacter: ',',
			isRetrigger: true,
			activeSignatureHelp: {
				activeSignature: 0,
				signatures: [{ label: 'fn(value)', parameters: [{ label: 'value' }], activeParameter: 0 }],
			},
		},
	};
	assert.deepEqual(await languages.hoverProvider.ordered(model)[0]!.provideHover(request, signal), {
		contents: ['Host hover'],
	});
	assert.deepEqual(await languages.signatureHelpProvider.ordered(model)[0]!.provideParameterHints(request, signal), {
		signatures: [{ label: 'fn(value)', parameters: [{ label: 'value' }], activeParameter: 0 }],
		activeSignature: 0,
	});
	assert.deepEqual((api.invocations.find(request => request.operation === 'hover')!.payload as { readonly position: unknown }).position, { lineIndex: 0, columnIndex: 1 });
	assert.deepEqual(
		(
			api.invocations.find(request => request.operation === 'parameterHints')!.payload as {
				readonly position: unknown;
			}
		).position,
		{ lineIndex: 0, columnIndex: 1 },
	);
	assert.deepEqual(
		(
			api.invocations.find(request => request.operation === 'parameterHints')!.payload as {
				readonly context: unknown;
			}
		).context,
		request.context,
	);
	assert.equal(service.state, 'degraded');
	assert.ok(failures.includes('unsupportedRegistrationBridge'));
});

test('keeps the service stopped when the negotiated Host capability is absent', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run'));
	api.available = false;
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, tests);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
	const failures: string[] = [];
	service.onDidFail(failure => failures.push(failure.code));

	await service.start();
	assert.equal(service.state, 'stopped');
	assert.equal(service.currentSnapshot.fleetGeneration, 0);
	assert.equal(api.reconciles, 0);
	assert.deepEqual(failures, []);
});

test('projects bounded Extension Host stderr incrementally into extension-owned Output', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [], 'first diagnostic\n'));
	const tasks = new ProviderSink<TaskProvider>();
	const tests = new ProviderSink<TestProfileProvider>();
	using languages = new LanguageFeaturesService();
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using services = createServices(api, languages, tasks, tests, output);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 30_000);
	await service.start();

	const channel = output.getChannel('extension-host.acme.demo');
	assert.equal(channel?.descriptor.source, 'extension');
	assert.equal(channel?.descriptor.extensionId, 'acme.demo');
	assert.match(channel?.getText() ?? '', /first diagnostic/);

	api.current = snapshot(2, 'acme.run', [], 'first diagnostic\nsecond diagnostic\n');
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal((channel?.getText().match(/first diagnostic/g) ?? []).length, 1);
	assert.equal((channel?.getText().match(/second diagnostic/g) ?? []).length, 1);
});

test('projects ordered extension-created named Output channels without replaying old reveal requests', async () => {
	const created: readonly ExtensionHostOutputEvent[] = Object.freeze([
		Object.freeze({
			sequence: 1,
			incarnation: 3,
			activationGeneration: 11,
			operation: Object.freeze({ operation: 'create', channelId: 'review', label: 'Review', kind: 'log' }),
		}),
		Object.freeze({
			sequence: 2,
			incarnation: 3,
			activationGeneration: 11,
			operation: Object.freeze({
				operation: 'append',
				channelId: 'review',
				text: 'first\n',
				severity: 'information',
				category: 'review',
			}),
		}),
		Object.freeze({
			sequence: 3,
			incarnation: 3,
			activationGeneration: 11,
			operation: Object.freeze({ operation: 'show', channelId: 'review', preserveFocus: false }),
		}),
	]);
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [], '', created, 11));
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

	const channelId = 'extension.acme.demo.review';
	assert.equal(output.getChannel(channelId)?.getText(), 'first\n');
	assert.deepEqual(reveals, []);

	const updated = Object.freeze([
		...created,
		Object.freeze({
			sequence: 4,
			incarnation: 3,
			activationGeneration: 11,
			operation: Object.freeze({
				operation: 'append' as const,
				channelId: 'review',
				text: 'second\n',
				severity: 'warning' as const,
				category: undefined,
			}),
		}),
		Object.freeze({
			sequence: 5,
			incarnation: 3,
			activationGeneration: 11,
			operation: Object.freeze({ operation: 'show' as const, channelId: 'review', preserveFocus: true }),
		}),
	]);
	api.current = snapshot(2, 'acme.run', [], '', updated, 11);
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(output.getChannel(channelId)?.getText(), 'first\nsecond\n');
	assert.deepEqual(reveals, ['preserve']);

	api.current = snapshot(
		3,
		'acme.run',
		[],
		'',
		Object.freeze([
			...updated,
			Object.freeze({
				sequence: 6,
				incarnation: 3,
				activationGeneration: 11,
				operation: Object.freeze({ operation: 'dispose' as const, channelId: 'review' }),
			}),
		]),
		11,
	);
	api.emitChanged(3);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 3);
	assert.equal(output.getChannel(channelId), undefined);
});

test('extension log Output controls recording, reports levels to its exact host and hides only the active channel', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'outputEvents', registrationId: 'output-events' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const output = services.get(IOutputService);
	let closed = 0;
	services.get(IViewsService).isViewVisible = () => true;
	services.get(IViewsService).closeView = () => {
		closed++;
	};
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	const source = { extensionId: 'acme.demo', incarnation: 3, activationGeneration: 11 };
	const send = (channelId: string, payload: Record<string, JsonValue>) =>
		api.clientHandler!({ operation: 'editorOperation', payload: { method: 'output', channelId, ...payload } }, new AbortController().signal, source);
	await send('source', { action: 'create', label: 'Source', languageId: 'typescript' });
	await send('logs', { action: 'create', label: 'Logs', kind: 'log' });
	const channel = output.channels.find(channel => channel.label === 'Logs')!;
	assert.equal(output.channels.find(channel => channel.label === 'Source')!.descriptor.languageId, 'typescript');
	assert.equal(channel.kind, 'log');
	await send('logs', { action: 'log', severity: 'trace', text: 'filtered' });
	await send('logs', { action: 'log', severity: 'warning', text: 'retained' });
	assert.deepEqual(
		channel.entries.map(entry => entry.severity),
		['warning'],
	);
	api.emitChanged(1);
	await waitFor(() => api.invocations.some(request => request.operation === 'outputEvent'));
	channel.descriptor.logger!.control.setLevel('trace');
	await waitFor(() => api.invocations.some(request => request.operation === 'outputEvent' && (request.payload as { level: number }).level === 1));
	const event = api.invocations.find(request => request.operation === 'outputEvent')!;
	assert.deepEqual([event.extensionId, event.incarnation, event.activationGeneration], ['acme.demo', 3, 11]);
	await send('logs', { action: 'clear' });
	await send('logs', { action: 'log', severity: 'trace', text: 'new trace' });
	assert.match(channel.getText(), /new trace/);
	assert.doesNotMatch(channel.getText(), /retained/);
	await send('logs', { action: 'show', preserveFocus: true });
	await send('source', { action: 'hide' });
	assert.equal(closed, 0);
	await send('logs', { action: 'hide' });
	assert.equal(closed, 1);
	const id = channel.id;
	await send('logs', { action: 'dispose' });
	assert.equal(output.getChannel(id), undefined);
	assert.equal(
		api.invocationSignals.filter((_, index) => api.invocations[index]!.operation === 'outputEvent').every(signal => signal.aborted),
		true,
	);
});

test('Output created during activation survives same-process startup snapshots and retires on stop', async () => {
	const ready = snapshot(1, 'acme.run');
	const runtime = ready.extensions[0]!;
	const phase = (generation: number, lifecycle: 'handshaking' | 'ready' | 'stopped'): ExtensionHostFleetSnapshot => ({
		...ready,
		generation,
		extensions: [{ ...runtime, lifecycle, registrations: lifecycle === 'ready' ? runtime.registrations : [] }],
	});
	const api = new FakeExtensionHostApi(phase(1, 'handshaking'));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const output = services.get(IOutputService);
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	const source = {
		extensionId: runtime.id,
		incarnation: runtime.incarnation!,
		activationGeneration: runtime.activationGeneration,
	};
	const send = (payload: Record<string, JsonValue>) =>
		api.clientHandler!({ operation: 'editorOperation', payload: { method: 'output', channelId: 'activation', ...payload } }, new AbortController().signal, source);
	await send({ action: 'create', label: 'Activation Output', kind: 'log' });
	const channel = output.channels.find(entry => entry.label === 'Activation Output')!;
	api.current = phase(2, 'handshaking');
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(output.getChannel(channel.id), channel);
	api.current = phase(3, 'ready');
	api.emitChanged(3);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 3);
	await send({ action: 'log', severity: 'information', text: 'activation completed' });
	assert.match(channel.getText(), /activation completed/);
	api.current = phase(4, 'stopped');
	api.emitChanged(4);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 4);
	assert.equal(output.getChannel(channel.id), undefined);
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
	assert.deepEqual(
		output.channels.map(channel => channel.id),
		['host-diagnostics'],
	);
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
	assert.deepEqual(commands.getCommandIds(), ['acme.old', 'workbench.scm.action.retryInitialization']);
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
	await assert.rejects(
		async () => oldHandler({} as ServicesAccessor),
		error => error === 'Extension Host fleet generation was replaced',
	);
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
	const entry = {
		id: 'item',
		text: 'Current',
		tooltip: null,
		ariaLabel: null,
		alignment: 'right' as const,
		priority: 1.5,
		command: null,
	};
	api.current = snapshot(2, 'acme.run', [{ ...status, revision: 2, entries: [entry] }], '', [], 11);
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(commands.getCommand('acme.run'), handler);
	assert.equal(api.invocationSignals[0]!.aborted, false);
	result.resolve({ completed: true });
	assert.deepEqual(await pending, { completed: true });
	// The unchanged command belongs to the process, not to the retired UI snapshot.
	for (const property of ['id', 'activationGeneration', 'incarnation']) {
		Object.defineProperty(initialRuntime, property, {
			get: () => {
				throw new Error('Retired UI snapshot was accessed');
			},
		});
	}
	assert.deepEqual(await handler({} as ServicesAccessor), { completed: true });
	const statusbar = services.get(IStatusbarService);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]!.entry.text, 'Current');
	api.emitConnection('restarting');
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
});

test('SCM snapshots preserve pending commands until their extension authority is revoked', async () => {
	const scm = { kind: 'sourceControl' as const, registrationId: 'scm', revision: 1, providers: [] };
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [scm]));
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const result = deferred<JsonValue>();
	api.invocationResult = result.promise;
	const handler = commands.getCommand('acme.run')!;
	const pending = Promise.resolve(handler({} as ServicesAccessor));
	api.current = snapshot(2, 'acme.run', [{ ...scm, revision: 2 }], '', [], 11);
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(commands.getCommand('acme.run'), handler);
	assert.equal(api.invocationSignals[0]!.aborted, false);
	result.resolve({ completed: true });
	assert.deepEqual(await pending, { completed: true });
	api.emitConnection('restarting');
	assert.equal(api.invocationSignals[0]!.aborted, true);
});

test('registration replacement retires only that registration within a live extension', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run'));
	const command = api.current.extensions[0]!.registrations.find(registration => registration.kind === 'command')!;
	const other = { ...command, registrationId: 'other', command: 'acme.other', title: 'Other' };
	api.current = { ...api.current, extensions: [{ ...api.current.extensions[0]!, registrations: [command, other] }] };
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const result = deferred<JsonValue>();
	api.invocationResult = result.promise;
	const pending = Promise.resolve(commands.getCommand('acme.run')!({} as ServicesAccessor));
	const removed = Promise.resolve(commands.getCommand('acme.other')!({} as ServicesAccessor));
	const rejected = assert.rejects(removed, /Extension Host fleet generation was replaced/);
	api.current = {
		...api.current,
		generation: 2,
		extensions: [{ ...api.current.extensions[0]!, registrations: [command] }],
	};
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.equal(api.invocationSignals[0]!.aborted, false);
	assert.equal(api.invocationSignals[1]!.aborted, true);
	assert.equal(commands.getCommand('acme.other'), undefined);
	result.resolve({ completed: true });
	await rejected;
	assert.deepEqual(await pending, { completed: true });
});

test('extension API releases named output and providers when its host stops', async () => {
	const events: readonly ExtensionHostOutputEvent[] = [
		{
			sequence: 1,
			incarnation: 3,
			activationGeneration: 11,
			operation: { operation: 'create', channelId: 'review', label: 'Review', kind: 'output' },
		},
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
	assert.deepEqual(commands.getCommandIds(), ['workbench.scm.action.retryInitialization']);
	assert.deepEqual(tasks.providers, []);
	assert.deepEqual(tests.providers, []);
	await service.start();
	assert.ok(output.getChannel('extension.acme.demo.review'));
	api.emitConnection('crashed');
	assert.equal(output.getChannel('extension.acme.demo.review'), undefined);
});

test('extension API resets output for a new process and ignores stale output events', async () => {
	const events: readonly ExtensionHostOutputEvent[] = [
		{
			sequence: 1,
			incarnation: 3,
			activationGeneration: 11,
			operation: { operation: 'create', channelId: 'review', label: 'Review', kind: 'output' },
		},
		{
			sequence: 2,
			incarnation: 3,
			activationGeneration: 11,
			operation: { operation: 'append', channelId: 'review', text: 'old', severity: 'log', category: undefined },
		},
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
		{
			sequence: 99,
			incarnation: 3,
			activationGeneration: 11,
			operation: {
				operation: 'append',
				channelId: 'review',
				text: 'stale',
				severity: 'log',
				category: undefined,
			},
		},
		{
			sequence: 2,
			incarnation: 4,
			activationGeneration: 11,
			operation: { operation: 'append', channelId: 'review', text: 'new', severity: 'log', category: undefined },
		},
	];
	api.current = {
		generation: 2,
		extensions: [{ ...api.current.extensions[0]!, incarnation: 4, outputEvents: nextEvents }],
	};
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.fleetGeneration === 2);
	assert.notEqual(output.getChannel('extension.acme.demo.review'), previous);
	assert.equal(output.getChannel('extension.acme.demo.review')?.getText(), 'new');
});

class FixtureLifecycleService extends AbstractLifecycleService {}

class FakeExtensionHostApi implements IExtensionHostApi {
	async start(): Promise<ExtensionHostFleetSnapshot> {
		throw new Error('Startup is outside this fixture');
	}
	public clientHandler: ExtensionClientHandler | undefined;
	public registerClientHandler(handler: Parameters<IExtensionHostApi['registerClientHandler']>[0]): {
		dispose(): void;
	} {
		this.clientHandler = handler as ExtensionClientHandler;
		return {
			dispose: () => {
				this.clientHandler = undefined;
			},
		};
	}
	readonly activations: Parameters<IExtensionHostApi['activateByEvent']>[0][] = [];
	activationResult: Promise<ExtensionHostFleetSnapshot> | undefined;
	async activateByEvent(request: Parameters<IExtensionHostApi['activateByEvent']>[0]): Promise<ExtensionHostFleetSnapshot> {
		this.activations.push(request);
		assert.ok(this.activationResult, 'Unexpected activation request');
		return this.activationResult;
	}
	terminalQuickFixMatcher: JsonValue = { matches: true, outputMatcher: null };
	invocationResult: Promise<JsonValue> | undefined;
	readonly invocationSignals: AbortSignal[] = [];
	available = true;
	reconciles = 0;
	current: ExtensionHostFleetSnapshot;
	listResult: Promise<ExtensionHostFleetSnapshot> | undefined;
	readonly invocations: ExtensionHostInvocationRequest[] = [];
	private readonly changed = new Set<(generation: number) => void>();
	private readonly connections = new Set<(state: AppServerConnectionState) => void>();
	private connectionState: AppServerConnectionState = 'ready';

	constructor(snapshotValue: ExtensionHostFleetSnapshot) {
		this.current = snapshotValue;
	}

	list(): Promise<ExtensionHostFleetSnapshot> {
		return this.listResult ?? Promise.resolve(this.current);
	}
	reconcile(_mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot> {
		this.reconciles += 1;
		return Promise.resolve(this.current);
	}
	isAvailable(): Promise<boolean> {
		return Promise.resolve(this.available);
	}
	getConnectionState(): Promise<AppServerConnectionState> {
		return Promise.resolve(this.connectionState);
	}
	onDidChange(listener: (generation: number) => void) {
		this.changed.add(listener);
		return { dispose: () => this.changed.delete(listener) };
	}
	onConnectionState(listener: (state: AppServerConnectionState) => void) {
		this.connections.add(listener);
		return { dispose: () => this.connections.delete(listener) };
	}

	async invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		signal.throwIfAborted();
		this.invocations.push(request);
		this.invocationSignals.push(signal);
		if (
			request.operation === 'provideTerminalQuickFixes' &&
			request.payload !== null &&
			typeof request.payload === 'object' &&
			!Array.isArray(request.payload) &&
			(request.payload as { readonly [key: string]: JsonValue }).phase === 'matcher'
		)
			return this.terminalQuickFixMatcher;
		if (this.invocationResult) return this.invocationResult;
		if (request.operation === 'outputEvent' || request.operation === 'documentEvent' || request.operation === 'workspaceEvent') return null;
		if (request.operation === 'resolveConnection') return { connectionName: 'build' };
		if (request.operation === 'execute') return Object.freeze({ executed: true });
		if (request.operation === 'createDebugAdapterDescriptor') return { program: 'hosted-adapter', arguments: ['', ' literal '] };
		if (request.operation === 'provideTasks')
			return Object.freeze({
				tasks: Object.freeze([{ id: 'unit', label: 'Unit', command: 'pnpm test', group: 'test' }]),
			});
		if (request.operation === 'provideTestProfiles')
			return Object.freeze({
				profiles: Object.freeze([{ id: 'unit', label: 'Unit', taskProviderRegistrationId: 'tasks', taskId: 'unit' }]),
			});
		if (request.operation === 'hover') return Object.freeze({ contents: Object.freeze(['Host hover']) });
		if (request.operation === 'parameterHints')
			return Object.freeze({
				signatures: Object.freeze([{ label: 'fn(value)', parameters: Object.freeze([{ label: 'value' }]), activeParameter: 0 }]),
				activeSignature: 0,
			});
		throw new Error(`Unexpected operation ${request.operation}`);
	}

	emitChanged(generation: number): void {
		for (const listener of this.changed) listener(generation);
	}
	emitConnection(state: AppServerConnectionState): void {
		this.connectionState = state;
		for (const listener of this.connections) listener(state);
	}
}

class ProviderSink<TProvider> {
	readonly onDidWriteTerminalData = Event.None;
	readonly onDidStartTask = Event.None;
	readonly onDidChangeTaskRun = Event.None;
	readonly onWillNewSession = Event.None;
	readonly onDidNewSession = Event.None;
	readonly onDidEndSession = Event.None;
	readonly onDidChangeSession = Event.None;
	getViewModel() {
		return {
			focusedSession: undefined,
			focusedThread: undefined,
			focusedStackFrame: undefined,
			onDidFocusStackFrame: Event.None,
			onDidFocusThread: Event.None,
		};
	}
	readonly onDidChangeBreakpoints = Event.None;
	readonly breakpoints = [];
	readonly functionBreakpoints = [];
	readonly activeRuns = Object.freeze([]);
	readonly sessions = Object.freeze([]);
	readonly session = undefined;
	providers: readonly TProvider[] = Object.freeze([]);
	rejectNextReplacement: Error | undefined;

	registerDebugAdapterTrackerFactories(_providers: readonly IDebugAdapterTrackerFactory[]): DebugAdapterTrackerFactoryRegistration {
		const registration = toDisposable(() => {}) as DebugAdapterTrackerFactoryRegistration;
		registration.replace = () => {};
		return registration;
	}

	registerDebugConfigurationProviders(providers: readonly IDebugConfigurationProvider[]): DebugConfigurationProviderRegistration {
		return this.registration(providers as readonly TProvider[]) as DebugConfigurationProviderRegistration;
	}

	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration {
		return this.registration(providers as readonly TProvider[]) as TaskProviderRegistration;
	}
	registerTestProfileProviders(providers: readonly TestProfileProvider[]): TestProfileProviderRegistration {
		return this.registration(providers as readonly TProvider[]) as TestProfileProviderRegistration;
	}

	private registration(initial: readonly TProvider[]): TaskProviderRegistration | TestProfileProviderRegistration | DebugConfigurationProviderRegistration {
		let disposed = false;
		this.providers = Object.freeze([...initial]);
		const registration = toDisposable(() => {
			disposed = true;
			this.providers = Object.freeze([]);
		}) as TaskProviderRegistration;
		registration.replace = providers => {
			if (disposed) throw new ReferenceError('Provider registration is disposed');
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

function snapshot(
	generation: number,
	command: string,
	additional: readonly ExtensionHostFleetSnapshot['extensions'][number]['registrations'][number][] = [],
	stderr = '',
	outputEvents: readonly ExtensionHostOutputEvent[] = [],
	activationGeneration = 10 + generation,
): ExtensionHostFleetSnapshot {
	return Object.freeze({
		generation,
		extensions: Object.freeze([
			Object.freeze({
				id: 'acme.demo',
				version: '1.0.0',
				packageDigest: DIGEST,
				runtimeApiVersion: 1,
				activationGeneration,
				incarnation: 3,
				lifecycle: 'ready' as const,
				failure: undefined,
				stderr,
				outputEvents: Object.freeze([...outputEvents]),
				registrations: Object.freeze([
					Object.freeze({ registrationId: 'command', kind: 'command' as const, command, title: 'Run' }),
					Object.freeze({ registrationId: 'tasks', kind: 'taskProvider' as const, taskType: 'acme' }),
					Object.freeze({
						registrationId: 'tests',
						kind: 'testProfileProvider' as const,
						providerId: 'acme.tests',
						label: 'Tests',
					}),
					Object.freeze({ registrationId: 'debug', kind: 'debugAdapter' as const, debuggerType: 'acme' }),
					...additional,
				]),
			}),
		]),
	});
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => {
		resolve = accept;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw new Error('Timed out waiting for Extension Host state');
}

function acquireFile(services: InstantiationService, text: string, resource: URI, languageId = 'plaintext'): Promise<TextModelReference> {
	return services.get(IFileTextModelService).acquire({ resource, initialText: text, languageId }, new AbortController().signal);
}

function createServices(
	api: IExtensionHostApi,
	languages: ILanguageFeaturesService,
	tasks: ProviderSink<TaskProvider>,
	tests: ProviderSink<TestProfileProvider>,
	output?: IOutputService,
	debug = new ProviderSink<IDebugConfigurationProvider>(),
	remote?: { connections: IRemoteConnectionApi; confirm: IDialogService['confirm'] },
	extensionApi?: IExtensionApi,
): InstantiationService {
	const services = workbenchInstantiationService(undefined, undefined, {
		dialogService: {
			onWillShowDialog: Event.None,
			onDidShowDialog: Event.None,
			confirm: remote?.confirm ?? (() => assert.fail('Unexpected Remote confirmation')),
			showMessage: () => assert.fail('Unexpected dialog'),
			info: () => assert.fail('Unexpected dialog'),
			warn: () => assert.fail('Unexpected dialog'),
			error: () => assert.fail('Unexpected dialog'),
			about: () => assert.fail('Unexpected dialog'),
			prompt: () => assert.fail('Unexpected dialog'),
			input: () => assert.fail('Unexpected dialog'),
		},
		languageFeatures: languages,
		output,
		fileResources: {
			onDidChange: Event.None,
			resolve: async input => ({ resource: input.resource, text: input.bootstrapText ?? '', revision: '1' }),
			save: async () => {
				throw new Error('Persistence is outside this extension-host scenario');
			},
		},
	});
	services.registerSingleton(ISpeechService, () => new SpeechService(undefined));
	services.registerSingleton(ITimelineService, () => services.createInstance(TimelineService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
	services.registerInstance(IAdapterManager, services.resources.add(new AdapterManager()));
	services.registerInstance(IFileService, services.resources.add(new FileService()));
	services.registerSingleton(IExtensionService, () => new TestExtensionService(extensionApi, services.get(IAdapterManager)));
	services.registerInstance(ITerminalProcessService, {
		onConnectionState: Event.None,
		listProfiles: async () => [],
	} as unknown as ITerminalProcessService);
	services.registerInstance(ITerminalService, { ...Disposable.None } as unknown as ITerminalService);
	services.registerInstance(ITerminalGroupService, {
		...Disposable.None,
		groups: [],
		activeGroup: undefined,
		onDidChangeGroups: Event.None,
		createGroup: () => assert.fail('Unexpected terminal group creation'),
		getGroupForInstance: () => assert.fail('Unexpected terminal group lookup'),
		joinInstances: () => assert.fail('Unexpected terminal group join'),
		moveInstance: () => assert.fail('Unexpected terminal group move'),
		unsplitInstance: () => assert.fail('Unexpected terminal group unsplit'),
		instanceIsSplit: () => assert.fail('Unexpected terminal split lookup'),
		setActiveInstanceByIndex: () => assert.fail('Unexpected terminal group selection'),
		showPanel: async () => assert.fail('Unexpected terminal panel request'),
		focusHover: async () => assert.fail('Unexpected terminal hover request'),
	});
	services.registerSingleton(ITerminalCompletionService, () => services.createInstance(TerminalCompletionService));
	services.registerSingleton(ITerminalQuickFixService, () => services.createInstance(TerminalQuickFixService));
	services.registerSingleton(ITerminalLinkProviderService, () => services.createInstance(TerminalLinkProviderService));
	services.registerSingleton(IEnvironmentVariableService, () => services.createInstance(EnvironmentVariableService));
	services.registerSingleton(ITerminalContributionService, () => services.createInstance(TerminalContributionService));
	services.registerSingleton(ITerminalProfileService, () => services.createInstance(TerminalProfileService));
	services.registerInstance(ITerminalProfileResolverService, {} as ITerminalProfileResolverService);
	services.registerInstance(IExtensionHostApi, api);
	// These registrations exercise host callbacks without opening editor UI.
	services.registerInstance(IEditorService, {
		openEditor: async () => assert.fail('Unexpected editor open'),
	} as unknown as IEditorService);
	services.registerInstance(IEditorPart, {
		groups: [],
		activeGroup: undefined,
		onDidChangeEditors: Event.None,
	} as unknown as IEditorPart);
	services.registerInstance(IFileDialogService, {
		pickFolderAndOpen: async () => assert.fail('Unexpected folder open'),
		pickWorkspaceAndOpen: async () => assert.fail('Unexpected workspace open'),
		pickFileToSave: async () => undefined,
		showOpenDialog: async () => assert.fail('Unexpected folder picker'),
		showSaveDialog: async () => undefined,
		showSaveConfirm: async () => 2,
	});
	services.registerInstance(IWorkingCopyService, {
		get: () => assert.fail('Unexpected working copy request'),
	} as unknown as IWorkingCopyService);
	services.registerInstance(IViewsService, {
		openView: async () => assert.fail('Unexpected view open'),
	} as unknown as IViewsService);
	services.registerInstance(
		IViewDescriptorService,
		services.resources.add(new TestViewDescriptorService({ registry: services.resources.add(new WorkbenchViewRegistry()) }, services.get(IContextKeyService))),
	);
	services.registerInstance(IPaneCompositePartService, {
		onDidPaneCompositeOpen: Event.None,
		onDidPaneCompositeClose: Event.None,
		getProgressIndicator: () => undefined,
		getActivePaneComposite: () => undefined,
		getLastActivePaneCompositeId: () => undefined,
		getPartId: () => assert.fail('UI Parts are outside this extension-host scenario'),
		openPaneComposite: async () => assert.fail('Unexpected pane open'),
		hideActivePaneComposite: () => assert.fail('Unexpected pane hide'),
	});
	services.registerInstance(IClipboardService, {
		writeText: async () => assert.fail('Unexpected clipboard write'),
	} as unknown as IClipboardService);
	services.registerInstance(IOpenerService, {
		open: async () => assert.fail('Unexpected external open'),
	} as unknown as IOpenerService);
	services.registerInstance(ICodeEditorService, {
		listDiffEditors: () => assert.fail('Unexpected diff editor request'),
		listCodeEditors: () => [],
		onCodeEditorAdd: Event.None,
		onCodeEditorRemove: Event.None,
	} as unknown as ICodeEditorService);
	services.registerInstance(ITextFileService, {
		read: async () => assert.fail('Unexpected text file request'),
	} as unknown as ITextFileService);

	services.registerInstance(
		IExtensionApi,
		extensionApi ?? {
			list: async () => ({ generation: 1, extensions: [], diagnostics: [] }),
			resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
		},
	);
	services.registerInstance(IExtensionBackendApi, {
		request: async () => assert.fail('Unexpected extension backend request'),
	});
	services.registerInstance(IAppServerApi, {
		connectionGeneration: 1,
		getConnectionState: () => api.getConnectionState(),
		getSlashCommands: async () => [],
		onConnectionState: listener => api.onConnectionState(listener),
	});
	services.registerInstance(IServerEventApi, { subscribe: () => toDisposable(() => {}) });
	services.registerInstance(ISCMService, services.resources.add(new SCMService()));
	services.registerSingleton(ISCMViewService, () => services.createInstance(SCMViewService));
	services.registerInstance(IQuickDiffService, services.resources.add(new QuickDiffService()));
	services.registerInstance(IMultiDiffSourceResolverService, services.resources.add(new MultiDiffSourceResolverService()));
	services.registerInstance(IDecorationsService, {
		onDidChangeDecorations: Event.None,
		registerDecorationsProvider: () => toDisposable(() => {}),
		getDecoration: () => undefined,
	});
	services.registerInstance(IHostService, {
		reload: async () => {
			throw new Error('Unexpected reload in this fixture');
		},
		hasFocus: true,
		onDidChangeFocus: Event.None,
		openWindow: async () => assert.fail('Unexpected window'),
		restart: async () => assert.fail('Unexpected restart'),
		getScreenshot: async () => undefined,
	});
	services.registerInstance(IRemoteConnectionApi, remote?.connections ?? UnavailableRemoteConnectionApi);
	services.registerSingleton(IRemoteConnectionService, () => services.createInstance(RemoteConnectionService));

	services.registerSingleton(IMarkerService, () => services.createInstance(MarkerService));
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(ILifecycleService, () => services.createInstance(FixtureLifecycleService, undefined));
	services.registerInstance(ITaskService, tasks as unknown as ITaskService);
	services.registerInstance(IDebugService, debug as unknown as IDebugService);
	services.registerInstance(ITestingService, tests as unknown as ITestingService);
	// These scenarios exercise registrations and provider calls, never edits or Quick Input UI.
	services.registerInstance(IBulkEditService, {
		_serviceBrand: undefined,
		hasPreviewHandler: () => assert.fail('Unexpected bulk edit request'),
		setPreviewHandler: () => assert.fail('Unexpected bulk edit request'),
		apply: () => assert.fail('Unexpected bulk edit request'),
	});
	services.registerInstance(IQuickInputService, {
		...quickInputServiceTestControls,

		createQuickPick: () => assert.fail('Unexpected Quick Input request'),
		input: () => assert.fail('Unexpected Quick Input request'),
	});

	return services;
}

function dormantSnapshot(events: readonly string[] = ['onCommand:acme.lazy']): ExtensionHostFleetSnapshot {
	const ready = snapshot(1, 'acme.lazy');
	return Object.freeze({
		...ready,
		extensions: Object.freeze([
			Object.freeze({
				...ready.extensions[0]!,
				incarnation: undefined,
				lifecycle: 'dormant' as const,
				activation: Object.freeze({
					events: Object.freeze([...events]),
					commands: Object.freeze([{ command: 'acme.lazy', title: 'Lazy command' }]),
				}),
				registrations: Object.freeze([]),
			}),
		]),
	});
}

for (const language of ['en', 'zh-CN'])
	test(`dormant package commands appear in the palette in ${language} before activation`, async () => {
		setNlsMessages(language, {});
		using restoreLocale = toDisposable(resetNlsResolver);
		const initial = dormantSnapshot();
		const runtime = initial.extensions[0]!;
		const api = new FakeExtensionHostApi({
			...initial,
			extensions: [
				{
					...runtime,
					activation: {
						...runtime.activation!,
						commands: [{ command: 'acme.lazy', title: '%command.install%' }],
					},
				},
			],
		});
		using languages = new LanguageFeaturesService();
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, {
			list: async () => ({ generation: 1, extensions: [], diagnostics: [] }),
			resources: new ExtensionResourceLoaderService(async request => {
				assert.equal(request.extensionId, 'acme.demo');
				assert.equal(request.generation, 1);
				return readFileSync(`extensions/debug-lldb/${request.path}`);
			}),
		});
		const commands = new CommandRegistry();
		using host = services.createInstance(AppServerExtensionHostService, commands, 1_000);
		await host.start();
		const expected = language === 'en' ? 'LLDB: Install or Retry Debugger' : 'LLDB：安装或重试调试器';
		assert.equal(commands.getCommands().get('acme.lazy')?.metadata?.description, expected);
		const items = () => MenusRegistry.getMenuItems(MenuId.CommandPalette).filter(item => 'command' in item && item.command.id === 'acme.lazy');
		assert.deepEqual(
			items().map(item => 'command' in item && item.command.title),
			[expected],
		);
		assert.equal(api.activations.length, 0);
		assert.equal(api.current.extensions[0]!.activation!.commands[0]!.title, '%command.install%');
		await host.stop();
		assert.deepEqual(items(), []);
	});

test('stopping while dormant command titles load prevents late palette publication', async () => {
	const initial = dormantSnapshot();
	const runtime = initial.extensions[0]!;
	const api = new FakeExtensionHostApi({
		...initial,
		extensions: [
			{
				...runtime,
				activation: {
					...runtime.activation!,
					commands: [{ command: 'acme.lazy', title: '%command.install%' }],
				},
			},
		],
	});
	const messages = deferred<Uint8Array>();
	let requested = false;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, {
		list: async () => ({ generation: 1, extensions: [], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(() => {
			requested = true;
			return messages.promise;
		}),
	});
	const commands = new CommandRegistry();
	using host = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	const starting = host.start();
	await waitFor(() => requested);
	await host.stop();
	messages.resolve(new TextEncoder().encode('{"command.install":"Install"}'));
	await starting;
	assert.equal(commands.hasCommand('acme.lazy'), false);
	assert.equal(host.state, 'stopped');
});

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
	assert.deepEqual(
		api.activations.map(({ initialization, ...request }) => request),
		[{ extensionId: 'acme.demo', activationGeneration: 11, event: { type: 'command', command: 'acme.lazy' } }],
	);
	assert.ok(api.activations[0]!.initialization);
	assert.deepEqual(
		api.activations[0]!.initialization!.workspaceFolders,
		services
			.get(IWorkspaceContextService)
			.getWorkspace()
			.folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name, index: folder.index })),
	);
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

test('first-use editor commands retain their originating input across asynchronous activation', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot());
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	const commands = new CommandRegistry();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const inputs = [{ resource: URI.file('/notes/origin.md') }, { resource: URI.file('/notes/later.md') }];
	const group = { id: 1, inputs, activeInput: inputs[0] };
	Object.assign(services.get(IEditorPart), { groups: [group], activeGroup: group });
	using service = services.createInstance(AppServerExtensionHostService, commands, 1_000);
	await service.start();
	const result = services.invokeFunction(accessor => commands.getCommand('acme.lazy')!(accessor));
	await waitFor(() => api.activations.length === 1);
	group.activeInput = inputs[1];
	const ready = snapshot(2, 'acme.lazy', [], '', [], 11);
	activation.resolve({
		...ready,
		extensions: ready.extensions.map(runtime => ({
			...runtime,
			registrations: runtime.registrations.map(registration => (registration.kind === 'command' ? { ...registration, menus: [{ menu: 'editor/title' }] } : registration)),
		})),
	});
	await result;
	assert.deepEqual(JSON.parse(JSON.stringify(api.invocations[0]!.payload)), {
		arguments: [],
		activeEditor: { resource: inputs[0]!.resource.toJSON(), groupId: group.id, editorIndex: 0 },
	});
});

test('already open language models activate matching extensions once while startup awaits restoration', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onLanguage:typescript']));
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using language = services.get(ILanguageService).registerLanguage({ id: 'typescript' });
	using reference = await acquireFile(services, 'unsaved', URI.file('/project/main.ts'), 'typescript');
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
		const languageService = services.get(ILanguageService);
		using language = languageService.registerLanguage({ id: 'typescript' });
		using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
		await service.start();
		assert.equal(api.activations.length, 0);
		using reference = await acquireFile(services, 'text', URI.file('/project/main.ts'), trigger === 'create' ? 'typescript' : 'plaintext');
		if (trigger === 'change') {
			reference.model.setLanguage(languageService.createById('typescript'));
		}
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
	const registration = {
		kind: 'debugConfigurationProvider' as const,
		registrationId: 'configurations',
		debuggerType: 'acme',
		triggerKind: 1 as const,
	};
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

test('task discovery, debug and terminal profile phases activate only matching dormant extension owners', async () => {
	for (const { declarations, ignored, event, expected } of [
		{
			declarations: ['onTaskType:build'],
			ignored: 'onTaskType:test',
			event: 'onTaskType',
			expected: { type: 'taskType', taskType: 'build' },
		},
		{
			declarations: ['onTerminalProfile:shell'],
			ignored: 'onTerminalProfile:other',
			event: 'onTerminalProfile:shell',
			expected: { type: 'terminalProfile', profileId: 'shell' },
		},
		{
			declarations: ['onTaskType'],
			ignored: 'onDebug',
			event: 'onTaskType',
			expected: { type: 'taskType', taskType: null },
		},
		{
			declarations: ['onDebugResolve:node'],
			ignored: 'onDebugResolve:python',
			event: 'onDebugResolve:node',
			expected: { type: 'debug', phase: 'resolveConfiguration', debugType: 'node' },
		},
		{
			declarations: ['onDebugInitialConfigurations'],
			ignored: 'onDebugDynamicConfigurations',
			event: 'onDebugInitialConfigurations',
			expected: { type: 'debug', phase: 'initialConfigurations', debugType: null },
		},
		{
			declarations: ['onDebugDynamicConfigurations'],
			ignored: 'onDebugInitialConfigurations',
			event: 'onDebugDynamicConfigurations',
			expected: { type: 'debug', phase: 'dynamicConfigurations', debugType: null },
		},
		{
			declarations: ['onDebugDynamicConfigurations:node'],
			ignored: 'onDebugDynamicConfigurations:python',
			event: 'onDebugDynamicConfigurations',
			expected: { type: 'debug', phase: 'dynamicConfigurations', debugType: 'node' },
		},
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
		assert.deepEqual(
			api.activations.map(({ initialization, ...request }) => request),
			[{ extensionId: 'acme.demo', activationGeneration: 11, event: expected }],
		);
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
	api.activationResult = Promise.resolve({
		...ready,
		extensions: [{ ...ready.extensions[0]!, lifecycle: 'failed', incarnation: undefined, registrations: [] }],
	});
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	await assert.rejects(services.get(IExtensionService).activateByEvent('onTaskType'), /failed/);
	assert.equal(host.currentSnapshot.extensions[0]!.state, 'failed');
});

test('activating a task-only owner preserves existing debug providers and pending calls until their own owner retires', async () => {
	const configuration = {
		kind: 'debugConfigurationProvider' as const,
		registrationId: 'configurations',
		debuggerType: 'acme',
		triggerKind: 1 as const,
	};
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [configuration]));
	const original = api.current.extensions[0]!;
	const tasks = new ProviderSink<TaskProvider>();
	const debug = new ProviderSink<IDebugConfigurationProvider>();
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, tasks, new ProviderSink<TestProfileProvider>(), undefined, debug);
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const provider = debug.providers[0]!;
	const adapter = services.get(IAdapterManager).get('acme');
	const result = deferred<JsonValue>();
	api.invocationResult = result.promise;
	const pending = provider.resolveDebugConfiguration!(URI.file('/workspace'), { name: 'Resolve', type: 'acme', request: 'launch' }, new AbortController().signal);
	const next = {
		...original,
		id: 'acme.lazy-task',
		registrations: [{ kind: 'taskProvider' as const, registrationId: 'build', taskType: 'builder' }],
	};
	api.current = { generation: 2, extensions: [original, next] };
	api.emitChanged(2);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 2);
	assert.equal(debug.providers[0], provider);
	assert.equal(services.get(IAdapterManager).get('acme'), adapter);
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

test('eager contributed editors finish activation before the restoration barrier opens', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['*']));
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	const extensions = services.get(IExtensionService);
	extensions.getExtensionPointContributions = <T>(name: string) =>
		name === 'customEditors'
			? [
					{
						description: {
							id: 'acme.demo',
							name: 'lazy',
							publisher: 'acme',
							version: '1',
							displayName: 'Lazy editor',
							sourceKind: 'builtIn',
							manifestSha256: DIGEST,
							packageSha256: DIGEST,
						},
						value: [{}] as unknown as T,
					},
				]
			: [];
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	let restored = false;
	const starting = service.start().then(() => {
		restored = true;
	});
	await waitFor(() => api.activations.length === 1);
	assert.equal(restored, false);
	assert.ok(services.get(ILifecycleService).phase < LifecyclePhase.Restored);
	activation.resolve(snapshot(2, 'acme.lazy', [], '', [], 11));
	await starting;
	assert.equal(service.currentSnapshot.extensions[0]?.state, 'ready');
	assert.equal(restored, true);
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
	assert.deepEqual(
		api.activations[0]!.initialization!.workspaceFolders,
		services
			.get(IWorkspaceContextService)
			.getWorkspace()
			.folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name, index: folder.index })),
	);
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
	assert.deepEqual(
		api.invocations.map(request => (request.payload as Record<string, JsonValue>).configurationValues),
		normalizeExtensionHostPayload([{ sample: { enabled: true, count: 1 } }, { sample: { enabled: false, count: 1 } }, { sample: { enabled: false, count: 0 } }]),
	);
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

test('JSON schema bridge returns detached owner contributions and retires schema notifications', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'workspaceEvents', registrationId: 'window' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using bridge = services.createInstance(MainThreadConfiguration, 1_000, (error: unknown) => {
		throw error;
	});
	using schemas = new DisposableStore();
	const registry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
	const uri = 'test://json-bridge/schema';
	const schema = {
		type: 'object' as const,
		description: undefined,
		properties: { enabled: { type: 'boolean' as const } },
	};
	bridge.update(api.current);
	await waitFor(() => api.invocations.length === 1);
	registry.registerSchema(uri, schema, schemas);
	using association = registry.registerSchemaAssociation(uri, '**/sample.jsonc');
	await waitFor(() => api.invocations.length === 3);
	assert.deepEqual(
		api.invocations.slice(1).map(request => request.payload),
		[
			{ type: 'jsonSchemas', revision: 1, emit: true },
			{ type: 'jsonSchemas', revision: 2, emit: true },
		],
	);
	const contributions = bridge.getJsonSchemaContributions() as {
		uri: string;
		fileMatch: string[];
		schema: { properties: { enabled: { type: string } } };
	}[];
	const contribution = contributions.find(value => value.uri === uri)!;
	assert.deepEqual(contribution.fileMatch, ['**/sample.jsonc']);
	assert.equal(Object.hasOwn(contribution.schema, 'description'), false);
	assert.notEqual(contribution.schema, schema);
	assert.throws(() => {
		contribution.schema.properties.enabled.type = 'string';
	}, TypeError);
	assert.throws(() => {
		contribution.fileMatch.push('**/other.json');
	}, TypeError);
	assert.equal(schema.properties.enabled.type, 'boolean');
	assert.deepEqual(registry.getSchemaAssociations()[uri], ['**/sample.jsonc']);
	registry.notifySchemaChanged(uri);
	await waitFor(() => api.invocations.length === 4);
	bridge.clear();
	association.dispose();
	registry.notifySchemaChanged(uri);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(api.invocations.length, 4);
});

test('workspace bridge reads the actual workspace owner and fences cleared subscriptions', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'workspaceEvents', registrationId: 'window' }]));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using workspace = new TestWorkspaceService({ id: 'empty' });
	using scope = services.createChild();
	scope.registerInstance(IWorkspaceContextService, workspace);
	const errors: unknown[] = [];
	using bridge = scope.createInstance(MainThreadWorkspace, 1_000, (error: unknown) => errors.push(error));
	bridge.update(api.current);
	await waitFor(() => api.invocations.length === 1);
	const folders = [URI.file('/one'), URI.file('/two')].map((uri, index) => ({
		id: String(index),
		uri,
		index,
		name: `Root ${index}`,
	}));
	workspace.updateWorkspace({
		id: 'two',
		name: 'Two roots',
		configuration: URI.file('/window.code-workspace'),
		folders,
	});
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
	using workspace = new TestWorkspaceService({ id: 'empty' });
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
	workspace.updateWorkspace({
		id: 'folder',
		folders: [{ id: 'root', uri: URI.file('/changed'), name: 'Changed', index: 0 }],
	});
	const after = await api.clientHandler!({ operation: 'readInitialization' }, signal, source);
	assert.ok(after.result === 'initialization');
	assert.equal(after.initialization.language, getNLSLanguage());
	assert.deepEqual(before.initialization.workspaceFolders, []);
	assert.deepEqual(after.initialization.workspaceFolders, [{ uri: 'file:///changed', name: 'Changed', index: 0 }]);
	assert.equal((before.initialization.configurationValues.sample as { enabled: boolean }).enabled, true);
	assert.equal((after.initialization.configurationValues.sample as { enabled: boolean }).enabled, false);
	assert.deepEqual(after.initialization.configurationData, configuration.getConfigurationData());
});

test('Remote extension resolves a saved target and connects only after host confirmation', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'remoteConnectionResolver', registrationId: 'remote:team', authorityPrefix: 'team' }]));
	using languages = new LanguageFeaturesService();
	const connected: string[] = [];
	const confirmations: unknown[] = [];
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, {
		connections: {
			...UnavailableRemoteConnectionApi,
			available: true,
			list: async () => [{ name: 'build', host: 'build-linux', workspace: '/srv/project' }],
			connect: async name => {
				connected.push(name);
			},
		},
		confirm: async options => {
			confirmations.push(options);
			return { confirmed: true };
		},
	});
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
	using restoreLocale = toDisposable(resetNlsResolver);
	const result = await api.clientHandler!({ operation: 'openRemoteConnection', authority: 'team+linux' }, new AbortController().signal, {
		extensionId: 'acme.demo',
		incarnation: 3,
		activationGeneration: 11,
	});
	assert.deepEqual(result, { result: 'done' });
	assert.deepEqual(connected, ['build']);
	assert.deepEqual(
		api.invocations.map(request => [request.registrationId, request.operation, request.payload, request.incarnation, request.activationGeneration]),
		[['remote:team', 'resolveConnection', { authority: 'team+linux' }, 3, 11]],
	);
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
			...UnavailableRemoteConnectionApi,
			available: true,
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

test('Canvas demand activates the admitted DataChannel owner without requiring a running registration', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onDemand:dataChannel']));
	api.activationResult = Promise.resolve(snapshot(2, 'acme.canvas', [], '', [], 11));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	services.registerInstance(ITerminalGroupService, {} as ITerminalGroupService);
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	await services.get(IExtensionService).activateByEvent('onCanvas');
	assert.deepEqual(
		api.activations.map(({ initialization, ...request }) => request),
		[
			{
				extensionId: 'acme.demo',
				activationGeneration: 11,
				event: { type: 'capability', capability: 'dataChannel' },
			},
		],
	);
});

test('terminal link demand activates its exact dormant extension through the window owner', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onDemand:terminalLinkProvider']));
	api.activationResult = Promise.resolve(snapshot(2, 'acme.links', [], '', [], 11));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const extensions = services.get(IExtensionService);
	await extensions.activateByEvent('onSpeech');
	assert.equal(api.activations.length, 0);
	await extensions.activateByEvent('onTerminal');
	assert.deepEqual(
		api.activations.map(({ initialization, ...request }) => request),
		[
			{
				extensionId: 'acme.demo',
				activationGeneration: 11,
				event: { type: 'capability', capability: 'terminalLinkProvider' },
			},
		],
	);
});

test('terminal link registrations reach the shared owner and retire callbacks with their process and host', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.links', [{ kind: 'terminalLinkProvider', registrationId: 'links' }]));
	using languages = new LanguageFeaturesService();
	const manifestJson = JSON.stringify({ name: 'demo', publisher: 'acme', version: '1.0.0' });
	const extensionApi: IExtensionApi = {
		resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
		list: async () => ({
			generation: 1,
			diagnostics: [],
			extensions: [
				{
					id: 'acme.demo',
					name: 'demo',
					publisher: 'acme',
					version: '1.0.0',
					displayName: 'Demo',
					sourceKind: 'user',
					manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`,
					packageSha256: DIGEST,
					manifestJson,
				},
			],
		}),
	};
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi);
	await services.get(IExtensionService).start();
	using stateChanged = new Emitter<import('../../../../contrib/terminal/browser/terminal.js').TerminalInstanceState>();
	using removed = new Emitter<import('../../../../contrib/terminal/browser/terminal.js').ITerminalInstance>();
	const instance = {
		id: 'terminal-1',
		title: 'Shell',
		processId: 42,
		state: 'running',
		onDidChangeState: stateChanged.event,
	} as import('../../../../contrib/terminal/browser/terminal.js').ITerminalInstance;
	Object.assign(services.get(ITerminalService), { instances: [instance], onDidDisposeInstance: removed.event });
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const links = services.get(ITerminalLinkProviderService);
	assert.equal(links.linkProviders.size, 1);
	const provider = [...links.linkProviders][0]!;
	api.invocationResult = Promise.resolve({
		links: [{ id: 'issue-1', startIndex: 2, length: 4, label: 'Open issue' }],
	});
	const result = await provider.provideLinks(instance, '  #123');
	assert.deepEqual(api.invocations.at(-1)?.payload, {
		line: '  #123',
		terminal: { id: 'terminal-1', name: 'Shell', processId: 42 },
	});
	assert.equal(api.invocations.at(-1)?.operation, 'provideTerminalLinks');
	assert.deepEqual(
		result?.map(({ activate, ...link }) => link),
		[{ startIndex: 2, length: 4, label: 'Open issue' }],
	);
	api.invocationResult = Promise.resolve(null);
	result![0]!.activate('#123');
	await waitFor(() => api.invocations.length === 2);
	assert.equal(api.invocations.at(-1)?.operation, 'handleTerminalLink');
	assert.deepEqual(api.invocations.at(-1)?.payload, {
		id: 'issue-1',
		line: '  #123',
		startIndex: 2,
		length: 4,
		terminal: { id: 'terminal-1', name: 'Shell', processId: 42 },
	});
	// Returning to the same running process cannot revive a pre-reconnect callback.
	stateChanged.fire('reconnecting');
	stateChanged.fire('running');
	result![0]!.activate('#123');
	assert.equal(api.invocations.length, 2);
	api.invocationResult = Promise.resolve({ links: [{ id: 'bad', startIndex: 0, length: 7 }] });
	await assert.rejects(provider.provideLinks(instance, 'short'), /Invalid terminal profile provider response/);
	const pending = deferred<JsonValue>();
	api.invocationResult = pending.promise;
	const reading = provider.provideLinks(instance, 'pending');
	const rejected = assert.rejects(reading);
	const signal = api.invocationSignals.at(-1)!;
	api.emitConnection('stopped');
	assert.equal(signal.aborted, true);
	assert.equal(links.linkProviders.size, 0);
	pending.resolve({ links: [{ id: 'late', startIndex: 0, length: 1 }] });
	await rejected;
	result![0]!.activate('#123');
	assert.equal(api.invocations.length, 4);
});

suite('Extension terminal environment reader lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const retirement of ['clear', 'disconnect'] as const)
		test(`withdraws cached environment contributions and their reader on ${retirement}`, async () => {
			const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [{ kind: 'terminalEnvironment', registrationId: 'environment' }]));
			api.invocationResult = Promise.resolve({
				persistent: false,
				map: [['EXTENSION_VALUE', { type: 1, value: 'active' }]],
			});
			using languages = new LanguageFeaturesService();
			const manifestJson = JSON.stringify({ name: 'demo', publisher: 'acme', version: '1.0.0' });
			const manifestSha256 = `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`;
			const extensionApi: IExtensionApi = {
				resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
				list: async () => ({
					generation: 1,
					diagnostics: [],
					extensions: [
						{
							id: 'acme.demo',
							name: 'demo',
							publisher: 'acme',
							version: '1.0.0',
							displayName: 'Demo',
							sourceKind: 'user',
							manifestSha256,
							packageSha256: DIGEST,
							manifestJson,
						},
					],
				}),
			};
			using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi);
			await services.get(IExtensionService).start();
			using output =
				retirement === 'clear'
					? services.get(IOutputService).createChannel({
							id: 'terminal-environment-lifecycle',
							label: 'Terminal environment lifecycle',
						})
					: undefined;
			using bridge = output ? services.createInstance(MainThreadExtensionApi, CommandsRegistry, 1_000, output) : undefined;
			using host = retirement === 'disconnect' ? services.createInstance(AppServerExtensionHostService, CommandsRegistry, 1_000) : undefined;
			if (host) await host.start();
			else bridge!.update(api.current);
			const environment = services.get(IEnvironmentVariableService);
			await environment.refreshCollections();
			assert.equal(environment.collections.get('acme.demo')?.map.get('EXTENSION_VALUE')?.value, 'active');
			const reads = api.invocations.filter(request => request.operation === 'getTerminalEnvironment').length;
			assert.equal(reads, 1);

			if (host) api.emitConnection('stopped');
			else bridge!.clear();
			assert.equal(environment.collections.has('acme.demo'), false, 'Retirement removes the cached extension collection synchronously');
			await environment.refreshCollections();
			assert.equal(api.invocations.filter(request => request.operation === 'getTerminalEnvironment').length, reads, 'A future terminal launch cannot invoke the retired reader');
		});
});

suite('Extension terminal trusted runtime binding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('catalog arrival retries a rejected ready terminal profile at the same fleet generation', async () => {
		const api = new FakeExtensionHostApi(
			snapshot(1, 'acme.catalogReady', [
				{
					kind: 'terminalProfileProvider',
					registrationId: 'shell',
					profileId: 'shell',
					title: 'Followup Shell',
				},
			]),
		);
		let lists = 0;
		api.list = async () => {
			lists++;
			return api.current;
		};
		using languages = new LanguageFeaturesService();
		const manifestJson = JSON.stringify({
			name: 'demo',
			publisher: 'acme',
			version: '1.0.0',
			contributes: { terminal: { profiles: [{ id: 'shell', title: 'Followup Shell' }] } },
		});
		const descriptor = {
			id: 'acme.demo',
			name: 'demo',
			publisher: 'acme',
			version: '1.0.0',
			displayName: 'Demo',
			sourceKind: 'plugin' as const,
			manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`,
			packageSha256: `sha256:${'c'.repeat(64)}`,
			manifestJson,
		};
		let catalog: Awaited<ReturnType<IExtensionApi['list']>> = {
			generation: 1,
			diagnostics: [],
			extensions: [descriptor],
		};
		const extensionApi: IExtensionApi = {
			resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
			list: async () => catalog,
		};
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi);
		const commands = CommandsRegistry;
		using host = services.createInstance(AppServerExtensionHostService, commands, 1_000);
		const failures: string[] = [];
		using failed = host.onDidFail(failure => failures.push(failure.message));
		await host.start();
		assert.equal(host.state, 'failed');
		assert.ok(failures.some(message => message.includes('Followup Shell')));
		assert.equal(commands.hasCommand('acme.catalogReady'), false, 'An unattested profile must roll back the entire executable batch');
		const readsBeforeCatalog = lists;
		catalog = {
			generation: 2,
			diagnostics: [],
			extensions: [{ ...descriptor, runtimeBinding: { runtimeId: 'acme.demo', packageDigest: DIGEST } }],
		};
		await services.get(IExtensionService).reload();
		// No fleet notification or generation change: the declarative owner alone
		// supplies the attested identity that the earlier projection was missing.
		await waitFor(() => commands.hasCommand('acme.catalogReady'));
		assert.ok(lists > readsBeforeCatalog, 'Catalog publication retries through the existing list refresh');
		assert.equal(api.reconciles, 1, 'Catalog changes do not restart or reconcile the executable host');
		assert.equal(host.currentSnapshot.fleetGeneration, 1);
		assert.equal(host.state, 'ready');
		assert.ok(MenusRegistry.getMenuItems(MenuId.CommandPalette).some(item => 'command' in item && item.command.id === 'acme.catalogReady'));
		api.invocationResult = Promise.resolve({ options: null });
		await services.get(ITerminalProfileService).getContributedProfileProvider('acme.demo', 'shell')!.createContributedTerminalProfile({});
		assert.equal(api.invocations.at(-1)?.operation, 'createTerminalProfile');
		assert.equal(api.invocations.at(-1)?.activationGeneration, 11);
		assert.equal(api.invocations.at(-1)?.incarnation, 3);
	});

	for (const retirement of ['stop', 'disconnect', 'dispose'] as const)
		test(`catalog arrival does not refresh a ${retirement} host`, async () => {
			const api = new FakeExtensionHostApi(snapshot(1, 'acme.catalogLifecycle'));
			let lists = 0;
			api.list = async () => {
				lists++;
				return api.current;
			};
			using languages = new LanguageFeaturesService();
			using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
			const commands = CommandsRegistry;
			using host = services.createInstance(AppServerExtensionHostService, commands, 1_000);
			await host.start();
			if (retirement === 'stop') await host.stop();
			else if (retirement === 'disconnect') api.emitConnection('stopped');
			else host.dispose();
			const readsBeforeCatalog = lists;
			await services.get(IExtensionService).reload();
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.equal(lists, readsBeforeCatalog);
			assert.equal(commands.hasCommand('acme.catalogLifecycle'), false);
		});

	for (const scenario of [
		{
			name: 'accepts the admitted runtime across different digest domains',
			catalogDigest: `sha256:${'c'.repeat(64)}`,
			runtimeId: 'acme.demo',
			runtimeDigest: DIGEST,
			admitted: true,
		},
		{
			name: 'rejects a different runtime identity',
			catalogDigest: `sha256:${'c'.repeat(64)}`,
			runtimeId: 'other.runtime',
			runtimeDigest: DIGEST,
			admitted: false,
		},
		{
			name: 'rejects a different admitted runtime digest',
			catalogDigest: `sha256:${'c'.repeat(64)}`,
			runtimeId: 'acme.demo',
			runtimeDigest: `sha256:${'d'.repeat(64)}`,
			admitted: false,
		},
		{
			name: 'does not bypass a declared binding through a matching catalog digest',
			catalogDigest: DIGEST,
			runtimeId: 'other.runtime',
			runtimeDigest: DIGEST,
			admitted: false,
		},
	])
		test(scenario.name, async () => {
			const api = new FakeExtensionHostApi(
				snapshot(1, 'acme.run', [
					{ kind: 'terminalEnvironment', registrationId: 'environment' },
					{ kind: 'terminalCompletionProvider', registrationId: 'completion', triggerCharacters: ['-'] },
				]),
			);
			api.invocationResult = Promise.resolve({
				persistent: false,
				map: [['EXTENSION_VALUE', { type: 1, value: 'bound' }]],
			});
			using languages = new LanguageFeaturesService();
			const manifestJson = JSON.stringify({ name: 'demo', publisher: 'acme', version: '1.0.0' });
			const manifestSha256 = `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`;
			const extensionApi: IExtensionApi = {
				resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
				list: async () => ({
					generation: 1,
					diagnostics: [],
					extensions: [
						{
							id: 'acme.demo',
							name: 'demo',
							publisher: 'acme',
							version: '1.0.0',
							displayName: 'Demo',
							sourceKind: 'plugin',
							manifestSha256,
							packageSha256: scenario.catalogDigest,
							manifestJson,
							runtimeBinding: { runtimeId: scenario.runtimeId, packageDigest: scenario.runtimeDigest },
						},
					],
				}),
			};
			using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi);
			await services.get(IExtensionService).start();
			using output = services.get(IOutputService).createChannel({ id: 'terminal-runtime-binding', label: 'Terminal runtime binding' });
			using bridge = services.createInstance(MainThreadExtensionApi, CommandsRegistry, 1_000, output);
			if (scenario.admitted) bridge.update(api.current);
			else assert.throws(() => bridge.update(api.current), /Invalid terminal profile provider response/);
			const environment = services.get(IEnvironmentVariableService);
			await environment.refreshCollections();
			assert.equal(environment.collections.get('acme.demo')?.map.get('EXTENSION_VALUE')?.value, scenario.admitted ? 'bound' : undefined);
			assert.equal([...services.get(ITerminalCompletionService).providers].length, scenario.admitted ? 1 : 0);
			assert.equal(api.invocations.filter(request => request.operation === 'getTerminalEnvironment').length, scenario.admitted ? 1 : 0);
		});
});

suite('Extension terminal profile registration lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an issued PTY keeps its exact runtime fence after factory withdrawal and closes on connection retirement', async () => {
		class ResourceApi extends FakeExtensionHostApi {
			private nextPty = 0;
			override async invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
				signal.throwIfAborted();
				this.invocations.push(request);
				if (request.operation === 'createTerminalProfile')
					return (
						this.invocationResult ?? {
							options: { name: 'Issued PTY' },
							pty: {
								ptyId: `pty.${++this.nextPty}`,
								registrationId: `issued.${this.nextPty}`,
								acceptsInput: true,
							},
						}
					);
				assert.ok(/^issued\.[123]$/.test(request.registrationId));
				assert.equal(request.activationGeneration, 11);
				assert.equal(request.incarnation, 3);
				return { events: [] };
			}
		}
		const api = new ResourceApi(
			snapshot(1, 'acme.run', [
				{
					kind: 'terminalProfileProvider',
					registrationId: 'shell',
					profileId: 'shell',
					title: 'Extension Shell',
				},
			]),
		);
		using resources = new DisposableStore();
		const languages = resources.add(new LanguageFeaturesService());
		const manifestJson = JSON.stringify({
			name: 'demo',
			publisher: 'acme',
			version: '1.0.0',
			contributes: { terminal: { profiles: [{ id: 'shell', title: 'Extension Shell' }] } },
		});
		const manifestSha256 = `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`;
		const extensionApi: IExtensionApi = {
			resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
			list: async () => ({
				generation: 1,
				diagnostics: [],
				extensions: [
					{
						id: 'acme.demo',
						name: 'demo',
						publisher: 'acme',
						version: '1.0.0',
						displayName: 'Demo',
						sourceKind: 'user',
						manifestSha256,
						packageSha256: DIGEST,
						manifestJson,
					},
				],
			}),
		};
		const services = resources.add(createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi));
		let child: import('../../../../../platform/terminal/common/terminal.js').ITerminalChildProcess | undefined;
		let createPty: NonNullable<import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig['customPtyImplementation']> | undefined;
		const exits: (number | undefined)[] = [];
		Object.assign(services.get(ITerminalService), {
			onDidDisposeInstance: Event.None,
			createTerminal: async (options: import('../../../../contrib/terminal/browser/terminal.js').ITerminalCreateOptions) => {
				createPty = options.config!.customPtyImplementation!;
				child = resources.add(createPty(1, 80, 24));
				resources.add(child.onProcessExit(code => exits.push(code)));
				await child.start();
				return { instanceId: 1 };
			},
		});
		await services.get(IExtensionService).start();
		const host = resources.add(services.createInstance(AppServerExtensionHostService, CommandsRegistry, 1_000));
		await host.start();
		const profiles = services.get(ITerminalProfileService);
		await profiles.getContributedProfileProvider('acme.demo', 'shell')!.createContributedTerminalProfile({});
		api.current = snapshot(
			2,
			'acme.run',
			[
				{
					kind: 'terminalProfileProvider',
					registrationId: 'shell',
					profileId: 'shell',
					title: 'Extension Shell',
				},
				{ kind: 'terminalLinkProvider', registrationId: 'late-links' },
				{ kind: 'terminalPty', registrationId: 'issued.1' },
			],
			'',
			[],
			11,
		);
		api.emitChanged(2);
		await waitFor(() => host.currentSnapshot.fleetGeneration === 2);
		child!.shutdown(true);
		child = resources.add(createPty!(1, 80, 24));
		resources.add(child.onProcessExit(code => exits.push(code)));
		await child.start();
		assert.equal(api.invocations.filter(request => request.operation === 'createTerminalProfile').length, 2, 'Unrelated provider updates preserve the live factory for relaunch');
		const late = deferred<JsonValue>();
		api.invocationResult = late.promise;
		const cancelled = assert.rejects(profiles.getContributedProfileProvider('acme.demo', 'shell')!.createContributedTerminalProfile({}));
		await waitFor(() => api.invocations.filter(request => request.operation === 'createTerminalProfile').length === 3);
		api.current = snapshot(3, 'acme.run', [{ kind: 'terminalPty', registrationId: 'issued.2' }], '', [], 11);
		api.emitChanged(3);
		await waitFor(() => host.currentSnapshot.fleetGeneration === 3);
		await cancelled;
		late.resolve({
			options: { name: 'Late PTY' },
			pty: { ptyId: 'pty.3', registrationId: 'issued.3', acceptsInput: true },
		});
		await waitFor(() => api.invocations.some(request => request.operation === 'closeTaskTerminal' && request.registrationId === 'issued.3'));
		// Declarative profile metadata remains discoverable, but the retired
		// executable factory cannot create another terminal.
		await assert.rejects(profiles.getContributedProfileProvider('acme.demo', 'shell')!.createContributedTerminalProfile({}), /provider is unavailable/);
		await child!.input!('still owned by the terminal');
		assert.deepEqual(exits, [undefined]);
		assert.equal(api.invocations.at(-1)?.registrationId, 'issued.2');
		api.emitConnection('stopped');
		assert.deepEqual(exits, [undefined, undefined]);
		const count = api.invocations.length;
		await assert.rejects(async () => child!.input!('retired'));
		assert.equal(api.invocations.length, count);
	});

	test('commits the exact package provider into TerminalProfileService and retires it with the host', async () => {
		const api = new FakeExtensionHostApi(
			snapshot(1, 'acme.run', [
				{
					kind: 'terminalProfileProvider',
					registrationId: 'shell',
					profileId: 'shell',
					title: 'Extension Shell',
				},
			]),
		);
		api.invocationResult = Promise.resolve({ options: null });
		using languages = new LanguageFeaturesService();
		const manifestJson = JSON.stringify({
			name: 'demo',
			publisher: 'acme',
			version: '1.0.0',
			contributes: { terminalProfiles: [{ id: 'shell', title: 'Extension Shell', icon: 'terminal-git-bash' }] },
		});
		const manifestSha256 = `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`;
		const extensionApi: IExtensionApi = {
			resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
			list: async () => ({
				generation: 1,
				diagnostics: [],
				extensions: [
					{
						id: 'acme.demo',
						name: 'demo',
						publisher: 'acme',
						version: '1.0.0',
						displayName: 'Demo',
						sourceKind: 'user',
						manifestSha256,
						packageSha256: DIGEST,
						manifestJson,
					},
				],
			}),
		};
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi);
		const extensions = services.get(IExtensionService);
		await extensions.start();
		using host = services.createInstance(AppServerExtensionHostService, CommandsRegistry, 1_000);
		await host.start();
		const profiles = services.get(ITerminalProfileService);
		assert.equal(profiles.contributedProfiles.find(profile => profile.id === 'shell')?.options?.icon?.id, 'terminal-git-bash');
		await profiles.getContributedProfileProvider('acme.demo', 'shell')!.createContributedTerminalProfile({});
		assert.equal(api.invocations.at(-1)?.operation, 'createTerminalProfile');
		assert.equal(api.invocations.at(-1)?.registrationId, 'shell');
		api.emitConnection('stopped');
		await assert.rejects(profiles.getContributedProfileProvider('acme.demo', 'shell')!.createContributedTerminalProfile({}));
		assert.equal(api.invocations.length, 1);
	});
});

test('fleet notifications dynamically register, replace and unregister Speech through the production client owner', async () => {
	const api = new FakeExtensionHostApi(snapshot(1, 'acme.run', [], '', [], 11));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const speech = services.get(ISpeechService);
	assert.equal(speech.hasSpeechProvider, false);
	api.current = snapshot(2, 'acme.run', [{ kind: 'speechProvider', registrationId: 'late', identifier: 'acme.dynamic', registrationGeneration: 1 }], '', [], 11);
	api.emitChanged(2);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 2);
	assert.equal(speech.hasSpeechProvider, true);
	api.current = snapshot(
		3,
		'acme.run',
		[
			{
				kind: 'speechProvider',
				registrationId: 'replacement',
				identifier: 'acme.dynamic',
				registrationGeneration: 2,
			},
		],
		'',
		[],
		11,
	);
	api.emitChanged(3);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 3);
	assert.equal(speech.hasSpeechProvider, true);
	api.current = snapshot(4, 'acme.run', [], '', [], 11);
	api.emitChanged(4);
	await waitFor(() => host.currentSnapshot.fleetGeneration === 4);
	assert.equal(speech.hasSpeechProvider, false);
});

test('onSpeech activates the exact dormant provider and commits it through MainThreadSpeech', async () => {
	for (const event of ['onSpeech', 'onDemand:speechProvider']) {
		const api = new FakeExtensionHostApi(dormantSnapshot([event]));
		const ready = snapshot(2, 'acme.lazy', [], '', [], 11);
		api.activationResult = Promise.resolve({
			...ready,
			extensions: ready.extensions.map(runtime => ({
				...runtime,
				registrations: [
					{
						kind: 'speechProvider' as const,
						registrationGeneration: 1,
						registrationId: 'speech',
						identifier: 'acme.recognition',
					},
				],
			})),
		});
		using languages = new LanguageFeaturesService();
		using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>());
		using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
		await host.start();
		const speech = services.get(ISpeechService);
		assert.equal(speech.hasSpeechProvider, false);
		const extensions = services.get(IExtensionService);
		await extensions.activateByEvent('onDebug');
		assert.equal(api.activations.length, 0);
		await extensions.activateByEvent('onSpeech');
		assert.deepEqual(
			api.activations.map(({ initialization, ...request }) => request),
			[{ extensionId: 'acme.demo', activationGeneration: 11, event: { type: 'speech' } }],
		);
		assert.equal(speech.hasSpeechProvider, true);
		assert.equal(host.currentSnapshot.extensions[0]!.registrations[0]!.kind, 'speechProvider');
		await host.stop();
		assert.equal(speech.hasSpeechProvider, false);
	}
});

test('large extension outlines share one document budget and index snapshot lines once', async () => {
	using languages = new LanguageFeaturesService();
	using model = new TextModel('x\n'.repeat(100_000), { languageId: 'markdown' });
	const signal = new AbortController().signal;
	const base = createLanguageFeatureRequest(model, 'markdown', signal);
	let reads = 0;
	const request = {
		...base,
		snapshot: {
			...base.snapshot,
			getText: () => {
				reads++;
				return base.snapshot.getText();
			},
		},
	};
	const wireSymbol = (index: number) => ({
		name: `Section${index}`,
		kind: 2,
		range: { start: { lineIndex: index * 5, columnIndex: 0 }, end: { lineIndex: index * 5, columnIndex: 1 } },
		selectionRange: {
			start: { lineIndex: index * 5, columnIndex: 0 },
			end: { lineIndex: index * 5, columnIndex: 1 },
		},
	});
	let result: JsonValue = Array.from({ length: 20_000 }, (_, index) => wireSymbol(index));
	using registration = languages.registerProviderBatch(
		createExtensionHostLanguageProviderBatch(
			{
				kind: 'languageProvider',
				registrationId: 'outline',
				languageIds: ['markdown'],
				operations: ['documentSymbols'],
			},
			'markdown',
			'outline',
			async () => result,
		),
	);
	const provider = languages.documentSymbolProvider.ordered(model)[0]!;
	const symbols = await provider.provideDocumentSymbols(request, signal);
	assert.equal(symbols.length, 20_000);
	assert.equal(symbols.at(-1)?.name, 'Section19999');
	assert.ok(reads <= 2, `document text materialized ${reads} times`);
	result = Array(50_001).fill(wireSymbol(0));
	await assert.rejects(async () => provider.provideDocumentSymbols(request, signal), /Extension symbols/);
	result = [
		{ ...wireSymbol(0), children: Array(30_000).fill(wireSymbol(0)) },
		{ ...wireSymbol(1), children: Array(30_000).fill(wireSymbol(0)) },
	];
	await assert.rejects(async () => provider.provideDocumentSymbols(request, signal), /Extension symbols/);
	result = [
		{
			...wireSymbol(0),
			selectionRange: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } },
		},
	];
	await assert.rejects(async () => provider.provideDocumentSymbols(request, signal), /outside the document snapshot/);
});

test('terminal completion and quick fix registrations bind the original instance, ranges and cancellation', async () => {
	const api = new FakeExtensionHostApi(
		snapshot(1, 'acme.terminal', [
			{ kind: 'terminalCompletionProvider', registrationId: 'completion', triggerCharacters: ['-'] },
			{ kind: 'terminalQuickFixProvider', registrationId: 'fix', providerId: 'acme.fix' },
		]),
	);
	using languages = new LanguageFeaturesService();
	const manifestJson = JSON.stringify({ name: 'demo', publisher: 'acme', version: '1.0.0' });
	const extensionApi: IExtensionApi = {
		resources: new ExtensionResourceLoaderService(async () => assert.fail('Unexpected extension resource request')),
		list: async () => ({
			generation: 1,
			diagnostics: [],
			extensions: [
				{
					id: 'acme.demo',
					name: 'demo',
					publisher: 'acme',
					version: '1.0.0',
					displayName: 'Demo',
					sourceKind: 'user',
					manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`,
					packageSha256: DIGEST,
					manifestJson,
				},
			],
		}),
	};
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, undefined, extensionApi);
	await services.get(IExtensionService).start();
	using stateChanged = new Emitter<import('../../../../contrib/terminal/browser/terminal.js').TerminalInstanceState>();
	using removed = new Emitter<import('../../../../contrib/terminal/browser/terminal.js').ITerminalInstance>();
	const instance = {
		id: 'terminal-1',
		title: 'Shell',
		processId: 42,
		state: 'running',
		onDidChangeState: stateChanged.event,
	} as import('../../../../contrib/terminal/browser/terminal.js').ITerminalInstance;
	Object.assign(services.get(ITerminalService), { instances: [instance], onDidDisposeInstance: removed.event });
	using host = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await host.start();
	const completions = services.get(ITerminalCompletionService);
	const source = new AbortController();
	api.invocationResult = Promise.resolve({ items: [{ label: '--help', replacementRange: [4, 5], detail: 'Help' }] });
	assert.deepEqual(
		(await completions.provideCompletions(instance, 'git -', 5, source.signal)).map(({ isValid, ...item }) => item),
		[{ label: '--help', replacementRange: [4, 5], detail: 'Help' }],
	);
	assert.deepEqual(api.invocations.at(-1)?.payload, {
		commandLine: 'git -',
		cursorIndex: 5,
		terminal: { id: 'terminal-1', name: 'Shell', processId: 42 },
	});
	assert.equal(api.invocations.at(-1)?.operation, 'provideTerminalCompletions');
	assert.deepEqual(await completions.provideCompletions(instance, 'git -', 5, source.signal, '/'), []);
	assert.equal(api.invocations.length, 1);
	api.invocationResult = Promise.resolve({ items: [{ label: 'bad', replacementRange: [0, 6] }] });
	assert.deepEqual(await completions.provideCompletions(instance, 'git -', 5, source.signal), []);
	api.terminalQuickFixMatcher = { matches: true, outputMatcher: { anchor: 'bottom', offset: 42, length: 2 } };
	const command = {
		command: 'tool bad',
		exitCode: 1,
		getOutputMatch: (matcher: { offset: number; length: number; anchor: string }) => {
			assert.equal(matcher.offset, 42);
			assert.equal(matcher.length, 2);
			assert.equal(matcher.anchor, 'bottom');
			return { regexMatch: [''], outputLines: ['failed', 'try good'] };
		},
	} as unknown as import('../../../../../platform/terminal/common/capabilities/capabilities.js').ITerminalCommand;
	const quickFixes = services.get(ITerminalQuickFixService);
	api.invocationResult = Promise.resolve<JsonValue>({
		fixes: [
			{ kind: 'terminalCommand', label: 'tool good', shouldExecute: true },
			{ kind: 'opener', label: 'https://example.com/help' },
			{ kind: 'command', label: 'Explain', id: 'opaque-1' },
		],
	});
	const fixes = await quickFixes.provideTerminalQuickFixes(instance, command, source.signal);
	assert.equal(fixes.length, 3);
	const { isValid, ...commandFix } = fixes[0]!;
	assert.equal(isValid?.(), true);
	assert.deepEqual(commandFix, { label: 'tool good', terminalCommand: 'tool good', shouldExecute: true });
	assert.equal(fixes[1]?.uri?.toString(), 'https://example.com/help');
	assert.deepEqual(api.invocations.at(-1)?.payload, {
		commandLine: 'tool bad',
		exitCode: 1,
		outputLines: ['failed', 'try good'],
		terminalId: 'terminal-1',
		phase: 'provide',
	});
	api.invocationResult = Promise.resolve(null);
	await fixes[2]!.run!();
	assert.equal(api.invocations.at(-1)?.operation, 'handleTerminalQuickFix');
	assert.deepEqual(api.invocations.at(-1)?.payload, {
		id: 'opaque-1',
		terminalId: 'terminal-1',
		commandLine: 'tool bad',
	});
	const pending = deferred<JsonValue>();
	api.invocationResult = pending.promise;
	const reading = completions.provideCompletions(instance, 'pending', 7, source.signal);
	const signal = api.invocationSignals.at(-1)!;
	stateChanged.fire('reconnecting');
	assert.equal(signal.aborted, true);
	pending.resolve({ items: [{ label: 'late', replacementRange: [0, 7] }] });
	assert.deepEqual(await reading, []);
	api.emitConnection('stopped');
	assert.deepEqual(await completions.provideCompletions(instance, 'git -', 5, source.signal), []);
	assert.deepEqual(await quickFixes.provideTerminalQuickFixes(instance, command, source.signal), []);
	const count = api.invocations.length;
	await fixes[2]!.run!();
	assert.equal(api.invocations.length, count);
});

test('saved Remote resolver starts on demand and retains its first resolution through ready publication', async () => {
	const api = new FakeExtensionHostApi(dormantSnapshot(['onResolveRemoteAuthority:team']));
	using languages = new LanguageFeaturesService();
	using services = createServices(api, languages, new ProviderSink<TaskProvider>(), new ProviderSink<TestProfileProvider>(), undefined, undefined, {
		confirm: async () => ({ confirmed: true }),
		connections: {
			...UnavailableRemoteConnectionApi,
			available: true,
			list: async () => [{ name: 'build', host: 'build-linux', workspace: '/srv/project' }],
		},
	});
	using service = services.createInstance(AppServerExtensionHostService, new CommandRegistry(), 1_000);
	await service.start();
	assert.equal(api.activations.length, 0);
	const activation = deferred<ExtensionHostFleetSnapshot>();
	api.activationResult = activation.promise;
	const resolving = services.get(IRemoteConnectionService).resolveConnection('team+build', new AbortController().signal);
	await waitFor(() => api.activations.length === 1);
	api.current = {
		...api.current,
		generation: 2,
		extensions: api.current.extensions.map(runtime => ({ ...runtime, lifecycle: 'starting', incarnation: 11 })),
	};
	api.emitChanged(2);
	await waitFor(() => service.currentSnapshot.extensions[0]?.state === 'starting');
	api.current = snapshot(3, 'acme.lazy', [{ kind: 'remoteConnectionResolver', registrationId: 'remote:team', authorityPrefix: 'team' }], '', [], 11);
	api.emitChanged(3);
	await waitFor(() => service.currentSnapshot.extensions[0]?.state === 'ready');
	activation.resolve(api.current);
	assert.deepEqual(await resolving, { name: 'build', host: 'build-linux', workspace: '/srv/project' });
	assert.deepEqual(api.activations[0]!.event, { type: 'resolveAuthority', authorityPrefix: 'team' });
	await services.get(IRemoteConnectionService).resolveConnection('team+build', new AbortController().signal);
	assert.equal(api.activations.length, 1);
});
