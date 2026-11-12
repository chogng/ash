import { languagePackCatalog as chineseCatalog } from '../../../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { ISandboxGlobals } from '../../../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { commandActionLabel } from '../../../../../../platform/action/common/action.js';
import { MenuId, MenusRegistry } from '../../../../../../platform/actions/common/actions.js';
import { IAppServerApi, type AppServerConnectionState } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { LOCAL_APP_SERVER_DIAGNOSTICS_CHANNEL, LOCAL_APP_SERVER_RESTART_CHANNEL } from '../../../../../../platform/agentHost/common/appServerTransport.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../../../platform/native/common/nativeHost.js';
import { INetworkDiagnosticsService, type NetworkDiagnostics } from '../../../../../../platform/networkDiagnostics/common/networkDiagnosticsService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { INativeHostService } from '../../../../../common/services.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { IUntitledTextEditorService, type IExistingUntitledTextEditorOptions } from '../../../../../services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../../../services/untitled/common/untitledTextEditorInput.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';

const storageCommand = 'workbench.action.chat.openStorageFolder';
const networkCommand = 'workbench.action.chat.agentHostNetworkDiagnostics';
const restartCommand = 'workbench.action.chat.restartLocalAgentHost';
const debugCommand = 'workbench.action.chat.debugAgentHostInDevTools';
const startProfileCommand = 'workbench.action.chat.profileAgentHost';
const stopProfileCommand = 'workbench.action.chat.stopAgentHostProfile';
const diagnostics: NetworkDiagnostics = {
	network: { revision: 1, httpMode: 'http2', targets: [] },
	checks: [{ connection: 'model', targetId: null, outcome: { type: 'failed', failure: 'tls' } }],
};

function fixture(services: InstantiationService, profile: URI, remoteAuthority?: string) {
	const state = { disabled: false, generation: 1, connection: 'ready' as AppServerConnectionState };
	const paths: string[] = [];
	const reports: IExistingUntitledTextEditorOptions[] = [];
	const opened: unknown[] = [];
	const notifications: unknown[] = [];
	let networkCalls = 0;
	let probe = async () => diagnostics;
	services.registerInstance(IConfigurationService, { getValue: () => state.disabled } as unknown as IConfigurationService);
	services.registerInstance(IWorkbenchEnvironmentService, { userRoamingDataHome: profile } as IWorkbenchEnvironmentService);
	services.registerInstance(IWorkspaceContextService, {
		getWorkspace: () => ({ id: 'workspace', folders: [], remoteAuthority }),
	} as unknown as IWorkspaceContextService);
	services.registerInstance(INativeHostService, { revealFile: async (path: string) => { paths.push(path); } } as INativeHostApi);
	services.registerInstance(INotificationService, { info: (message: unknown) => { notifications.push(message); } } as unknown as INotificationService);
	services.registerInstance(IAppServerApi, {
		get connectionGeneration() { return state.generation; },
		getConnectionState: async () => state.connection,
	} as IAppServerApi);
	services.registerInstance(INetworkDiagnosticsService, {
		run: async () => { networkCalls++; return probe(); },
	} as INetworkDiagnosticsService);
	services.registerInstance(IUntitledTextEditorService, {
		create: (options: IExistingUntitledTextEditorOptions) => {
			reports.push(options);
			return { resource: URI.parse('untitled:/diagnostics'), initialValue: options.initialValue, getLanguageId: () => options.languageId };
		},
	} as unknown as IUntitledTextEditorService);
	services.registerInstance(IEditorService, {
		openEditor: async (input: UntitledTextEditorInput, options: unknown) => {
			opened.push({ resource: input.resource.toString(), options });
			input.dispose();
		},
	} as unknown as IEditorService);
	return {
		state, paths, reports, opened, notifications,
		get networkCalls() { return networkCalls; },
		probeWith: (run: () => Promise<NetworkDiagnostics>) => { probe = run; },
		run: async (id: string) => { await services.invokeFunction(CommandsRegistry.getCommand(id)!); },
	};
}

