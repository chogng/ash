import { MergedEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariableCollection.js';
import { IEnvironmentVariableService } from '../../../../contrib/terminal/common/environmentVariable.js';
import { ITerminalContributionService, ITerminalProfileResolverService, ITerminalProfileService } from '../../../terminal/common/terminal.js';
import { TerminalProfileService } from '../../../../contrib/terminal/browser/terminalProfileService.js';
import { BrowserTerminalProfileResolverService } from '../../../../contrib/terminal/browser/terminalProfileResolverService.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import type { IDebugSession } from '../../common/debugService.js';
import { IEditorService } from '../../../editor/common/editorService.js';
import { IEditorGroupsService } from '../../../editor/common/editorGroupsService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { registerTestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../configuration/test/common/testServices.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { BrowserPathService } from '../../../path/browser/pathService.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { ConfigurationResolverService } from '../../../configurationResolver/browser/configurationResolverService.js';
import { IConfigurationResolverService } from '../../../configurationResolver/common/configurationResolver.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalService } from '../../../../contrib/terminal/browser/terminalService.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDebugAdapterProcessService } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { DebugService } from '../../../../contrib/debug/browser/debugService.js';
import { DebugAdapterFactoryRegistry, IDebugAdapterFactorySource } from '../../common/debugAdapterFactory.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';

test('DAP runInTerminal creates an integrated PowerShell terminal with quoted arguments', async () => {
	const writes: string[] = [];
	const environments: unknown[] = [];
	const terminals = {
		getProfiles: async () => [{ profileId: 'powershell', title: 'PowerShell', isDefault: true }],
		createTerminal: async (options: import('../../../terminal/browser/terminal.js').ITerminalCreateOptions) => { environments.push(options.env); return { state: 'running', processId: 1234, sendText: async (value: string, shouldExecute: boolean) => { writes.push(value + (shouldExecute ? '\r' : '')); } }; },
	} as unknown as ITerminalService;
	const response = await launchWithTerminalRequest(terminals, { kind: 'integrated', title: 'Debug app', cwd: 'C:\\work tree', args: ['C:\\bin\\app.exe', 'a b', "don't"], env: { MODE: 'debug value', REMOVE_ME: null } });

	assert.equal(response.success, true);
	assert.deepEqual(response.body, { shellProcessId: 1234 });
	assert.deepEqual(environments, [{ MODE: 'debug value', REMOVE_ME: null }]);
	assert.deepEqual(writes, ["Set-Location -LiteralPath 'C:\\work tree'; & 'C:\\bin\\app.exe' 'a b' 'don''t'\r"]);
});

test('DAP runInTerminal rejects external terminals before acquiring a profile', async () => {
	const terminals = { getProfiles: async () => { throw new Error('must not run'); } } as unknown as ITerminalService;
	const response = await launchWithTerminalRequest(terminals, { kind: 'external', args: ['app'] });
	assert.equal(response.success, false);
	assert.match(String(response.message), /External debug terminals are not supported/);
});