suite('Desktop Chat developer commands', () => {
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const ipcCalls: unknown[] = [];
	suiteSetup(async () => {
		const globals: ISandboxGlobals = {
			ipcRenderer: {
				send: () => assert.fail('The restart action must invoke IPC'),
				on: () => assert.fail('The restart action must not subscribe to IPC'),
				invoke: async (channel, params) => { ipcCalls.push([channel, params]); },
			},
			ipcMessagePort: { acquire: () => assert.fail('The restart action must not acquire a carrier') },
			process: { platform: process.platform, arch: process.arch, isBuilt: false },
			webUtils: { getPathForFile: () => '' },
		};
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		const { registerChatDeveloperActions } = await import('../../../electron-browser/actions/chatDeveloperActions.js');
		setNlsMessages('zh-CN', chineseCatalog.bundles);
		try {
			registerChatDeveloperActions();
		} finally {
			resetNlsResolver();
		}
	});
	suiteTeardown(() => {
		if (previousGlobals) {
			Object.defineProperty(globalThis, 'ash', previousGlobals);
		} else {
			Reflect.deleteProperty(globalThis, 'ash');
		}
	});

	test('registers localized, Chat-gated Command Palette entries', () => {
		const ids = [storageCommand, restartCommand, debugCommand, startProfileCommand, stopProfileCommand, networkCommand];
		const commands = MenusRegistry.getMenuItems(MenuId.CommandPalette).flatMap(item =>
			'command' in item && ids.includes(item.command.id) ? [item.command] : []);
		assert.deepEqual(commands.map(command => commandActionLabel(command.title)), [
			'打开本地聊天存储文件夹', '重启本地 App Server', '调试本地 App Server',
			'开始录制本地 App Server CPU 样本', '停止录制本地 App Server CPU 样本', '网络诊断',
		]);
		assert.ok(commands.every(command => commandActionLabel(command.category!) === '开发人员'));
		assert.ok(commands.every(command => command.precondition?.keys().has(ChatContextKeys.enabled.key)));
	});

	test('reveals the native profile supplied by the host', async () => {
		using services = new InstantiationService();
		const profile = URI.file('/profile with spaces');
		const f = fixture(services, profile);
		await f.run(storageCommand);
		assert.deepEqual(f.paths, [profile.fsPath]);
	});

	test('rejects a non-local profile and skips desktop operations when Chat is disabled', async () => {
		using services = new InstantiationService();
		const f = fixture(services, URI.parse('ash-remote://host/profile'));
		await assert.rejects(f.run(storageCommand), /storage folder is unavailable/);
		f.state.disabled = true;
		await f.run(storageCommand);
		await f.run(networkCommand);
		await f.run(restartCommand);
		assert.deepEqual(f.paths, []);
		assert.equal(f.networkCalls, 0);
	});

	test('dispatches restart for a local workspace and rejects a remote workspace', async () => {
		using services = new InstantiationService();
		using remoteServices = new InstantiationService();
		const local = fixture(services, URI.file('/profile'));
		const remote = fixture(remoteServices, URI.file('/profile'), 'ssh+host');
		await local.run(restartCommand);
		await assert.rejects(remote.run(restartCommand), /from a local desktop window/);
		assert.deepEqual(ipcCalls.splice(0), [[LOCAL_APP_SERVER_RESTART_CHANNEL, undefined]]);
	});

	test('routes native diagnostics for the local profile and rejects remote requests', async () => {
		using services = new InstantiationService();
		using remoteServices = new InstantiationService();
		const local = fixture(services, URI.file('/profile'));
		const remote = fixture(remoteServices, URI.file('/profile'), 'ssh+host');
		for (const command of [debugCommand, startProfileCommand, stopProfileCommand]) {
			await local.run(command);
			await assert.rejects(remote.run(command), /from a local desktop window/);
		}
		assert.deepEqual(ipcCalls.splice(0), [
			[LOCAL_APP_SERVER_DIAGNOSTICS_CHANNEL, 'debug'],
			[LOCAL_APP_SERVER_DIAGNOSTICS_CHANNEL, 'startProfile'],
			[LOCAL_APP_SERVER_DIAGNOSTICS_CHANNEL, 'stopProfile'],
		]);
		assert.equal(local.notifications.length, 1);
	});

	test('opens a pinned report from the window’s App Server probe', async () => {
		using services = new InstantiationService();
		const f = fixture(services, URI.file('/profile'));
		await f.run(networkCommand);
		assert.equal(f.networkCalls, 1);
		assert.equal(f.reports[0]?.languageId, 'markdown');
		assert.match(f.reports[0]?.initialValue ?? '', /^# Network Diagnostics/u);
		assert.deepEqual(JSON.parse(f.reports[0]!.initialValue!.split('```')[1]!.slice('json\n'.length)), diagnostics);
		assert.deepEqual(f.opened, [{ resource: 'untitled:/diagnostics', options: { pinned: true } }]);
	});

	test('discards a report from a replaced connection and propagates probe failures', async () => {
		using services = new InstantiationService();
		const f = fixture(services, URI.file('/profile'));
		const result = new DeferredPromise<NetworkDiagnostics>();
		f.probeWith(() => result.p);
		const command = f.run(networkCommand);
		f.state.generation++;
		await result.complete(diagnostics);
		await command;
		f.probeWith(async () => { throw new Error('Network probe failed'); });
		await assert.rejects(f.run(networkCommand), /Network probe failed/);
		assert.deepEqual(f.reports, []);
	});
});