suite('DAP terminal availability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const outcome of ['acknowledge', 'reject', 'close'] as const) {
		test(`runInTerminal waits for process input and handles ${outcome}`, async () => {
			using resources = new DisposableStore();
			const acknowledgement = new DeferredPromise<void>();
			const submitted = new DeferredPromise<void>();
			const calls: string[] = [];
			const processes: ITerminalProcessService = {
				operatingSystem: OperatingSystem.Linux,
				resolveProfile: resolveTerminalProfile,
				getConnectionState: async () => 'ready', onConnectionState: Event.None,
				getProcessInfo: async () => ({ ready: { pid: 42, cwd: '/workspace' }, cwd: '/workspace', rows: 24, cols: 80 }),
				getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
				create: async () => ({ ready: { pid: 1234, cwd: '/workspace' }, terminalId: 'debug-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' }),
				read: async () => ({ terminalId: 'debug-process', commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
				write: async () => { calls.push('write'); void submitted.complete(undefined); await acknowledgement.p; },
				resize: async () => { }, close: async () => { calls.push('close'); },
			};
			const workspace = resources.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
			const services = resources.add(new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
			const terminals = resources.add(services.createInstance(TerminalService));
			let finished = false;
			const pending = launchWithTerminalRequest(terminals, { kind: 'integrated', args: ['app'] }, { terminalProcesses: processes }).then(response => { finished = true; return response; });
			await submitted.p;
			assert.equal(finished, false);
			if (outcome === 'acknowledge') void acknowledgement.complete(undefined);
			else if (outcome === 'reject') void acknowledgement.error(new Error('debug input rejected'));
			else await terminals.closeTerminal(terminals.activeInstance!);
			const response = await pending;
			assert.deepEqual({ success: response.success, calls, instances: terminals.instances.length }, {
				success: outcome === 'acknowledge', calls: outcome === 'acknowledge' ? ['write'] : ['write', 'close'], instances: outcome === 'acknowledge' ? 1 : 0,
			});
			if (outcome === 'reject') assert.equal(response.message, 'debug input rejected');
			if (outcome === 'close') void acknowledgement.complete(undefined);
		});
	}

	for (const persistence of ['connectionOwned', 'reconnectable'] as const) {
		test(`fails the reverse request when its ${persistence} terminal cannot accept commands`, async () => {
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization(persistence === 'reconnectable' ? 'zh-CN' : 'en');
			using resources = new DisposableStore();
			const calls: string[] = [];
			const processes: ITerminalProcessService = {
				operatingSystem: OperatingSystem.Linux,
				resolveProfile: resolveTerminalProfile,
				getConnectionState: async () => 'crashed',
				onConnectionState: () => Disposable.None,
				getProcessInfo: async () => ({ ready: { pid: 42, cwd: '/workspace' }, cwd: '/workspace', rows: 24, cols: 80 }),
				getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
				create: async () => ({ ready: { pid: 1234, cwd: '/backend/workspace' }, terminalId: 'debug-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: persistence }),
				read: async () => { throw new Error('Disconnected terminal must not poll'); },
				write: async () => { calls.push('write'); },
				resize: async () => { },
				close: async options => { calls.push(`close:${options.terminalId}`); },
			};
			const workspace = resources.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
			const services = resources.add(new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
			const terminals = resources.add(services.createInstance(TerminalService));
			const response = await launchWithTerminalRequest(terminals, { kind: 'integrated', args: ['app'] }, { terminalProcesses: processes });
			assert.deepEqual({ success: response.success, message: response.message, calls, terminals: terminals.instances }, {
				success: false,
				message: persistence === 'reconnectable' ? '终端不可用，调试命令尚未执行。请重新启动调试。' : 'The terminal is unavailable. The debug command was not sent. Restart debugging.',
				calls: ['close:debug-process'],
				terminals: [],
			});
		});
	}
});

suite('DAP terminal launch policies through execution owners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function assemble(owner: DisposableStore, os: OperatingSystem = OperatingSystem.Linux) {
		const connection = owner.add(new Emitter<import('../../../../../platform/terminal/common/terminal.js').TerminalProcessConnectionState>());
		const workspace = owner.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
		const configuration = owner.add(new WorkbenchConfigurationService());
		const created: import('../../../../../platform/terminal/common/terminal.js').ITerminalProcessCreateOptions[] = [];
		const writes: string[] = [];
		const closes: string[] = [];
		const disposed = new DeferredPromise<void>();
		const processes: ITerminalProcessService = {
			operatingSystem: os, onConnectionState: connection.event, getConnectionState: async () => 'ready',
			getProcessInfo: async () => ({ ready: { pid: 42, cwd: '/workspace' }, cwd: '/workspace', rows: 24, cols: 80 }),
			getEnvironment: async () => ({ HOME: '/execution/home', SOURCE: 'execution value' }),
			listProfiles: async () => [{ profileId: 'bash', title: 'Bash', isDefault: true }, { profileId: 'powershell', title: 'PowerShell', isDefault: false }],
			resolveProfile: resolveTerminalProfile,
			create: async options => {
				created.push(options);
				return { ready: { pid: 321, cwd: options.cwd ?? '/workspace' }, terminalId: 'debug-process', profile: (await resolveTerminalProfile(options.profile)).profile, connectionPersistence: 'connectionOwned' };
			},
			read: async () => ({ terminalId: 'debug-process', chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, commandEventGap: false, outputGap: false, exited: false, exitCode: undefined }),
			write: async options => { writes.push(typeof options.data === 'string' ? options.data : new TextDecoder().decode(options.data)); },
			resize: async () => { }, close: async options => { closes.push(options.terminalId); },
		};
		const services = owner.add(new InstantiationService(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
		const terminals = owner.add(services.createInstance(TerminalService));
		const disposalListener = owner.add(terminals.onDidDisposeInstance(() => {
			disposalListener.dispose();
			void disposed.complete(undefined);
		}));
		return { processes, terminals, configuration, created, writes, closes, workspace, connection, disposed };
	}

	for (const { os, platform, path, args, command } of [
		{ os: OperatingSystem.Linux, platform: 'linux', path: '/automation/bash', args: ['-l'], command: "'/tools/app' 'two words' 'don'\"'\"'t'\r" },
		{ os: OperatingSystem.Macintosh, platform: 'osx', path: '/automation/zsh', args: ['-l'], command: "'/tools/app' 'two words' 'don'\"'\"'t'\r" },
		{ os: OperatingSystem.Windows, platform: 'windows', path: 'C:\\tools\\pwsh.exe', args: ['-NoLogo'], command: "& '/tools/app' 'two words' 'don''t'\r" },
		{ os: OperatingSystem.Windows, platform: 'windows', path: 'C:\\tools\\pwsh.exe', args: '-NoLogo -NoProfile', command: "& '/tools/app' 'two words' 'don''t'\r" },
	]) {
		test(`automation profile on ${platform} with ${typeof args} arguments reaches PTY creation and preserves DAP literal environment`, async () => {
			using owner = new DisposableStore();
			const fixture = assemble(owner, os);
			await fixture.configuration.updateValue(`terminal.integrated.automationProfile.${platform}`, { path, args, env: { MODE: 'profile', PROFILE: '${env:SOURCE}', REMOVED: 'profile' } });
			await fixture.configuration.updateValue(`terminal.integrated.env.${platform}`, { MODE: 'global', GLOBAL: '${env:HOME}' });
			const response = await launchWithTerminalRequest(fixture.terminals, { args: ['/tools/app', 'two words', "don't"], env: { mode: 'adapter', REMOVED: null, LITERAL: '${env:HOME}' } }, { terminalProcesses: fixture.processes, configuration: fixture.configuration, workspace: fixture.workspace });
			assert.deepEqual({ success: response.success, body: response.body, profile: fixture.created[0].profile, env: fixture.created[0].env, writes: fixture.writes }, {
				success: true, body: { shellProcessId: 321 }, profile: { type: 'custom', name: 'Automation shell', path: [path], args },
				env: os === OperatingSystem.Windows ? { MODE: 'adapter', GLOBAL: '/execution/home', PROFILE: 'execution value', REMOVED: null, LITERAL: '${env:HOME}' } : { MODE: 'profile', GLOBAL: '/execution/home', PROFILE: 'execution value', REMOVED: null, mode: 'adapter', LITERAL: '${env:HOME}' },
				writes: [command],
			});
			await fixture.terminals.closeTerminal(fixture.terminals.activeInstance!);
		});
	}

	test('a custom default cmd profile supplies quoting, literal DAP cwd and a localized default title', async () => {
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		using owner = new DisposableStore();
		const fixture = assemble(owner, OperatingSystem.Windows);
		await fixture.configuration.updateValue('terminal.integrated.profiles.windows', { 'Build shell': { path: 'C:\\tools\\cmd.exe', args: ['/d'] } });
		await fixture.configuration.updateValue('terminal.integrated.defaultProfile.windows', 'Build shell');
		const response = await launchWithTerminalRequest(fixture.terminals, { cwd: 'C:\\workspace\\${workspaceFolder}\\literal directory', args: ['tool.exe', 'two words'] }, { terminalProcesses: fixture.processes, configuration: fixture.configuration, workspace: fixture.workspace });
		assert.deepEqual({ success: response.success, title: fixture.terminals.activeInstance?.title, profile: fixture.created[0].profile, cwd: fixture.created[0].cwd, writes: fixture.writes }, {
			success: true, title: '调试', profile: { type: 'custom', name: 'Build shell', path: ['C:\\tools\\cmd.exe'], args: ['/d'] }, cwd: 'C:\\workspace\\${workspaceFolder}\\literal directory', writes: ['cd /d "C:\\workspace\\${workspaceFolder}\\literal directory" && "tool.exe" "two words"\r'],
		});
		await fixture.terminals.closeTerminal(fixture.terminals.activeInstance!);
	});

	test('an empty automation profile uses the interactive default and retains raw shell interpretation', async () => {
		using owner = new DisposableStore();
		const fixture = assemble(owner);
		const response = await launchWithTerminalRequest(fixture.terminals, { args: ['echo', '$MODE', '&&', 'echo', 'done'], argsCanBeInterpretedByShell: true }, { terminalProcesses: fixture.processes, configuration: fixture.configuration, workspace: fixture.workspace });
		assert.deepEqual({ success: response.success, profile: fixture.created[0].profile, writes: fixture.writes }, { success: true, profile: { type: 'custom', name: 'Bash', path: ['/bin/bash'], args: [] }, writes: ['echo $MODE && echo done\r'] });
		await fixture.terminals.closeTerminal(fixture.terminals.activeInstance!);
	});

	test('profile resolution failure answers DAP without creating a terminal or sending input', async () => {
		using owner = new DisposableStore();
		const fixture = assemble(owner);
		fixture.processes.resolveProfile = async () => { throw new Error('Executable unavailable'); };
		const response = await launchWithTerminalRequest(fixture.terminals, { args: ['tool'] }, { terminalProcesses: fixture.processes, configuration: fixture.configuration, workspace: fixture.workspace });
		assert.deepEqual({ success: response.success, message: response.message, created: fixture.created, writes: fixture.writes }, { success: false, message: 'Executable unavailable', created: [], writes: [] });
	});

	for (const phase of ['resolution', 'creation'] as const) {
		for (const invalidation of ['connection', 'workspace', 'stop'] as const) {
			test(`${invalidation} during ${phase} prevents DAP input and releases a late PTY`, async () => {
				using owner = new DisposableStore();
				const fixture = assemble(owner);
				const entered = new DeferredPromise<void>();
				const release = new DeferredPromise<void>();
				if (phase === 'resolution') fixture.processes.resolveProfile = async selection => { await entered.complete(undefined); await release.p; return resolveTerminalProfile(selection); };
				else {
					const create = fixture.processes.create;
					fixture.processes.create = async options => { await entered.complete(undefined); await release.p; return create(options); };
				}
				const operation = launchWithTerminalRequest(fixture.terminals, { args: ['tool'] }, {
					terminalProcesses: fixture.processes, configuration: fixture.configuration, workspace: fixture.workspace,
					onReady: async (debug, session) => {
						await entered.p;
						if (invalidation === 'connection') fixture.connection.fire('crashed');
						if (invalidation === 'workspace') fixture.workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
						if (invalidation === 'stop') await debug.stop(session);
						await release.complete(undefined);
					},
				});
				if (invalidation === 'stop') await assert.rejects(operation, isCancellationError);
				else {
					// Workspace retirement may close the adapter before it can receive
					// a failure response; neither ordering may publish success or stdin.
					const response = await operation.catch(error => { assert.ok(isCancellationError(error)); return undefined; });
					if (response) assert.equal(response.success, false);
				}
				if (phase === 'creation') await fixture.disposed.p;
				assert.deepEqual({ writes: fixture.writes, closes: fixture.closes, instances: fixture.terminals.instances.length }, { writes: [], closes: phase === 'creation' ? ['debug-process'] : [], instances: 0 });
			});
		}
	}
});

async function launchWithTerminalRequest(terminals: ITerminalService, argumentsValue: unknown, options: { terminalProcesses?: ITerminalProcessService; configuration?: IConfigurationService; workspace?: WorkspaceContextService; onReady?: (service: DebugService, session: IDebugSession) => Promise<void>; } = {}): Promise<Record<string, unknown>> {
	using resources = new DisposableStore();
	const adapters = resources.add(new DebugAdapterFactoryRegistry());
	let resolveResponse!: (response: Record<string, unknown>) => void;
	const response = new Promise<Record<string, unknown>>(resolve => { resolveResponse = resolve; });
	const messages: Array<{ sequence: number; message: unknown; }> = [];
	const transportClosed = new DeferredPromise<void>();
	const enqueue = (message: unknown): void => { messages.push({ sequence: messages.length, message }); };
	const processes: IDebugAdapterProcessService = {
		onConnectionState: () => Event.None(() => { }),
		getConnectionState: async () => 'ready',
		start: async () => 'adapter-process',
		send: async (_id, value) => {
			const message = value as Record<string, unknown>;
			if (message.type === 'response') { resolveResponse(message); return; }
			if (message.command === 'launch') {
				enqueue({ seq: 100, type: 'event', event: 'initialized' });
				enqueue({ seq: 101, type: 'request', command: 'runInTerminal', arguments: argumentsValue });
			}
			enqueue({ seq: 102, type: 'response', request_seq: message.seq, command: message.command, success: true, body: {} });
		},
		read: async (_id, afterSequence, maxMessages) => ({ messages: messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages), nextSequence: messages.length, outputGap: false, stderr: '', exited: false, exitCode: null, protocolError: null }),
		close: async () => { await transportClosed.complete(undefined); },
	};
	const browser = new JSDOM('', { url: 'https://ash.test' });
	resources.add(toDisposable(() => browser.window.close()));
	const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	const workspace = options.workspace ?? resources.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
	const unexpectedProcess = async (): Promise<never> => { throw new Error('Fake terminal must not access a PTY'); };
	const terminalProcesses: ITerminalProcessService = options.terminalProcesses ?? {
		operatingSystem: OperatingSystem.Linux, onConnectionState: Event.None, getConnectionState: async () => 'ready',
		getProcessInfo: async () => ({ ready: { pid: 42, cwd: '/workspace' }, cwd: '/workspace', rows: 24, cols: 80 }),
		getEnvironment: async () => ({}), listProfiles: () => terminals.getProfiles(), resolveProfile: resolveTerminalProfile,
		create: unexpectedProcess, write: unexpectedProcess, resize: unexpectedProcess, read: unexpectedProcess, close: unexpectedProcess,
	};
	const services = resources.add(new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, options.configuration ?? new SyncDescriptor(WorkbenchConfigurationService)],
		[IFileService, new SyncDescriptor(FileService)],
		[IUriIdentityService, new SyncDescriptor(UriIdentityService)],
		[ITerminalProcessService, terminalProcesses], [IWorkspaceContextService, workspace], [IConfigurationResolverService, new SyncDescriptor(ConfigurationResolverService)],
		[IStorageService, storage],
		[IDebugAdapterProcessService, processes],
		[ITerminalService, terminals],
		[ITaskService, {} as ITaskService],
		[IDebugAdapterFactorySource, adapters],
		[ILogService, new NullLoggerService()],
	)));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	registerTestExtensionService(resources, services);
	if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
	if (!services.has(IEditorGroupsService)) services.registerInstance(IEditorGroupsService, {} as IEditorGroupsService);
	services.registerInstance(ITerminalContributionService, { terminalProfiles: [], onDidChangeTerminalProfiles: Event.None, ...Disposable.None });
	services.registerSingleton(ITerminalProfileService, () => services.createInstance(TerminalProfileService));
	services.registerInstance(IEnvironmentVariableService, { collections: new Map(), mergedCollection: new MergedEnvironmentVariableCollection(new Map()), onDidChangeCollections: Event.None, refreshCollections: async () => { }, set: () => { }, delete: () => { }, registerCollectionProvider: () => Disposable.None });
	services.registerSingleton(ITerminalProfileResolverService, () => services.createInstance(BrowserTerminalProfileResolverService));
	using service = services.createInstance(DebugService);
	const session = await service.startDebugging({ id: 'debug-terminal', name: 'Terminal request', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: { cwd: URI.file('/workspace').fsPath } });
	try {
		await options.onReady?.(service, session);
		return await Promise.race([response, transportClosed.p.then(() => { throw new CancellationError(); })]);
	}
	finally { await service.stop(session); }
}

async function resolveTerminalProfile(selection: import('../../../../../platform/terminal/common/terminal.js').TerminalProcessProfileSelection) {
	const profileId = selection.type === 'profile' ? selection.profileId : selection.type === 'custom' ? `custom:${selection.name}` : 'shell';
	return {
		profile: { profileId, title: selection.type === 'custom' ? selection.name : profileId, isDefault: selection.type === 'default' },
		executable: selection.type === 'custom' ? selection.path[0]! : /powershell|pwsh/.test(profileId) ? `/tools/${profileId}.exe` : `/bin/${profileId === 'shell' ? 'sh' : profileId}`,
		args: selection.type === 'custom' ? (typeof selection.args === 'string' ? selection.args : [...selection.args]) : [],
	};
}
