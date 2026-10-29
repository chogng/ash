import { IFileService } from '../../../../../platform/files/common/files.js';
import {
	ITerminalCompletionService,
	TerminalCompletionService,
} from '../../../terminalContrib/suggest/browser/terminalCompletionService.js';
import { ITerminalQuickFixService } from '../../../terminalContrib/quickFix/browser/quickFix.js';
import { TerminalQuickFixService } from '../../../terminalContrib/quickFix/browser/terminalQuickFixService.js';
import { ITerminalLinkProviderService } from '../../../terminalContrib/links/browser/links.js';
import { TerminalLinkProviderService } from '../../../terminalContrib/links/browser/terminalLinkProviderService.js';
import { ITerminalGroupService } from '../../browser/terminal.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { registerTestTerminalCreationServices } from '../../../../test/browser/workbenchTestServices.js';
import { IEnvironmentVariableService } from '../../common/environmentVariable.js';
import { EnvironmentVariableService } from '../../common/environmentVariableService.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import {
	ITerminalContributionService,
	ITerminalProfileResolverService,
	ITerminalProfileService,
} from '../../common/terminal.js';
import { BrowserTerminalProfileResolverService } from '../../browser/terminalProfileResolverService.js';
import {
	MainThreadTerminalService,
	type ExtensionTerminalProfileRegistration,
} from '../../../../api/browser/mainThreadTerminalService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import {
	GeneralShellType,
	PosixShellType,
	TerminalLocation,
	WindowsShellType,
	type TerminalShellType,
} from '../../../../../platform/terminal/common/terminal.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import {
	IQuickInputService,
	type IQuickPick,
	type IQuickPickItem,
} from '../../../../../platform/quickinput/common/quickInput.js';

/** This transport fixture routes issued resources independently of factory disposal. */
function withPtyResources(
	descriptors: readonly ExtensionTerminalProfileRegistration[],
): readonly ExtensionTerminalProfileRegistration[] {
	return descriptors.map(descriptor => ({
		...descriptor,
		pty: descriptor.pty ?? {
			signal: new AbortController().signal,
			invoker: registrationId => {
				assert.ok(registrationId.startsWith('resource.'));
				return descriptor.invoke;
			},
		},
	}));
}
import { ITerminalProcessService, type IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { registerTerminalPlatformConfiguration } from '../../../../../platform/terminal/common/terminalPlatformConfiguration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';

import { ITerminalService, type ITerminalInstance, type ITerminalProfile } from '../../browser/terminal.js';
import { TerminalConfigurationService } from '../../browser/terminalConfigurationService.js';
import '../../../codeEditor/common/editorConfiguration.js';
import { TerminalProfileService } from '../../browser/terminalProfileService.js';
import { TerminalProfileQuickpick } from '../../browser/terminalProfileQuickpick.js';
import { TerminalMainContribution } from '../../browser/terminalMainContribution.js';
import { IEmbedderTerminalService } from '../../../../services/terminal/common/embedderTerminalService.js';
import { TerminalService } from '../../browser/terminalService.js';
import type {
	ITerminalProcessCreateOptions,
	ITerminalProcessCloseOptions,
} from '../../../../../platform/terminal/common/terminal.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';

const shells = [
	{ profileId: 'host-default', title: 'Host shell', isDefault: true },
	{ profileId: 'pwsh', title: 'PowerShell', isDefault: false },
];

function createServices(
	owner: DisposableStore,
	useInstances = false,
	openEditor: IEditorService['openEditor'] = async () => {},
	checkpoint?: { state: string; credentials?: string },
	operatingSystem = OperatingSystem.Windows,
) {
	const services = owner.add(new InstantiationService());
	services.registerInstance(ICommandService, owner.add(new CommandService(services)));
	const files = owner.add(new FileService());
	owner.add(files.registerProvider('file', owner.add(new InMemoryFileSystemProvider())));
	services.registerInstance(IFileService, files);
	services.registerInstance(ILogService, new NullLoggerService());
	const configuration = owner.add(new WorkbenchConfigurationService());
	const connection = owner.add(
		new Emitter<import('../../../../../platform/terminal/common/terminal.js').TerminalProcessConnectionState>(),
	);
	const workspace = owner.add(new TestWorkspaceService({ id: 'test', uri: URI.file('/workspace') }));
	let calls = 0;
	const launches: ITerminalProcessCreateOptions[] = [];
	const closed: ITerminalProcessCloseOptions[] = [];
	let read: () => Promise<readonly ITerminalProfile[]> = async () => shells;
	const processes = {
		operatingSystem: operatingSystem as OperatingSystem | undefined,
		onConnectionState: connection.event,
		listProfiles: async () => {
			calls++;
			return read();
		},
		getEnvironment: async () => ({
			HOME: '/execution/home',
			PATH: '/execution/bin',
			PROFILE_VALUE: 'environment value',
		}),
		resolveProfile: async (
			selection: import('../../../../../platform/terminal/common/terminal.js').TerminalProcessProfileSelection,
		) => ({
			profile:
				selection.type === 'custom'
					? { profileId: `custom:${selection.name}`, title: selection.name, isDefault: false }
					: (shells.find(
							profile => selection.type === 'profile' && selection.profileId === profile.profileId,
						) ?? shells[0]!),
			executable: selection.type === 'custom' ? selection.path.at(-1)! : '/execution/bin/shell',
			args:
				selection.type === 'custom'
					? typeof selection.args === 'string'
						? selection.args
						: [...selection.args]
					: [],
		}),
		getConnectionState: async () => 'ready',
		create: async (options: ITerminalProcessCreateOptions) => {
			launches.push(options);
			return {
				terminalId: `process-${launches.length}`,
				ready: { pid: 42, cwd: options.cwd ?? '/workspace' },
				profile: shells[0],
				connectionPersistence: 'connectionOwned',
			};
		},
		read: async ({ terminalId }: { terminalId: string }) => ({
			terminalId,
			chunks: [{ sequence: 1, data: new TextEncoder().encode('shell output') }],
			nextSequence: 1,
			outputGap: false,
			commandEvents: [],
			nextCommandSequence: 0,
			commandEventGap: false,
			exited: true,
			exitCode: 0,
		}),
		// Restoring a retained PTY synchronizes its dimensions before reading output.
		resize: async () => {},
		close: async (options: ITerminalProcessCloseOptions) => {
			closed.push(options);
		},
	} as unknown as ITerminalProcessService;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ITerminalContributionService, {
		terminalProfiles: [],
		onDidChangeTerminalProfiles: Event.None,
		...Disposable.None,
	});
	services.registerInstance(IExtensionService, {
		...Disposable.None,
		getExtensionPointContributions: () => [],
		currentCatalog: { generation: 0, extensions: [], diagnostics: [] },
		onDidChange: Event.None,
		activateByEvent: async () => {},
	} as unknown as IExtensionService);
	services.registerInstance(IConfigurationResolverService, {
		resolveWithEnvironment: async (env, folder, value) =>
			value
				.replaceAll('${workspaceFolder}', folder?.uri.path ?? '')
				.replace(/\$\{env:([^}]+)\}/g, (_match: string, key: string) => env[key] ?? ''),
	} as IConfigurationResolverService);
	services.registerInstance(IWorkspaceContextService, workspace);
	const stored = new Map<string, string>();
	services.registerInstance(IStorageService, {
		get: (key: string) => stored.get(key),
		store: (key: string, value: string) => {
			stored.set(key, value);
		},
	} as unknown as IStorageService);
	services.registerInstance(ITerminalProcessService, processes);
	services.registerInstance(
		ITerminalCompletionService,
		owner.add(services.createInstance(TerminalCompletionService)),
	);
	services.registerInstance(ITerminalQuickFixService, owner.add(services.createInstance(TerminalQuickFixService)));
	services.registerSingleton(ITerminalLinkProviderService, () =>
		services.createInstance(TerminalLinkProviderService),
	);
	services.registerInstance(
		IEnvironmentVariableService,
		owner.add(services.createInstance(EnvironmentVariableService)),
	);
	const profiles = owner.add(services.createInstance(TerminalProfileService));
	services.registerInstance(ITerminalProfileService, profiles);
	services.registerInstance(
		ITerminalProfileResolverService,
		owner.add(services.createInstance(BrowserTerminalProfileResolverService)),
	);
	services.registerInstance(IViewsService, { openView: async () => undefined } as unknown as IViewsService);
	services.registerInstance(IEditorService, {
		activeEditor: undefined,
		onDidActiveEditorChange: Event.None,
		openEditor,
	} as unknown as IEditorService);
	services.registerInstance(IEditorGroupsService, {
		groups: [],
		onDidChangeGroups: Event.None,
	} as unknown as IEditorGroupsService);
	registerTestTerminalCreationServices(services);
	if (checkpoint) {
		services
			.get(IStorageService)
			.store(
				checkpoint.credentials ? 'terminal.reload.11111111-1111-1111-1111-111111111111' : 'terminal.revive',
				checkpoint.state,
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
		if (checkpoint.credentials)
			void services.get(ISecretStorageService).set('terminal.reload', checkpoint.credentials);
	}
	services.registerInstance(
		ITerminalService,
		useInstances
			? owner.add(services.createInstance(TerminalService))
			: ({ ...Disposable.None } as unknown as ITerminalService),
	);
	return {
		services,
		configuration,
		profiles,
		processes,
		workspace,
		connection,
		launches,
		closed,
		calls: () => calls,
		setRead: (fn: typeof read) => {
			read = fn;
		},
	};
}

function installPicker(owner: DisposableStore, services: InstantiationService) {
	const accept = owner.add(new Emitter<void>());
	const hide = owner.add(new Emitter<void>());
	let shown = false;
	let disposed = 0;
	const picker = Object.assign(
		toDisposable(() => {
			disposed++;
		}),
		{
			items: [] as readonly IQuickPickItem[],
			placeholder: '',
			ariaLabel: '',
			selectedItems: [] as readonly IQuickPickItem[],
			onDidAccept: accept.event,
			onDidHide: hide.event,
			show: () => {
				shown = true;
			},
			hide: () => hide.fire(),
		},
	);
	services.registerInstance(IQuickInputService, {
		createQuickPick: () => picker as unknown as IQuickPick<IQuickPickItem>,
	} as IQuickInputService);
	return {
		picker,
		accept: (index: number) => {
			picker.selectedItems = [picker.items[index]!];
			accept.fire();
		},
		hide: () => hide.fire(),
		shown: () => shown,
		disposed: () => disposed,
	};
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (check()) return;
		await Promise.resolve();
	}
	assert.ok(check(), 'Expected asynchronous transition');
}

suite('Terminal configuration and interactive profiles', () => {
	for (const locale of ['en', 'zh-CN'])
		test(`agent host profile creates the configured shell and retires with its connection (${locale})`, async () => {
			using owner = new DisposableStore();
			owner.add(toDisposable(resetNlsResolver));
			initializeTestLocalization(locale);
			const { services, configuration, profiles, connection, launches } = createServices(owner, true);
			services.registerInstance(IEmbedderTerminalService, {
				onDidCreateTerminal: Event.None,
				createTerminal: () => {},
			});
			await configuration.updateValue('terminal.integrated.agentHostProfile.windows', {
				path: '/agent/shell',
				args: ['--login'],
				env: { AGENT: 'configured' },
			});
			using contribution = services.createInstance(TerminalMainContribution);
			await profiles.profilesReady;
			const profile = profiles.contributedProfiles.find(
				profile => profile.extensionIdentifier === 'ash.agent-host',
			);
			assert.ok(profile);
			assert.equal(profile.title, locale === 'zh-CN' ? '智能体主机（本地）' : 'Agent Host (Local)');
			const terminals = services.get(ITerminalService);
			const instance = await terminals.createTerminal({ config: profile });
			assert.equal(instance.title, profile.title);
			assert.deepEqual(launches[0]?.profile, {
				type: 'custom',
				name: profile.title,
				path: ['/agent/shell'],
				args: ['--login'],
			});
			assert.equal(launches[0]?.env?.AGENT, 'configured');
			const provider = profiles.getContributedProfileProvider(profile.extensionIdentifier, profile.id)!;
			connection.fire('crashed');
			assert.deepEqual(profiles.contributedProfiles, []);
			await assert.rejects(
				provider.createContributedTerminalProfile({}),
				/Terminal profile provider is unavailable|终端配置提供程序不可用/,
			);
			connection.fire('ready');
			assert.equal(profiles.contributedProfiles.length, 2);
			contribution.dispose();
			assert.deepEqual(profiles.contributedProfiles, []);
		});

	test('Ash Code uses a contributed profile and retires an in-flight CLI launch with its connection', async () => {
		using owner = new DisposableStore();
		const { services, profiles, connection } = createServices(owner, true);
		services.registerInstance(IEmbedderTerminalService, {
			onDidCreateTerminal: Event.None,
			createTerminal: () => {},
		});
		using contribution = services.createInstance(TerminalMainContribution);
		await profiles.profilesReady;
		const profile = profiles.contributedProfiles.find(profile => profile.extensionIdentifier === 'ash.code');
		assert.equal(profile?.title, 'Ash Code');
		const provider = profiles.getContributedProfileProvider('ash.code', 'cli')!;
		const terminals = services.get(ITerminalService);
		const launches: unknown[] = [];
		const writes: unknown[] = [];
		const closed: number[] = [];
		const instance = {
			instanceId: 17,
			sendText: async (...args: unknown[]) => {
				writes.push(args);
			},
		} as unknown as ITerminalInstance;
		terminals.createTerminal = async options => {
			launches.push(options);
			return instance;
		};
		terminals.closeTerminal = async target => {
			closed.push(target.instanceId);
		};
		const cwd = URI.file('/workspace/project');
		assert.equal(await provider.createContributedTerminalProfile({ cwd, preserveFocus: true }), 17);
		assert.deepEqual(launches, [
			{
				config: { name: 'Ash Code', icon: undefined, color: undefined },
				cwd,
				location: undefined,
				preserveFocus: true,
				skipContributedProfileCheck: true,
			},
		]);
		assert.deepEqual(writes, [['ash code', true]]);
		const entered = new DeferredPromise<void>();
		const completed = new DeferredPromise<ITerminalInstance>();
		terminals.createTerminal = async () => {
			entered.complete();
			return completed.p;
		};
		const pending = provider.createContributedTerminalProfile({});
		await entered.p;
		connection.fire('crashed');
		completed.complete(instance);
		await assert.rejects(pending, /Operation cancelled/);
		assert.deepEqual(closed, [17]);
		assert.deepEqual(writes, [['ash code', true]], 'Retired launches must not send a CLI command');
	});

	for (const retirement of ['connection', 'workspace', 'dispose'])
		test(`agent host profile releases a terminal after ${retirement} retirement`, async () => {
			using owner = new DisposableStore();
			const { services, profiles, connection, workspace } = createServices(owner, true);
			services.registerInstance(IEmbedderTerminalService, {
				onDidCreateTerminal: Event.None,
				createTerminal: () => {},
			});
			using contribution = services.createInstance(TerminalMainContribution);
			await profiles.profilesReady;
			const provider = profiles.getContributedProfileProvider('ash.agent-host', 'local')!;
			const entered = new DeferredPromise<void>();
			const completed = new DeferredPromise<ITerminalInstance>();
			const closed: ITerminalInstance[] = [];
			const terminals = services.get(ITerminalService);
			terminals.createTerminal = async () => {
				entered.complete();
				return completed.p;
			};
			terminals.closeTerminal = async instance => {
				closed.push(instance);
			};
			const creating = provider.createContributedTerminalProfile({});
			const rejected = assert.rejects(creating, isCancellationError);
			await entered.p;
			if (retirement === 'connection') connection.fire('crashed');
			else if (retirement === 'workspace')
				workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
			else contribution.dispose();
			const instance = { instanceId: 123 } as ITerminalInstance;
			completed.complete(instance);
			await rejected;
			assert.deepEqual(closed, [instance]);
		});
	ensureNoDisposablesAreLeakedInTestSuite();

	test('second-root launches use that directory for workspace variables, folder cwd and backend resolution', async () => {
		using owner = new DisposableStore();
		const { services, configuration, workspace, processes } = createServices(owner);
		const files = owner.add(new FileService());
		const provider = owner.add(new InMemoryFileSystemProvider());
		owner.add(files.registerProvider('file', provider));
		const config = URI.file('/workspace/team.ash-workspace');
		await files.createDirectory(URI.file('/workspace'));
		await files.createDirectory(URI.file('/second/.vscode'));
		await files.writeFile(
			{
				resource: config,
				content: JSON.stringify({
					folders: [],
					settings: { 'terminal.integrated.env.windows': { SELECTED: '${workspaceFolder}' } },
				}),
			},
			{ create: true, overwrite: false },
		);
		await files.writeFile(
			{
				resource: URI.file('/second/.vscode/settings.json'),
				content: JSON.stringify({ 'terminal.integrated.cwd': '${workspaceFolder}/run' }),
			},
			{ create: true, overwrite: false },
		);
		const folders = [
			{ id: 'one', name: 'one', uri: URI.file('/workspace'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/second'), index: 1 },
		];
		workspace.updateWorkspace({ id: 'multi-root', configuration: config, folders });
		configuration.updateWorkspace(workspace.getWorkspace());
		await configuration.initialize(files);
		const routes: (string | undefined)[] = [];
		processes.getEnvironment = async (_profile, dirId) => {
			routes.push(dirId);
			return {};
		};
		const resolver = services.get(ITerminalProfileResolverService);
		const shell = {
			executable: '/bin/shell',
		} as import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig;
		await resolver.resolveShellLaunchConfig(shell, {
			os: OperatingSystem.Windows,
			remoteAuthority: undefined,
			workspaceFolder: folders[1],
		});
		assert.equal(shell.cwd, '/second/run');
		assert.equal(shell.env?.SELECTED, '/second');
		assert.deepEqual(routes, ['two']);
		await assert.rejects(
			resolver.resolveShellLaunchConfig({}, { os: OperatingSystem.Windows, remoteAuthority: undefined }),
			/Select a workspace folder/,
		);
	});

	test('profile discovery and executable resolution stay on the selected root after reordering', async () => {
		using owner = new DisposableStore();
		const { services, workspace, processes } = createServices(owner, true);
		const folders = [
			{ id: 'one', name: 'one', uri: URI.file('/workspace'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/second'), index: 1 },
		];
		workspace.updateWorkspace({ id: 'multi-root', configuration: URI.file('/team.ash-workspace'), folders });
		const listed: (string | undefined)[] = [];
		const resolved: (string | undefined)[] = [];
		processes.listProfiles = async dirId => {
			listed.push(dirId);
			return shells;
		};
		const resolveProfile = processes.resolveProfile.bind(processes);
		processes.resolveProfile = async (selection, dirId) => {
			resolved.push(dirId);
			return resolveProfile(selection, dirId);
		};
		const resolver = services.get(ITerminalProfileResolverService);
		await resolver.getDefaultProfile({
			os: OperatingSystem.Windows,
			remoteAuthority: undefined,
			workspaceFolder: folders[1],
		});
		workspace.updateWorkspace({
			id: 'multi-root',
			configuration: URI.file('/team.ash-workspace'),
			folders: [
				{ ...folders[1]!, index: 0 },
				{ ...folders[0]!, index: 1 },
			],
		});
		await resolver.getDefaultProfile({
			os: OperatingSystem.Windows,
			remoteAuthority: undefined,
			workspaceFolder: folders[1],
		});
		assert.ok(listed.length >= 2);
		assert.ok(resolved.length >= 2);
		assert.ok(listed.every(dirId => dirId === 'two'));
		assert.ok(resolved.every(dirId => dirId === 'two'));
	});

	test('concurrent directory profile resolutions keep independent results', async () => {
		using owner = new DisposableStore();
		const { services, workspace, processes } = createServices(owner, true);
		const folders = [
			{ id: 'one', name: 'one', uri: URI.file('/first'), index: 0 },
			{ id: 'two', name: 'two', uri: URI.file('/second'), index: 1 },
		];
		workspace.updateWorkspace({ id: 'team', configuration: URI.file('/team.ash-workspace'), folders });
		processes.listProfiles = async dirId => [
			{ profileId: `${dirId}-shell`, title: `${dirId} shell`, isDefault: true },
		];
		processes.resolveProfile = async (_selection, dirId) => ({
			profile: { profileId: `${dirId}-shell`, title: `${dirId} shell`, isDefault: true },
			executable: `/${dirId}/shell`,
			args: [],
		});
		const resolver = services.get(ITerminalProfileResolverService);
		const [first, second] = await Promise.all(
			folders.map(workspaceFolder =>
				resolver.getDefaultProfile({
					os: OperatingSystem.Windows,
					remoteAuthority: undefined,
					workspaceFolder,
				}),
			),
		);
		assert.equal(first!.path, '/one/shell');
		assert.equal(second!.path, '/two/shell');
	});

	test('terminal fonts inherit the editor face and retain a monospace fallback', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		const terminalConfig = owner.add(services.createInstance(TerminalConfigurationService));
		await configuration.updateValue('editor.fontFamily', 'Missing Editor Font');
		assert.equal(terminalConfig.config.fontFamily, 'Missing Editor Font, monospace');
		await configuration.updateValue('terminal.integrated.fontFamily', 'Terminal Face');
		assert.equal(terminalConfig.config.fontFamily, 'Terminal Face, monospace');
		await configuration.updateValue('terminal.integrated.fontFamily', 'monospace');
		assert.equal(terminalConfig.config.fontFamily, 'monospace');
	});

	test('validates configuration values before changing the active snapshot', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		const terminalConfig = owner.add(services.createInstance(TerminalConfigurationService));
		let changes = 0;
		owner.add(terminalConfig.onConfigChanged(() => changes++));
		await configuration.updateValue('terminal.integrated.fontSize', 18);
		assert.equal(terminalConfig.config.fontSize, 18);
		for (const [key, value] of [
			['fontSize', 0],
			['fontSize', Infinity],
			['scrollback', -1],
			['scrollback', 1.5],
			['cursorStyle', 'bar'],
			['cursorBlinking', 'true'],
			['minimumContrastRatio', 22],
		] as const) {
			await assert.rejects(configuration.updateValue(`terminal.integrated.${key}`, value));
		}
		assert.equal(terminalConfig.config.fontSize, 18);
		assert.equal(changes, 1);
		await configuration.updateValue('terminal.integrated.cursorStyle', 'line');
		assert.equal(terminalConfig.config.cursorStyle, 'line');
	});

	test('platform launch schema registration is idempotent and preserves environment validation', async () => {
		using owner = new DisposableStore();
		const { configuration } = createServices(owner);
		registerTerminalPlatformConfiguration();
		registerTerminalPlatformConfiguration();
		assert.equal(configuration.getValue('terminal.integrated.defaultProfile.windows'), null);
		assert.deepEqual(configuration.getValue('terminal.integrated.env.windows'), {});
		await configuration.updateValue('terminal.integrated.env.windows', { Path: 'host override', REMOVED: null });
		for (const invalid of [{ 'BAD=KEY': 'x' }, { PATH: 1 }, { PATH: 'x'.repeat(32769) }]) {
			await assert.rejects(configuration.updateValue('terminal.integrated.env.windows', invalid));
		}
		assert.deepEqual(configuration.getValue('terminal.integrated.env.windows'), {
			Path: 'host override',
			REMOVED: null,
		});
	});

	test('uses the execution host OS and refreshes default labels without rediscovery', async () => {
		using owner = new DisposableStore();
		const { profiles, configuration, calls, processes } = createServices(owner);
		await configuration.updateValue('terminal.integrated.defaultProfile.osx', 'Host shell');
		await configuration.updateValue('terminal.integrated.defaultProfile.windows', 'PowerShell');
		await profiles.refreshAvailableProfiles();
		assert.equal(await profiles.getPlatformKey(), 'windows');
		assert.equal(profiles.getDefaultProfile()?.profileId, 'pwsh');
		assert.equal(profiles.getDefaultProfileName(), 'PowerShell');
		assert.deepEqual(
			profiles.availableProfiles.map(p => p.isDefault),
			[false, true],
		);
		let changes = 0;
		owner.add(profiles.onDidChangeAvailableProfiles(() => changes++));
		await configuration.updateValue('terminal.integrated.defaultProfile.windows', 'Unavailable shell');
		assert.equal(profiles.getDefaultProfile()?.profileId, 'host-default');
		assert.equal(changes, 1);
		assert.equal(calls(), 1);
		Object.assign(processes, { operatingSystem: undefined });
		await assert.rejects(profiles.getPlatformKey(), /execution host/);
		assert.equal(profiles.getDefaultProfileName(), undefined);
	});

	test('profile catalogs in separate service scopes do not feed schema changes back into each other', async () => {
		using owner = new DisposableStore();
		const first = createServices(owner);
		const second = createServices(owner);
		await first.profiles.refreshAvailableProfiles();
		assert.equal(second.profiles.availableProfiles.length, 0);
		await second.profiles.refreshAvailableProfiles();
		assert.deepEqual(
			first.profiles.availableProfiles.map(profile => profile.profileId),
			['host-default', 'pwsh'],
		);
		assert.deepEqual(
			second.profiles.availableProfiles.map(profile => profile.profileId),
			['host-default', 'pwsh'],
		);
		assert.deepEqual([first.calls(), second.calls()], [1, 1]);
	});

	test('coalesces discoveries and rejects late results after disconnect or replacement', async () => {
		using owner = new DisposableStore();
		const { profiles, connection, calls, setRead } = createServices(owner);
		let release!: (profiles: readonly ITerminalProfile[]) => void;
		setRead(
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);
		const stale = profiles.refreshAvailableProfiles();
		assert.equal(profiles.refreshAvailableProfiles(), stale);
		assert.equal(calls(), 1);
		const cancelled = assert.rejects(stale, isCancellationError);
		connection.fire('crashed');
		assert.equal(profiles.availableProfiles.length, 0);
		setRead(async () => shells);
		connection.fire('ready');
		await waitFor(() => profiles.availableProfiles.length === 2);
		release([{ profileId: 'stale', title: 'Stale shell', isDefault: true }]);
		await cancelled;
		assert.deepEqual(
			profiles.availableProfiles.map(p => p.profileId),
			['host-default', 'pwsh'],
		);
	});

	test('releases a pending discovery and all subscriptions with the profile owner', async () => {
		using owner = new DisposableStore();
		const { profiles, setRead } = createServices(owner);
		let release!: (profiles: readonly ITerminalProfile[]) => void;
		setRead(
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);
		let events = 0;
		owner.add(profiles.onDidChangeAvailableProfiles(() => events++));
		const pending = profiles.refreshAvailableProfiles();
		const cancelled = assert.rejects(pending, isCancellationError);
		profiles.dispose();
		release(shells);
		await cancelled;
		assert.equal(events, 0);
	});

	test('quick pick returns a trusted ID and cancels without changing settings', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		const ui = installPicker(owner, services);
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('createInstance');
		await waitFor(ui.shown);
		assert.equal(ui.picker.ariaLabel, 'Select a terminal profile');
		ui.accept(1);
		assert.equal(await result, 'pwsh');
		assert.equal(ui.disposed(), 1);
		assert.equal(configuration.getValue('terminal.integrated.defaultProfile.windows'), null);
	});

	test('profile quick pick requires its execution connection owner during construction', () => {
		using owner = new DisposableStore();
		const { services } = createServices(owner);
		owner.add(installPicker(owner, services).picker);
		using missing = new InstantiationService();
		missing.registerInstance(ITerminalProfileService, services.get(ITerminalProfileService));
		missing.registerInstance(IConfigurationService, services.get(IConfigurationService));
		missing.registerInstance(IQuickInputService, services.get(IQuickInputService));
		missing.registerInstance(IWorkspaceContextService, services.get(IWorkspaceContextService));
		missing.registerInstance(IEditorService, services.get(IEditorService));
		missing.registerInstance(ICommandService, services.get(ICommandService));
		assert.throws(
			() => missing.createInstance(TerminalProfileQuickpick),
			/Unknown service: terminalProcessService/,
		);
	});

	test('default selection persists the profile name at USER and updates available labels', async () => {
		using owner = new DisposableStore();
		const { services, profiles, configuration } = createServices(owner);
		const ui = installPicker(owner, services);
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('setDefault');
		await waitFor(ui.shown);
		ui.accept(1);
		assert.equal(await result, 'PowerShell');
		assert.equal(configuration.inspect('terminal.integrated.defaultProfile.windows').userValue, 'PowerShell');
		assert.deepEqual(
			profiles.availableProfiles.map(p => p.isDefault),
			[false, true],
		);
	});

	test('cancel and owner disposal settle a quick pick without a profile update', async () => {
		for (const cancel of ['hide', 'dispose'] as const) {
			using owner = new DisposableStore();
			const { services, configuration } = createServices(owner);
			const ui = installPicker(owner, services);
			using picker = services.createInstance(TerminalProfileQuickpick);
			const result = picker.showAndGetResult('setDefault');
			await waitFor(ui.shown);
			if (cancel === 'hide') ui.hide();
			else picker.dispose();
			assert.equal(await result, undefined);
			assert.equal(ui.disposed(), 1);
			assert.equal(configuration.getValue('terminal.integrated.defaultProfile.windows'), null);
		}
	});

	test('an open picker withdraws profiles on disconnect and ignores its old selection', async () => {
		using owner = new DisposableStore();
		const { services, connection } = createServices(owner);
		const ui = installPicker(owner, services);
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('createInstance');
		await waitFor(ui.shown);
		connection.fire('crashed');
		assert.deepEqual(ui.picker.items, []);
		ui.hide();
		assert.equal(await result, undefined);
	});

	test('workspace transitions refresh empty-window profiles and discard their late catalogue', async () => {
		using owner = new DisposableStore();
		const { profiles, workspace, processes, setRead } = createServices(owner);
		const directories: (string | undefined)[] = [];
		const listProfiles = processes.listProfiles.bind(processes);
		processes.listProfiles = async dirId => {
			directories.push(dirId);
			return listProfiles(dirId);
		};
		const initialDirectory = workspace.getWorkspace().folders[0]!.id;
		await profiles.refreshAvailableProfiles();
		assert.deepEqual(directories, [initialDirectory]);
		const emptyProfiles = new DeferredPromise<readonly ITerminalProfile[]>();
		setRead(() => emptyProfiles.p);
		workspace.updateWorkspace({ id: 'empty-window' });
		assert.equal(profiles.availableProfiles.length, 0);
		assert.deepEqual(directories, [initialDirectory, undefined]);
		const retiredRequest = assert.rejects(profiles.refreshAvailableProfiles(), isCancellationError);
		setRead(async () => [{ profileId: 'other', title: 'Other shell', isDefault: true }]);
		workspace.updateWorkspace({ id: 'other-folder', uri: URI.file('/other') });
		assert.equal(profiles.availableProfiles.length, 0);
		await profiles.profilesReady;
		assert.deepEqual(directories, [initialDirectory, undefined, workspace.getWorkspace().folders[0]!.id]);
		assert.deepEqual(
			profiles.availableProfiles.map(profile => profile.profileId),
			['other'],
		);
		assert.equal(profiles.getDefaultProfile()?.profileId, 'other');
		await emptyProfiles.complete(shells);
		await retiredRequest;
		assert.deepEqual(
			profiles.availableProfiles.map(profile => profile.profileId),
			['other'],
		);
		assert.equal(profiles.getDefaultProfile()?.profileId, 'other');
	});

	for (const transition of ['workspace', 'reconnect'] as const) {
		for (const kind of ['createInstance', 'setDefault'] as const) {
			test(`${kind} profile selection stays retired after ${transition} restores the same profile IDs`, async () => {
				using owner = new DisposableStore();
				const { services, profiles, workspace, connection, configuration } = createServices(owner);
				const ui = installPicker(owner, services);
				using picker = services.createInstance(TerminalProfileQuickpick);
				const result = picker.showAndGetResult(kind);
				await waitFor(ui.shown);
				if (transition === 'workspace')
					workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/other') });
				else {
					connection.fire('crashed');
					connection.fire('ready');
				}
				await profiles.refreshAvailableProfiles();
				// The retired UI can still deliver an already queued accept callback.
				ui.picker.items = profiles.availableProfiles.map(profile => ({
					label: profile.title,
					profileId: profile.profileId,
				}));
				ui.accept(1);
				assert.equal(await result, undefined);
				assert.equal(configuration.getValue('terminal.integrated.defaultProfile.windows'), null);
				assert.equal(ui.disposed(), 1);
			});
		}
	}

	test('default profile acceptance cannot write after a scope change during its final platform lookup', async () => {
		using owner = new DisposableStore();
		const { services, profiles, workspace, configuration } = createServices(owner);
		const ui = installPicker(owner, services);
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('setDefault');
		await waitFor(ui.shown);
		const platform = new DeferredPromise<'windows'>();
		const requested = new DeferredPromise<void>();
		profiles.getPlatformKey = () => {
			void requested.complete();
			return platform.p;
		};
		ui.accept(1);
		await requested.p;
		workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/other') });
		await profiles.refreshAvailableProfiles();
		await platform.complete('windows');
		assert.equal(await result, undefined);
		assert.equal(configuration.getValue('terminal.integrated.defaultProfile.windows'), null);
	});

	test('default selection exposes a write failure without changing the runtime default', async () => {
		using owner = new DisposableStore();
		const { services, configuration, profiles } = createServices(owner);
		const ui = installPicker(owner, services);
		configuration.updateValue = async () => {
			throw new Error('settings write rejected');
		};
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('setDefault');
		const failed = assert.rejects(result, /settings write rejected/);
		await waitFor(ui.shown);
		ui.accept(1);
		await failed;
		assert.equal(profiles.getDefaultProfile()?.profileId, 'host-default');
		assert.equal(ui.disposed(), 1);
	});

	test('configuration service fails if its required owner is absent', () => {
		using services = new InstantiationService();
		assert.throws(
			() => services.createInstance(TerminalConfigurationService),
			/Unknown service: configurationService/,
		);
	});
	test('custom profile configuration hides detected entries and resolves argv, cwd and environment', async () => {
		using owner = new DisposableStore();
		const { services, configuration, profiles } = createServices(owner);
		await configuration.updateValue('terminal.integrated.profiles.windows', {
			'Host shell': null,
			'Configured shell': {
				path: ['/missing/shell', '${env:HOME}/shell'],
				args: ['${env:PROFILE_VALUE}', 'literal;$HOME'],
				env: { MODE: 'profile', REMOVED: null },
			},
		});
		await configuration.updateValue('terminal.integrated.defaultProfile.windows', 'Configured shell');
		await configuration.updateValue('terminal.integrated.env.windows', { MODE: 'global', Path: 'global path' });
		await configuration.updateValue('terminal.integrated.cwd', '${workspaceFolder}/subdirectory');
		await profiles.profilesReady;
		assert.deepEqual(
			profiles.availableProfiles.map(profile => profile.profileName),
			['PowerShell', 'Configured shell'],
		);
		const resolver = services.get(ITerminalProfileResolverService);
		const shell: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig = {
			env: { mode: 'caller', PATH: '${env:PATH}' },
		};
		await resolver.resolveShellLaunchConfig(shell, { os: OperatingSystem.Windows, remoteAuthority: undefined });
		assert.equal(shell.executable, '/execution/home/shell');
		assert.deepEqual(shell.args, ['environment value', 'literal;$HOME']);
		assert.equal(shell.cwd, '/workspace/subdirectory');
		assert.deepEqual(shell.env, { MODE: 'caller', Path: '/execution/bin', REMOVED: null });
		await assert.rejects(
			configuration.updateValue('terminal.integrated.profiles.windows', { Bad: { args: ['without path'] } }),
		);
		await assert.rejects(configuration.updateValue('terminal.integrated.profiles.windows', { Bad: { path: [] } }));
		await assert.rejects(
			configuration.updateValue('terminal.integrated.profiles.windows', { 'Bad\nname': { path: '/shell' } }),
		);
		await assert.rejects(
			configuration.updateValue('terminal.integrated.profiles.windows', {
				Bad: { path: '/shell', source: 'PowerShell' },
			}),
		);
		await assert.rejects(configuration.updateValue('terminal.integrated.env.windows', { 'BAD=KEY': 'value' }));
	});

	test('resolver getters select automation policy and reject an unselected execution target', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		await configuration.updateValue('terminal.integrated.automationProfile.windows', {
			path: '/automation/shell',
			args: ['literal argument'],
		});
		const resolver = services.get(ITerminalProfileResolverService);
		const options = { os: OperatingSystem.Windows, remoteAuthority: undefined, allowAutomationShell: true };
		assert.equal(await resolver.getDefaultShell(options), '/automation/shell');
		assert.deepEqual(await resolver.getDefaultShellArgs(options), ['literal argument']);
		assert.equal((await resolver.getDefaultProfile(options)).path, '/automation/shell');
		const shell = { executable: '/original/shell', args: ['original'] };
		await assert.rejects(
			resolver.resolveShellLaunchConfig(shell, { os: OperatingSystem.Linux, remoteAuthority: undefined }),
			/execution host/,
		);
		assert.deepEqual(shell, { executable: '/original/shell', args: ['original'] });
		await assert.rejects(resolver.getEnvironment('unselected-host'), /execution host/);
		assert.equal(resolver.getDefaultIcon().id, 'terminal');
	});

	test('shell icons follow launch programs and WSL distributions after profiles are renamed', async () => {
		using owner = new DisposableStore();
		const { services } = createServices(owner);
		const resolver = services.get(ITerminalProfileResolverService);
		const options = { os: OperatingSystem.Windows, remoteAuthority: undefined };
		const cases: readonly {
			executable: string;
			args?: import('../../../../../platform/terminal/common/terminal.js').TerminalArguments;
			icon: string;
		}[] = [
			{ executable: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'], icon: 'terminal-ubuntu' },
			{
				executable: 'C:/Windows/System32/WSL.EXE',
				args: ['--distribution', 'Ubuntu-24.04'],
				icon: 'terminal-ubuntu',
			},
			{ executable: 'wsl.exe', args: '--user root --distribution "Ubuntu-24.04"', icon: 'terminal-ubuntu' },
			{ executable: 'wsl.exe', args: '--cd "C:\\Work folder" -d Ubuntu', icon: 'terminal-ubuntu' },
			{ executable: 'wsl.exe', args: String.raw`--cd "C:\Work\\" -d Ubuntu`, icon: 'terminal-ubuntu' },
			{ executable: 'wsl.exe', args: String.raw`--cd "C:\Work\" -d Ubuntu`, icon: 'terminal' },
			{ executable: 'wsl.exe', args: ['--cd', '-d', '--distribution', 'Ubuntu'], icon: 'terminal-ubuntu' },
			{
				executable: 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\ubuntu.exe',
				icon: 'terminal-ubuntu',
			},
			{ executable: 'ubuntu2404.exe', icon: 'terminal-ubuntu' },
			{ executable: 'C:\\Tools\\pwsh.exe', icon: 'terminal-powershell' },
			{ executable: 'C:\\Windows\\cmd.exe', icon: 'terminal-cmd' },
			{ executable: 'C:\\Program Files\\Git\\bin\\bash.exe', icon: 'terminal-git-bash' },
			{ executable: 'C:/Users/test/AppData/Local/Programs/Git/usr/bin/BASH.EXE', icon: 'terminal-git-bash' },
			{ executable: 'D:\\PortableGit\\git-bash.exe', icon: 'terminal-git-bash' },
			{ executable: 'C:\\msys64\\usr\\bin\\bash.exe', icon: 'terminal' },
			{ executable: 'C:\\cygwin64\\bin\\bash.exe', icon: 'terminal' },
			{ executable: 'wsl.exe', args: ['-d', 'Debian'], icon: 'terminal' },
			{ executable: 'wsl.exe', args: ['--exec', 'echo', '-d', 'Ubuntu'], icon: 'terminal' },
			{ executable: 'wsl.exe', args: ['--', '-d', 'Ubuntu'], icon: 'terminal' },
			{ executable: 'wsl.exe', args: ['echo', '-d', 'Ubuntu'], icon: 'terminal' },
			{ executable: 'wsl.exe', args: ['--user', '-d', 'Ubuntu'], icon: 'terminal' },
			{ executable: 'wsl.exe', args: '"--distribution Ubuntu"', icon: 'terminal' },
			{ executable: 'wsl.exe', args: '--exec echo -d Ubuntu', icon: 'terminal' },
			{ executable: 'wsl.exe', args: '-d "" echo Ubuntu', icon: 'terminal' },
			{ executable: 'wsl.exe', icon: 'terminal' },
			{ executable: '/bin/bash', args: ['-d', 'Ubuntu'], icon: 'terminal' },
		];
		for (const entry of cases) {
			for (const name of ['Ubuntu', 'Renamed work shell']) {
				const shell: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig = {
					name,
					executable: entry.executable,
					args: entry.args,
				};
				await resolver.resolveShellLaunchConfig(shell, options);
				assert.equal(shell.icon?.id, entry.icon, `${name}: ${entry.executable} ${JSON.stringify(entry.args)}`);
				assert.deepEqual(
					shell.args,
					entry.args ?? [],
					'Icon inference must preserve the actual launch arguments',
				);
				const preview: IShellLaunchConfig = { executable: entry.executable, args: entry.args };
				resolver.resolveIcon(preview, OperatingSystem.Windows);
				assert.equal(preview.icon?.id, shell.icon?.id, 'Profile menus and resolved launches must agree');
			}
		}
	});

	test('Ubuntu icon resolution uses resolved launch arguments and preserves explicit overrides', async () => {
		using owner = new DisposableStore();
		const { services, configuration, processes } = createServices(owner);
		Object.assign(processes, {
			getEnvironment: async () => ({ HOME: 'C:\\Windows\\System32', DISTRO: 'Ubuntu-24.04' }),
		});
		await configuration.updateValue('terminal.integrated.profiles.windows', {
			'Work shell': { path: '${env:HOME}/wsl.exe', args: ['-d', '${env:DISTRO}'] },
		});
		await configuration.updateValue('terminal.integrated.defaultProfile.windows', 'Work shell');
		const resolver = services.get(ITerminalProfileResolverService);
		const options = { os: OperatingSystem.Windows, remoteAuthority: undefined };
		const shell: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig = {};
		await resolver.resolveShellLaunchConfig(shell, options);
		assert.equal(shell.icon?.id, 'terminal-ubuntu');
		assert.deepEqual(shell.args, ['-d', 'Ubuntu-24.04']);
		const other: typeof shell = { args: ['-d', 'Debian'] };
		await resolver.resolveShellLaunchConfig(other, options);
		assert.equal(other.icon?.id, 'terminal');
		const override: typeof shell = { icon: { id: 'terminal-git-bash' } };
		await resolver.resolveShellLaunchConfig(override, options);
		assert.equal(override.icon?.id, 'terminal-git-bash');
	});

	test('shell profile and environment resolution retain a single Session directory grant', async () => {
		using owner = new DisposableStore();
		const { services, workspace, processes } = createServices(owner);
		const scope = 'session:thread%3Aone:%2Fsession-workspace';
		workspace.updateWorkspace({
			id: 'session',
			folders: [{ id: scope, uri: URI.file('/session-workspace'), name: 'session', index: 0 }],
		});
		const calls: string[] = [];
		const originalResolve = processes.resolveProfile;
		Object.assign(processes, {
			getEnvironment: async (_names: unknown, dirId: string | undefined) => {
				assert.equal(dirId, scope);
				calls.push('environment');
				return { PATH: '/session/bin' };
			},
			resolveProfile: async (selection: Parameters<typeof originalResolve>[0], dirId: string | undefined) => {
				assert.equal(dirId, scope);
				calls.push(selection.type);
				return originalResolve(selection);
			},
		});
		const resolver = services.get(ITerminalProfileResolverService);
		const options = { os: OperatingSystem.Windows, remoteAuthority: undefined };
		const shell = { executable: '/session/shell', args: ['${env:PATH}'] };
		await resolver.resolveShellLaunchConfig(shell, options);
		assert.deepEqual(shell.args, ['/session/bin']);
		assert.ok(calls.includes('custom'));
		assert.ok(calls.includes('environment'));
		await resolver.getDefaultProfile(options);
		assert.ok(calls.includes('profile'));
	});

	for (const args of ['/d /s /c "echo ${env:PROFILE_VALUE}"', ''])
		test(`Windows resolver preserves raw profile and launch arguments ${JSON.stringify(args)}`, async () => {
			using owner = new DisposableStore();
			const { services, configuration, launches } = createServices(owner, true);
			await configuration.updateValue('terminal.integrated.automationProfile.windows', {
				path: 'C:\\Windows\\cmd.exe',
				args,
			});
			const resolver = services.get(ITerminalProfileResolverService);
			const options = { os: OperatingSystem.Windows, remoteAuthority: undefined, allowAutomationShell: true };
			assert.equal(
				await resolver.getDefaultShellArgs(options),
				args.replace('${env:PROFILE_VALUE}', 'environment value'),
			);
			await configuration.updateValue('terminal.integrated.agentHostProfile.windows', {
				path: 'C:\\Windows\\cmd.exe',
				args,
			});
			assert.equal(
				await resolver.getDefaultShellArgs({
					...options,
					allowAutomationShell: false,
					allowAgentHostShell: true,
				}),
				args.replace('${env:PROFILE_VALUE}', 'environment value'),
			);
			const shell: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig = {
				executable: 'C:\\Windows\\cmd.exe',
				args,
			};
			await resolver.resolveShellLaunchConfig(shell, options);
			const terminal = await services
				.get(ITerminalService)
				.createTerminal({
					dimensions: { rows: 24, cols: 80 },
					profile: { type: 'custom', name: 'Shell', path: [shell.executable as string], args: shell.args! },
				});
			assert.deepEqual(launches[0].profile, {
				type: 'custom',
				name: 'Shell',
				path: ['C:\\Windows\\cmd.exe'],
				args: args.replace('${env:PROFILE_VALUE}', 'environment value'),
			});
			await waitFor(() => terminal.state === 'exited');
			await services.get(ITerminalService).relaunchTerminal(terminal, { rows: 30, cols: 100 });
			assert.deepEqual(launches[1].profile, launches[0].profile);
		});

	for (const os of [OperatingSystem.Linux, OperatingSystem.Macintosh])
		test(`non-Windows resolver rejects raw strings before resolving or creating a process on OS ${os}`, async () => {
			using owner = new DisposableStore();
			const { services, configuration, processes, launches } = createServices(owner, true);
			Object.assign(processes, { operatingSystem: os });
			const platform = os === OperatingSystem.Linux ? 'linux' : 'osx';
			await assert.rejects(
				configuration.updateValue(`terminal.integrated.profiles.${platform}`, {
					Shell: { path: '/bin/sh', args: '-c echo' },
				}),
			);
			await assert.rejects(
				configuration.updateValue(`terminal.integrated.automationProfile.${platform}`, {
					path: '/bin/sh',
					args: '',
				}),
			);
			await assert.rejects(
				configuration.updateValue(`terminal.integrated.agentHostProfile.${platform}`, {
					path: '/bin/sh',
					args: '-l',
				}),
			);
			const resolver = services.get(ITerminalProfileResolverService);
			for (const executable of [undefined, '/bin/sh']) {
				const shell = { executable, args: '-c "literal"' };
				await assert.rejects(
					resolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: undefined }),
					/only supported on Windows/,
				);
				assert.deepEqual(shell, { executable, args: '-c "literal"' });
			}
			assert.deepEqual(launches, []);
		});

	test('raw command line rejection uses the configured Chinese locale', async () => {
		using owner = new DisposableStore();
		const { services, processes } = createServices(owner);
		initializeTestLocalization('zh-CN');
		try {
			Object.assign(processes, { operatingSystem: OperatingSystem.Linux });
			await assert.rejects(
				services
					.get(ITerminalProfileResolverService)
					.resolveShellLaunchConfig(
						{ executable: '/bin/sh', args: '-c echo' },
						{ os: OperatingSystem.Linux, remoteAuthority: undefined },
					),
				{ message: '原始命令行字符串仅在 Windows 上受支持。' },
			);
		} finally {
			resetNlsResolver();
		}
	});

	test('extension Windows raw shell options pass through the bridge and original resolver without splitting', async () => {
		using owner = new DisposableStore();
		const { services, profiles, launches } = createServices(owner, true);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.extension', packageSha256: digest }],
			},
		});
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'runtime',
					packageDigest: digest,
					profileId: 'raw',
					title: 'Raw shell',
					invoke: async (
						operation,
					): Promise<import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue> =>
						operation === 'getTerminalEnvironment'
							? { persistent: true, map: [] }
							: {
									options: {
										name: 'Raw shell',
										shellPath: 'C:\\Windows\\cmd.exe',
										shellArgs: '/d /s /c "echo ${env:PROFILE_VALUE}"',
									},
								},
				},
			]),
		);
		await profiles.getContributedProfileProvider('acme.extension', 'raw')!.createContributedTerminalProfile({});
		assert.deepEqual(launches[0].profile, {
			type: 'custom',
			name: 'Raw shell',
			path: ['C:\\Windows\\cmd.exe'],
			args: '/d /s /c "echo environment value"',
		});
		assert.equal(services.get(ITerminalService).instances.length, 1);
	});

	test('splitting a named profile retains its original shell and raw environment after profile edits', async () => {
		using owner = new DisposableStore();
		const { services, configuration, profiles, launches } = createServices(owner, true);
		await configuration.updateValue('terminal.integrated.profiles.windows', {
			Custom: { path: '/bin/custom', args: ['--login'], env: { CUSTOM: 'original', PATH: 'original-path' } },
		});
		owner.add(
			services
				.get(IEnvironmentVariableService)
				.registerCollectionProvider('transient-provider', async () => ({
					persistent: false,
					map: new Map([['PATH', { variable: 'PATH', type: 3, value: 'prefix;' }]]),
				})),
		);
		const terminals = services.get(ITerminalService);
		const parent = await terminals.createTerminal({
			config: profiles.getAvailableProfiles().find(profile => profile.profileName === 'Custom')!,
			deferStart: true,
		});
		const original = launches.at(-1)!;
		assert.deepEqual(parent.revivalLaunch?.profile, {
			type: 'custom',
			name: 'Custom',
			path: ['/bin/custom'],
			args: ['--login'],
		});
		assert.deepEqual(parent.revivalLaunch?.env, { CUSTOM: 'original', PATH: 'original-path' });
		await configuration.updateValue('terminal.integrated.profiles.windows', {});
		await terminals.createTerminal({
			config: parent.shellLaunchConfig,
			location: { parentTerminal: parent },
			deferStart: true,
		});
		assert.deepEqual(launches.at(-1)!.profile, original.profile);
		assert.deepEqual(launches.at(-1)!.env, original.env);
		assert.equal(launches.at(-1)!.env?.PATH, 'prefix;original-path');
	});

	test('splitting a resolved low-level launch does not admit its runtime environment for persistence', async () => {
		using owner = new DisposableStore();
		const { services } = createServices(owner, true);
		const terminals = services.get(ITerminalService);
		const parent = await terminals.createTerminal({
			profile: { type: 'custom', name: 'Resolved caller', path: ['/resolved-shell'], args: [] },
			env: { RUNTIME_ONLY: 'resolved-value' },
			deferStart: true,
		});
		assert.equal(parent.revivalLaunch, undefined);
		const split = await terminals.createTerminal({
			config: parent.shellLaunchConfig,
			location: { parentTerminal: parent },
			deferStart: true,
		});
		assert.equal(split.revivalLaunch, undefined);
	});

	test('explicit running relaunch applies current extension mutations once and preserves raw launch intent', async () => {
		using owner = new DisposableStore();
		const { services, configuration, launches } = createServices(owner, true);
		await configuration.updateValue('terminal.integrated.confirmOnKill', 'never');
		const environment = services.get(IEnvironmentVariableService);
		let prefix = 'old:';
		owner.add(
			environment.registerCollectionProvider('dynamic', async () => ({
				persistent: false,
				map: new Map([['PATH', { variable: 'PATH', type: 3, value: prefix }]]),
			})),
		);
		const terminal = await services
			.get(ITerminalService)
			.createTerminal({ config: { executable: '/shell', env: { PATH: 'caller' } }, deferStart: true });
		const intent = terminal.revivalLaunch;
		assert.equal(terminal.state, 'running');
		assert.equal(launches[0]!.env!.PATH, 'old:caller');
		prefix = 'new:';
		await services.get(ITerminalService).relaunchTerminal(terminal, { rows: 31, cols: 91 });
		assert.equal(launches.length, 2);
		assert.equal(launches[1]!.env!.PATH, 'new:caller');
		assert.equal(terminal.revivalLaunch, intent);
		assert.equal(
			terminal.extEnvironmentVariableCollection!.getVariableMap(undefined).get('PATH')![0]!.value,
			'new:',
		);
		assert.equal(
			'environmentVariableCollections' in launches[1]!,
			false,
			'UI metadata does not enter the process transport',
		);
		assert.equal('environmentVariableCollectionsPersistable' in launches[1]!, false);
	});

	for (const mode of ['revive', 'reload', 'transfer'] as const)
		for (const strict of [false, true])
			test(`${mode} retains raw intent, reattaches without environment mutation and refreshes only new processes (strict=${strict})`, async () => {
				using owner = new DisposableStore();
				const first = createServices(owner, true);
				const create = first.processes.create.bind(first.processes);
				first.processes.create = async options => ({
					...(await create(options)),
					connectionPersistence: 'reconnectable',
				});
				const raw = { USER_VALUE: '${env:PROFILE_VALUE}', PATH: 'caller', REMOVED: null };
				owner.add(
					first.services
						.get(IEnvironmentVariableService)
						.registerCollectionProvider('transient-provider', async () => ({
							persistent: false,
							map: new Map([
								[
									'TRANSIENT_TOKEN',
									{ variable: 'TRANSIENT_TOKEN', type: 1, value: 'original-window-token' },
								],
								['PATH', { variable: 'PATH', type: 3, value: 'original-prefix;' }],
							]),
						})),
				);
				const terminal = await first.services
					.get(ITerminalService)
					.createTerminal({
						config: { executable: '/shell', env: raw, strictEnv: strict },
						deferStart: true,
					});
				if (mode === 'revive') {
					const split = await first.services
						.get(ITerminalService)
						.createTerminal({
							config: terminal.shellLaunchConfig,
							location: { parentTerminal: terminal },
							deferStart: true,
						});
					assert.deepEqual(
						split.shellLaunchConfig!.env,
						terminal.shellLaunchConfig!.env,
						'A split applies the current collection exactly once',
					);
					assert.deepEqual(split.revivalLaunch, terminal.revivalLaunch);
				}

				const screen = {
					raw: { options: { disableStdin: false }, cols: 80, rows: 24 },
					getRangeAsVT: async () => 'saved output',
				};
				Object.defineProperty(terminal, 'xtermReadyPromise', { value: Promise.resolve(screen) });
				const snapshot = await terminal.serializeState();
				assert.ok(snapshot.launch, 'The interactive config must retain a raw revival intent');
				assert.deepEqual(snapshot.launch.env, raw);
				assert.equal(
					snapshot.environmentVariableCollections === undefined,
					!strict,
					'Transient collections stay in memory and are not persisted',
				);
				const checkpoint = JSON.stringify({
					version: 1,
					...(mode === 'revive' ? { kind: 'revive' } : {}),
					workspaceId: first.workspace.getWorkspace().id,
					instances: [snapshot],
					groups: [],
				});
				assert.equal(checkpoint.includes('original-window-token'), false);
				assert.equal(checkpoint.includes('original-prefix;'), false);
				const lease = {
					terminalId: snapshot.process.terminalId,
					dirId: snapshot.processDirId,
					reconnectToken: 'a'.repeat(64),
					reconnectGracePeriodMillis: 30000,
				};
				const credentials = JSON.stringify({
					stateKey: 'terminal.reload.11111111-1111-1111-1111-111111111111',
					expiresAt: Date.now() + 60000,
					leases: [lease],
				});
				const second = createServices(
					owner,
					true,
					async () => {},
					mode === 'transfer'
						? undefined
						: { state: checkpoint, credentials: mode === 'reload' ? credentials : undefined },
				);
				Object.assign(second.processes, { attach: async () => snapshot.process, detach: async () => lease });
				let refreshes = 0;
				owner.add(
					second.services
						.get(IEnvironmentVariableService)
						.registerCollectionProvider('transient-provider', async () => {
							refreshes++;
							return {
								persistent: false,
								map: new Map([
									[
										'TRANSIENT_TOKEN',
										{ variable: 'TRANSIENT_TOKEN', type: 1, value: 'new-window-token' },
									],
									['PATH', { variable: 'PATH', type: 3, value: 'current-prefix;' }],
								]),
							};
						}),
				);
				await second.services.get(ITerminalService).whenConnected;
				const restored =
					mode === 'transfer'
						? await second.services.get(ITerminalService).importTerminalState(snapshot, lease)
						: second.services.get(ITerminalService).instances[0]!;
				assert.ok(restored);
				assert.equal(second.launches.length, mode === 'revive' ? 1 : 0, 'Only revival starts a new process');
				const liveEnvironment = restored.shellLaunchConfig!.env!;
				const startsNewProcess = mode === 'revive';
				assert.equal(liveEnvironment.PATH, !strict && startsNewProcess ? 'current-prefix;caller' : 'caller');
				assert.equal(
					liveEnvironment.USER_VALUE,
					!strict && startsNewProcess ? 'environment value' : '${env:PROFILE_VALUE}',
				);
				assert.equal(
					liveEnvironment.TRANSIENT_TOKEN,
					!strict && startsNewProcess ? 'new-window-token' : undefined,
				);
				assert.equal(refreshes, !strict && startsNewProcess ? 1 : 0);
				if (!startsNewProcess && !strict)
					assert.equal(
						restored.extEnvironmentVariableCollection,
						undefined,
						'The original process is retained with an unknown transient snapshot',
					);
				assert.deepEqual(restored.revivalLaunch!.env, raw);
				restored.start();
				await waitFor(() => restored.state === 'exited');
				await second.services.get(ITerminalService).relaunchTerminal(restored, { rows: 24, cols: 80 });
				assert.deepEqual(
					second.launches.at(-1)!.env,
					strict
						? { USER_VALUE: '${env:PROFILE_VALUE}', PATH: 'caller' }
						: {
								USER_VALUE: 'environment value',
								PATH: 'current-prefix;caller',
								REMOVED: null,
								TRANSIENT_TOKEN: 'new-window-token',
							},
				);
				assert.equal(refreshes, strict ? 0 : mode === 'revive' ? 2 : 1);
				await restored.reuseTerminal({
					executable: '/replacement',
					env: { REUSED: 'literal' },
					deferStart: true,
				});
				assert.equal(restored.revivalLaunch, undefined);
			});

	test('built-in runtime fingerprints bind terminal contributions by their admitted product identity', async () => {
		using owner = new DisposableStore();
		const { services, profiles, launches } = createServices(owner, true);
		const runtimeDigest = `sha256:${'b'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'ash.git', sourceKind: 'builtIn', packageSha256: `sha256:${'c'.repeat(64)}` }],
			},
		});
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceEnvironmentProviders([
			{
				runtimeId: 'ash.git',
				packageDigest: runtimeDigest,
				invoke: async () => ({ persistent: false, map: [['GIT_EDITOR', { type: 1, value: 'ash-editor' }]] }),
			},
		]);
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'ash.git',
					packageDigest: runtimeDigest,
					profileId: 'shell',
					title: 'Product shell',
					invoke: async () => ({ options: { shellPath: 'C:\\Windows\\cmd.exe' } }),
				},
			]),
		);
		await profiles.getContributedProfileProvider('ash.git', 'shell')!.createContributedTerminalProfile({});
		assert.equal(launches[0]!.env?.GIT_EDITOR, 'ash-editor');
		bridge.replaceEnvironmentProviders([]);
		await services.get(IEnvironmentVariableService).refreshCollections();
		assert.equal(services.get(IEnvironmentVariableService).collections.has('ash.git'), false);
		bridge.replaceProfiles([]);
		assert.throws(
			() =>
				bridge.replaceEnvironmentProviders([
					{ runtimeId: 'other.product', packageDigest: runtimeDigest, invoke: async () => null },
				]),
			/Invalid terminal profile/,
		);
	});

	for (const sourceKind of ['user', 'plugin', 'registry'])
		test(`external ${sourceKind} terminal contributions reject a mismatched package digest even for the same ID`, () => {
			using owner = new DisposableStore();
			const { services } = createServices(owner);
			Object.assign(services.get(IExtensionService), {
				currentCatalog: {
					generation: 1,
					diagnostics: [],
					extensions: [{ id: 'acme.extension', sourceKind, packageSha256: `sha256:${'b'.repeat(64)}` }],
				},
			});
			const bridge = owner.add(services.createInstance(MainThreadTerminalService));
			const descriptor = {
				runtimeId: 'acme.extension',
				packageDigest: `sha256:${'a'.repeat(64)}`,
				invoke: async () => null,
			};
			assert.throws(() => bridge.replaceEnvironmentProviders([descriptor]), /Invalid terminal profile/);
			assert.throws(
				() =>
					bridge.replaceProfiles(
						withPtyResources([{ ...descriptor, profileId: 'shell', title: 'External shell' }]),
					),
				/provider is unavailable/,
			);
		});

	test('extension environment snapshots reach the process through the original profile creation entry', async () => {
		using owner = new DisposableStore();
		const { services, profiles, launches } = createServices(owner, true);
		const digest = `sha256:${'b'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.environment', packageSha256: digest }],
			},
		});
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceEnvironmentProviders([
			{
				runtimeId: 'environment',
				packageDigest: digest,
				invoke: async () => ({
					persistent: false,
					map: [
						['PATH', { type: 2, value: ';${env:PROFILE_VALUE}' }],
						['MODE', { type: 1, value: 'extension' }],
						[
							'scoped:PATH',
							{
								variable: 'PATH',
								type: 2,
								value: ';scoped',
								scope: {
									workspaceFolder: {
										uri: { scheme: 'file', path: '/workspace' },
										name: 'workspace',
										index: 0,
									},
								},
							},
						],
						[
							'other:MODE',
							{
								variable: 'MODE',
								type: 1,
								value: 'wrong workspace',
								scope: {
									workspaceFolder: {
										uri: { scheme: 'file', path: '/other' },
										name: 'other',
										index: 1,
									},
								},
							},
						],
					],
				}),
			},
		]);
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'profile',
					packageDigest: digest,
					profileId: 'shell',
					title: 'Extension shell',
					invoke: async () => ({
						options: { shellPath: 'C:\\Windows\\cmd.exe', env: { Path: 'caller', REMOVED: null } },
					}),
				},
			]),
		);
		await profiles.getContributedProfileProvider('acme.environment', 'shell')!.createContributedTerminalProfile({});
		assert.deepEqual(launches[0]!.env, {
			Path: 'caller;environment value;scoped',
			REMOVED: null,
			MODE: 'extension',
		});
		assert.equal(services.get(ITerminalService).instances.length, 1);
	});

	test('strict extension profile environment stays literal and bypasses configured and extension mutations', async () => {
		using owner = new DisposableStore();
		const { services, profiles, launches, workspace, configuration } = createServices(owner, true);
		workspace.updateWorkspace({
			id: 'unc',
			uri: URI.from({ scheme: 'file', authority: 'server', path: '/share' }),
		});
		await configuration.updateValue('terminal.integrated.env.windows', { CONFIGURED: 'value', Path: 'configured' });
		let strict: import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue = true;
		const digest = `sha256:${'b'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.environment', packageSha256: digest }],
			},
		});
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceEnvironmentProviders([
			{
				runtimeId: 'environment',
				packageDigest: digest,
				invoke: async () => ({
					persistent: false,
					map: [
						['PATH', { type: 2, value: ';${env:PROFILE_VALUE}' }],
						['MODE', { type: 1, value: 'extension' }],
						[
							'scoped:PATH',
							{
								variable: 'PATH',
								type: 2,
								value: ';scoped',
								scope: {
									workspaceFolder: {
										uri: { scheme: 'file', path: '/workspace' },
										name: 'workspace',
										index: 0,
									},
								},
							},
						],
						[
							'other:MODE',
							{
								variable: 'MODE',
								type: 1,
								value: 'wrong workspace',
								scope: {
									workspaceFolder: {
										uri: { scheme: 'file', path: '/other' },
										name: 'other',
										index: 1,
									},
								},
							},
						],
					],
				}),
			},
		]);
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'profile',
					packageDigest: digest,
					profileId: 'shell',
					title: 'Extension shell',
					invoke: async () => ({
						options: {
							shellPath: 'C:\\Windows\\cmd.exe',
							strictEnv: strict,
							env: { Path: '${env:PROFILE_VALUE}', REMOVED: null },
						},
					}),
				},
			]),
		);
		await profiles.getContributedProfileProvider('acme.environment', 'shell')!.createContributedTerminalProfile({});
		assert.deepEqual(launches[0]!.env, { Path: '${env:PROFILE_VALUE}' });
		assert.equal(launches[0]!.strictEnv, true);
		assert.equal(services.get(ITerminalService).instances.length, 1);
		strict = 'true';
		await assert.rejects(
			profiles.getContributedProfileProvider('acme.environment', 'shell')!.createContributedTerminalProfile({}),
		);
		assert.equal(launches.length, 1);
	});

	test('an extension shell phase reaches the original process create request without changing its process value', async () => {
		using owner = new DisposableStore();
		const { services, profiles, launches } = createServices(owner, true);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.environment', packageSha256: digest }],
			},
		});
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceEnvironmentProviders([
			{
				runtimeId: 'environment',
				packageDigest: digest,
				invoke: async () => ({
					persistent: true,
					map: [
						[
							'STAGE',
							{
								variable: 'STAGE',
								type: 2,
								value: ':${env:PROFILE_VALUE}',
								options: { applyAtProcessCreation: false, applyAtShellIntegration: true },
							},
						],
					],
					descriptionMap: [],
				}),
			},
		]);
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'profile',
					packageDigest: digest,
					profileId: 'shell',
					title: 'Extension shell',
					invoke: async () => ({ options: { shellPath: '/extension/shell', env: { STAGE: 'process' } } }),
				},
			]),
		);
		await profiles.getContributedProfileProvider('acme.environment', 'shell')!.createContributedTerminalProfile({});
		assert.deepEqual(launches[0]!.env, { STAGE: 'process', VSCODE_ENV_APPEND: 'STAGE=\\x3aenvironment value' });
	});

	test('resolver cancels a late environment result without partially changing launch data', async () => {
		using owner = new DisposableStore();
		const { services, processes, connection } = createServices(owner);
		let release!: (env: Readonly<Record<string, string>>) => void;
		Object.assign(processes, {
			getEnvironment: () =>
				new Promise(resolve => {
					release = resolve;
				}),
		});
		const shell = {
			name: 'Original',
			executable: '/original/shell',
			args: ['original'],
			env: { ORIGINAL: 'value' },
		};
		const pending = services
			.get(ITerminalProfileResolverService)
			.resolveShellLaunchConfig(shell, { os: OperatingSystem.Windows, remoteAuthority: undefined });
		const cancelled = assert.rejects(pending, isCancellationError);
		while (!release) await new Promise(resolve => setTimeout(resolve, 0));
		connection.fire('crashed');
		release({ HOME: '/late' });
		await cancelled;
		assert.deepEqual(shell, {
			name: 'Original',
			executable: '/original/shell',
			args: ['original'],
			env: { ORIGINAL: 'value' },
		});
	});

	test('extension defaults use the registered provider and disposable overrides restore selection', async () => {
		using owner = new DisposableStore();
		const { services, profiles, configuration } = createServices(owner);
		owner.add(
			profiles.registerInternalContributedProfile({
				extensionIdentifier: 'acme.extension',
				id: 'first',
				title: 'Extension first',
			}),
		);
		owner.add(
			profiles.registerInternalContributedProfile({
				extensionIdentifier: 'acme.extension',
				id: 'second',
				title: 'Extension second',
			}),
		);
		await profiles.registerContributedProfile({
			extensionIdentifier: 'acme.extension',
			id: 'first',
			title: 'Extension first',
			options: {},
		});
		await configuration.updateValue('terminal.integrated.defaultProfile.windows', 'Extension first');
		assert.equal((await profiles.getContributedDefaultProfile({}))?.id, 'first');
		assert.equal(await profiles.getContributedDefaultProfile({ executable: '/explicit' }), undefined);
		using override = profiles.overrideDefaultProfile('acme.extension', 'second');
		assert.equal((await profiles.getContributedDefaultProfile({}))?.id, 'second');
		override.dispose();
		assert.equal((await profiles.getContributedDefaultProfile({}))?.id, 'first');
		let calls = 0;
		Object.assign(services.get(IExtensionService), {
			activateByEvent: async (event: string) => {
				assert.equal(event, 'onTerminalProfile:first');
				owner.add(
					profiles.registerTerminalProfileProvider('acme.extension', 'first', {
						createContributedTerminalProfile: async () => {
							calls++;
							return undefined;
						},
					}),
				);
			},
		});
		await profiles.getContributedProfileProvider('acme.extension', 'first')!.createContributedTerminalProfile({});
		assert.equal(calls, 1);
	});

	for (const custom of [false, true])
		test(`background extension ${custom ? 'PTY' : 'shell'} creation preserves user selection throughout provider completion`, async () => {
			using owner = new DisposableStore();
			const opened: number[] = [];
			const { services, profiles } = createServices(owner, true, async input => {
				opened.push(
					(input as import('../../browser/terminalEditorInput.js').TerminalEditorInput).terminalInstance!
						.instanceId,
				);
			});
			const terminals = services.get(ITerminalService);
			const original = await terminals.createTerminal({ profile: { type: 'default' }, deferStart: true });
			const selected = await terminals.createTerminal({ profile: { type: 'default' }, deferStart: true });
			terminals.setActiveInstance(original);
			const changes: string[] = [];
			owner.add(
				terminals.onDidChangeActiveInstance(instance => {
					if (instance) changes.push(instance.id);
				}),
			);
			const entered = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			const digest = `sha256:${'a'.repeat(64)}`;
			Object.assign(services.get(IExtensionService), {
				currentCatalog: {
					generation: 1,
					diagnostics: [],
					extensions: [{ id: 'acme.extension', packageSha256: digest }],
				},
			});
			const bridge = owner.add(services.createInstance(MainThreadTerminalService));
			bridge.replaceProfiles(
				withPtyResources([
					{
						runtimeId: 'background-runtime',
						packageDigest: digest,
						profileId: 'background',
						title: 'Background',
						invoke: async (
							operation,
						): Promise<
							import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue
						> => {
							if (operation === 'createTerminalProfile') {
								await entered.complete();
								await release.p;
								return custom
									? {
											options: { name: 'Background' },
											pty: {
												ptyId: 'background-pty',
												registrationId: 'resource.background',
												acceptsInput: true,
											},
										}
									: { options: { name: 'Background', shellPath: '/extension/shell' } };
							}
							return { events: [] };
						},
					},
				]),
			);
			const pending = terminals.createTerminal({
				config: profiles.contributedProfiles[0]!,
				location: { preserveFocus: true },
			});
			try {
				await entered.p;
				terminals.setActiveInstance(selected);
				await release.complete();
				const background = await pending;
				assert.equal(terminals.activeInstance, selected);
				assert.deepEqual(changes, [selected.id]);
				assert.deepEqual(opened, [background.instanceId]);
				assert.equal(background.target, TerminalLocation.Editor);
			} finally {
				await release.complete();
				await Promise.allSettled([pending]);
			}
		});

	test('concurrent contributed profiles return and place their own instances despite focus changes', async () => {
		using owner = new DisposableStore();
		const opened: number[] = [];
		const { services, profiles } = createServices(owner, true, async input => {
			opened.push(
				(input as import('../../browser/terminalEditorInput.js').TerminalEditorInput).terminalInstance!
					.instanceId,
			);
		});
		const terminals = services.get(ITerminalService);
		const created = [new DeferredPromise<number>(), new DeferredPromise<number>()];
		const release = [new DeferredPromise<void>(), new DeferredPromise<void>()];
		let calls = 0;
		owner.add(
			profiles.registerInternalContributedProfile({
				extensionIdentifier: 'acme.extension',
				id: 'concurrent',
				title: 'Concurrent',
			}),
		);
		owner.add(
			profiles.registerTerminalProfileProvider('acme.extension', 'concurrent', {
				createContributedTerminalProfile: async () => {
					const index = calls++;
					const instance = await terminals.createTerminal({ profile: { type: 'default' }, deferStart: true });
					await created[index]!.complete(instance.instanceId);
					await release[index]!.p;
					return instance.instanceId;
				},
			}),
		);
		const config = profiles.contributedProfiles[0]!;
		const first = terminals.createTerminal({ config, location: TerminalLocation.Editor });
		let second: ReturnType<typeof terminals.createTerminal> | undefined;
		try {
			const firstId = await created[0]!.p;
			second = terminals.createTerminal({ config });
			const secondId = await created[1]!.p;
			terminals.setActiveInstance(terminals.instances.find(instance => instance.instanceId === firstId)!);
			await release[1]!.complete();
			assert.equal((await second).instanceId, secondId);
			terminals.setActiveInstance(terminals.instances.find(instance => instance.instanceId === secondId)!);
			await release[0]!.complete();
			assert.equal((await first).instanceId, firstId);
			assert.deepEqual(opened, [firstId]);
			assert.deepEqual(
				terminals.instances.map(instance => instance.instanceId),
				[firstId, secondId],
			);
		} finally {
			for (const pending of release) await pending.complete();
			await Promise.allSettled(second ? [first, second] : [first]);
		}
	});

	for (const custom of [false, true])
		test(`background contributed ${custom ? 'PTY' : 'shell'} preserves the user's input target throughout provider creation`, async () => {
			using owner = new DisposableStore();
			const opened: unknown[] = [];
			const { services, profiles } = createServices(owner, true, async (_input, options) => {
				opened.push(options);
			});
			const terminals = services.get(ITerminalService);
			const original = await terminals.createTerminal({ profile: { type: 'default' }, deferStart: true });
			const digest = `sha256:${'a'.repeat(64)}`;
			Object.assign(services.get(IExtensionService), {
				currentCatalog: {
					generation: 1,
					diagnostics: [],
					extensions: [{ id: 'acme.extension', packageSha256: digest }],
				},
			});
			const requested = new DeferredPromise<void>();
			const reply = new DeferredPromise<
				import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue
			>();
			const bridge = owner.add(services.createInstance(MainThreadTerminalService));
			bridge.replaceProfiles(
				withPtyResources([
					{
						runtimeId: 'runtime',
						packageDigest: digest,
						profileId: 'background',
						title: 'Background extension',
						invoke: async operation => {
							if (operation === 'createTerminalProfile') {
								await requested.complete();
								return reply.p;
							}
							if (operation === 'closeTaskTerminal') return null;
							return { events: [] };
						},
					},
				]),
			);
			const changes: (number | undefined)[] = [];
			owner.add(terminals.onDidChangeActiveInstance(instance => changes.push(instance?.instanceId)));
			const pending = terminals.createTerminal({
				config: profiles.contributedProfiles[0]!,
				location: { preserveFocus: true },
			});
			await requested.p;
			assert.equal(terminals.activeInstance, original);
			const selected = await terminals.createTerminal({ profile: { type: 'default' }, deferStart: true });
			await reply.complete(
				custom
					? {
							options: { name: 'Background PTY' },
							pty: { ptyId: 'background-pty', registrationId: 'resource.background', acceptsInput: true },
						}
					: { options: { name: 'Background shell', shellPath: '/extension/shell' } },
			);
			const background = await pending;
			assert.equal(background.target, TerminalLocation.Editor);
			assert.equal(terminals.activeInstance, selected);
			assert.deepEqual(changes, [selected.instanceId]);
			assert.equal(opened.length, 1);
			for (const options of opened) assert.equal((options as { preserveFocus?: boolean }).preserveFocus, true);
			await terminals.closeTerminal(background);
			bridge.replaceProfiles([]);
		});

	for (const failure of ['workspace', 'wrongRoot'] as const)
		test(`contributed profile releases its created instance after ${failure} cancellation`, async () => {
			using owner = new DisposableStore();
			const { services, profiles, workspace } = createServices(owner, true);
			const terminals = services.get(ITerminalService);
			const folder = workspace.getWorkspace().folders[0]!;
			workspace.updateWorkspace({
				id: 'multi',
				configuration: URI.file('/team.ash-workspace'),
				folders: [folder, { id: 'other', index: 1, name: 'other', uri: URI.file('/other') }],
			});
			const unrelated = await terminals.createTerminal({
				profile: { type: 'default' },
				dirId: folder.id,
				deferStart: true,
			});
			let createdId: number | undefined;
			owner.add(
				profiles.registerInternalContributedProfile({
					extensionIdentifier: 'acme.extension',
					id: 'cancel',
					title: 'Cancel',
				}),
			);
			owner.add(
				profiles.registerTerminalProfileProvider('acme.extension', 'cancel', {
					createContributedTerminalProfile: async () => {
						const instance = await terminals.createTerminal({
							profile: { type: 'default' },
							dirId: failure === 'wrongRoot' ? 'other' : folder.id,
							deferStart: true,
						});
						createdId = instance.instanceId;
						terminals.setActiveInstance(unrelated);
						if (failure === 'workspace')
							workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/elsewhere') });
						return instance.instanceId;
					},
				}),
			);
			await assert.rejects(
				terminals.createTerminal({ config: profiles.contributedProfiles[0]!, dirId: folder.id }),
				isCancellationError,
			);
			assert.ok(createdId);
			assert.deepEqual(
				terminals.instances.map(instance => instance.instanceId),
				[unrelated.instanceId],
			);
		});

	for (const custom of [false, true])
		test(`extension profile bridge creates ${custom ? 'a live Pseudoterminal' : 'an execution-host shell'} and withdraws its registration`, async () => {
			using owner = new DisposableStore();
			const { services, profiles } = createServices(owner);
			const digest = `sha256:${'a'.repeat(64)}`;
			Object.assign(services.get(IExtensionService), {
				currentCatalog: {
					generation: 1,
					diagnostics: [],
					extensions: [
						{
							id: 'acme.extension',
							name: 'extension',
							publisher: 'acme',
							version: '1.0.0',
							displayName: 'Extension',
							sourceKind: 'user',
							manifestSha256: digest,
							packageSha256: digest,
						},
					],
				},
			});
			const launches: import('../../browser/terminal.js').ITerminalCreateOptions[] = [];
			const writes: string[] = [];
			const exits: (number | undefined)[] = [];
			let child: import('../../../../../platform/terminal/common/terminal.js').ITerminalChildProcess | undefined;
			Object.assign(services.get(ITerminalService), {
				createTerminal: async (options: import('../../browser/terminal.js').ITerminalCreateOptions) => {
					launches.push(options);
					if (options.config?.customPtyImplementation) {
						child = owner.add(options.config.customPtyImplementation(1, 80, 24));
						owner.add(
							child.onProcessData(data => {
								assert(typeof data === 'string');
								writes.push(data);
							}),
						);
						owner.add(child.onProcessExit(code => exits.push(code)));
						await child.start();
					}
					return { instanceId: 73 };
				},
			});
			const operations: string[] = [];
			const invoke: import('../../../../api/browser/extensionHostLanguageBridge.js').ExtensionHostProviderInvoker =
				async (
					operation,
					payload,
					signal,
				): Promise<import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue> => {
					signal.throwIfAborted();
					operations.push(operation);
					if (operation === 'getTerminalEnvironment') return { persistent: true, map: [] };
					if (operation === 'createTerminalProfile')
						return custom
							? {
									options: { name: 'Extension PTY' },
									pty: { ptyId: 'pty.1', registrationId: 'resource.1', acceptsInput: true },
								}
							: {
									options: {
										name: 'Extension shell',
										shellPath: '/extension/shell',
										shellArgs: ['literal argument'],
										env: { PROFILE: 'value' },
									},
								};
					if (operation === 'openTaskTerminal')
						return { events: [{ type: 'data', data: 'synchronous open output' }] };
					if (operation === 'inputTaskTerminal')
						return { events: [{ type: 'data', data: `echo:${(payload as { data: string }).data}` }] };
					if (operation === 'closeTaskTerminal') return null;
					return { events: [] };
				};
			const bridge = owner.add(services.createInstance(MainThreadTerminalService));
			const descriptor = {
				runtimeId: 'runtime',
				packageDigest: digest,
				profileId: 'test',
				title: 'Extension test',
				invoke,
			};
			bridge.replaceProfiles(withPtyResources([descriptor]));
			bridge.replaceProfiles(withPtyResources([descriptor]));
			assert.equal(
				await profiles
					.getContributedProfileProvider('acme.extension', 'test')!
					.createContributedTerminalProfile({}),
				73,
			);
			assert.equal(launches.length, 1);
			if (custom) {
				assert.deepEqual(writes, ['synchronous open output']);
				const echoed = new Promise<void>(resolve => {
					const listener = owner.add(
						child!.onProcessData(data => {
							if (data === 'echo:typed') {
								listener.dispose();
								resolve();
							}
						}),
					);
				});
				child!.input!('typed');
				await echoed;
				assert.deepEqual(writes, ['synchronous open output', 'echo:typed']);
				child!.dispose();
				child = owner.add(launches[0]!.config!.customPtyImplementation(1, 100, 30));
				owner.add(
					child.onProcessData(data => {
						assert(typeof data === 'string');
						writes.push(data);
					}),
				);
				owner.add(child.onProcessExit(code => exits.push(code)));
				await child.start();
				assert.equal(operations.filter(operation => operation === 'createTerminalProfile').length, 2);
				assert.deepEqual(writes, ['synchronous open output', 'echo:typed', 'synchronous open output']);
			} else
				assert.deepEqual(launches[0]!.config, {
					name: 'Extension shell',
					executable: '/extension/shell',
					args: ['literal argument'],
					cwd: undefined,
					env: { PROFILE: 'value' },
					strictEnv: undefined,
					icon: undefined,
					color: undefined,
				});
			bridge.replaceProfiles([]);
			assert.equal(profiles.getContributedProfileProvider('acme.extension', 'test'), undefined);
			if (custom) {
				assert.deepEqual(exits, [undefined], 'Withdrawing the factory preserves its already issued PTY');
				await child!.input!('after withdrawal');
				assert.equal(operations.filter(operation => operation === 'closeTaskTerminal').length, 1);
				bridge.clearPtys();
				assert.deepEqual(exits, [undefined, undefined]);
				assert.equal(operations.filter(operation => operation === 'closeTaskTerminal').length, 2);
			}
		});

	for (const custom of [false, true])
		for (const uriCwd of [false, true])
			test(`contributed ${custom ? 'PTY' : 'shell'} creation keeps its selected root from ${uriCwd ? 'URI' : 'path'} cwd through the shared owner`, async () => {
				using owner = new DisposableStore();
				const { services, workspace, profiles, launches } = createServices(
					owner,
					true,
					async () => {},
					undefined,
					OperatingSystem.Linux,
				);
				const folders = [
					{ id: 'one', name: 'one', uri: URI.file('/workspace'), index: 0 },
					{ id: 'two', name: 'two', uri: URI.file('/second'), index: 1 },
				];
				workspace.updateWorkspace({
					id: 'multi-root',
					configuration: URI.file('/team.ash-workspace'),
					folders,
				});
				const digest = `sha256:${'a'.repeat(64)}`;
				Object.assign(services.get(IExtensionService), {
					currentCatalog: {
						generation: 1,
						diagnostics: [],
						extensions: [{ id: 'acme.extension', packageSha256: digest }],
					},
				});
				const operations: string[] = [];
				const bridge = owner.add(services.createInstance(MainThreadTerminalService));
				bridge.replaceProfiles(
					withPtyResources([
						{
							runtimeId: 'runtime',
							packageDigest: digest,
							profileId: 'selected',
							title: 'Selected extension',
							invoke: async (
								operation,
							): Promise<
								import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue
							> => {
								operations.push(operation);
								if (operation === 'createTerminalProfile')
									return custom
										? {
												options: { name: 'Selected extension' },
												pty: {
													ptyId: 'selected-pty',
													registrationId: 'resource.selected',
													acceptsInput: true,
												},
											}
										: {
												options: {
													name: 'Selected extension',
													shellPath: '/extension/shell',
													env: { ROOT: '${workspaceFolder}' },
												},
											};
								if (operation === 'closeTaskTerminal') return null;
								return { events: [] };
							},
						},
					]),
				);
				const terminals = services.get(ITerminalService);
				// This fixture executes on Linux, regardless of the test runner's OS.
				const cwd = '/second';
				const instance = await terminals.createTerminal({
					cwd: uriCwd ? folders[1]!.uri : cwd,
					config: profiles.contributedProfiles[0]!,
				});
				assert.equal(instance.dirId, 'two');
				assert.equal(terminals.instances.length, 1);
				assert.equal(terminals.activeInstance, instance);
				if (!custom) {
					assert.equal(launches[0]!.dirId, 'two');
					assert.equal(launches[0]!.env?.ROOT, '/second');
					assert.equal(launches[0]!.cwd, cwd);
				}
				await terminals.closeTerminal(instance);
				assert.deepEqual(terminals.instances, []);
				bridge.replaceProfiles([]);
				if (custom)
					await waitFor(() => operations.filter(operation => operation === 'closeTaskTerminal').length === 1);
			});

	for (const custom of [false, true])
		test(`shared terminal contracts connect an extension ${custom ? 'PTY' : 'shell'} to the original instance and release owners`, async () => {
			using owner = new DisposableStore();
			const { services, configuration, profiles, launches, closed } = createServices(owner, true);
			const terminals = services.get(ITerminalService);
			const digest = `sha256:${'a'.repeat(64)}`;
			Object.assign(services.get(IExtensionService), {
				currentCatalog: {
					generation: 1,
					diagnostics: [],
					extensions: [{ id: 'acme.extension', packageSha256: digest }],
				},
			});
			await configuration.updateValue('terminal.integrated.env.windows', {
				GLOBAL: 'global',
				REMOVED: 'remove me',
			});
			const output: string[] = [];
			const exits: (number | undefined)[] = [];
			owner.add(
				terminals.onDidCreateInstance(instance => {
					owner.add(instance.onDidWriteData(event => output.push(event.data)));
					owner.add(instance.onDidExit(code => exits.push(code)));
				}),
			);
			const operations: { operation: string; payload: unknown }[] = [];
			let nextPty = 0;
			const bridge = owner.add(services.createInstance(MainThreadTerminalService));
			bridge.replaceProfiles(
				withPtyResources([
					{
						runtimeId: 'runtime',
						packageDigest: digest,
						profileId: 'test',
						title: 'Extension',
						invoke: async (
							operation,
							payload,
							signal,
						): Promise<
							import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue
						> => {
							signal.throwIfAborted();
							operations.push({ operation, payload });
							if (operation === 'getTerminalEnvironment') return { persistent: true, map: [] };
							if (operation === 'createTerminalProfile')
								return custom
									? {
											options: { name: 'Extension PTY' },
											pty: {
												ptyId: `pty.${++nextPty}`,
												registrationId: `resource.${nextPty}`,
												acceptsInput: true,
											},
										}
									: {
											options: {
												name: 'Extension shell',
												shellPath: '/extension/shell',
												shellArgs: ['${env:PROFILE_VALUE}'],
												cwd: '${workspaceFolder}/run',
												env: { CALLER: '${env:PROFILE_VALUE}', REMOVED: null },
											},
										};
							if (operation === 'openTaskTerminal')
								return {
									events: [
										{ type: 'data', data: 'PTY output' },
										{ type: 'close', code: 0 },
									],
								};
							assert.equal(operation, 'closeTaskTerminal');
							return null;
						},
					},
				]),
			);
			await profiles
				.getContributedProfileProvider('acme.extension', 'test')!
				.createContributedTerminalProfile({});
			const instance = terminals.activeInstance!;
			assert.equal(terminals.instances[0], instance);
			await waitFor(() => instance.state === 'exited');
			assert.deepEqual(output, [custom ? 'PTY output' : 'shell output']);
			assert.deepEqual(exits, [0]);
			assert.equal(instance.title, custom ? 'Extension PTY' : 'Extension shell');
			if (custom) {
				assert.deepEqual(launches, []);
				await terminals.relaunchTerminal(instance, { cols: 100, rows: 30 });
				await waitFor(() => output.length === 2 && instance.state === 'exited');
				assert.equal(terminals.instances.length, 1);
				assert.equal(terminals.activeInstance, instance);
				assert.deepEqual(output, ['PTY output', 'PTY output']);
				assert.deepEqual(exits, [0, 0]);
				assert.deepEqual(
					operations.filter(value => value.operation === 'closeTaskTerminal').map(value => value.payload),
					[{ ptyId: 'pty.1' }, { ptyId: 'pty.2' }],
				);
			} else {
				assert.deepEqual(launches, [
					{
						dirId: 'test',
						rows: 24,
						cols: 80,
						profile: {
							type: 'custom',
							name: 'Extension shell',
							path: ['/extension/shell'],
							args: ['environment value'],
						},
						env: { GLOBAL: 'global', REMOVED: null, CALLER: 'environment value' },
						cwd: '/workspace/run',
					},
				]);
			}
			bridge.replaceProfiles([]);
			assert.equal(profiles.getContributedProfileProvider('acme.extension', 'test'), undefined);
			await terminals.closeTerminal(instance);
			assert.deepEqual(terminals.instances, []);
			assert.deepEqual(closed, custom ? [] : [{ dirId: 'test', terminalId: 'process-1' }]);
		});

	test('extension profile releases its issued resource when terminal creation fails before process ownership', async () => {
		using owner = new DisposableStore();
		const { services, profiles } = createServices(owner);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.extension', packageSha256: digest }],
			},
		});
		const failure = new Error('Terminal target disappeared');
		Object.assign(services.get(ITerminalService), {
			createTerminal: async () => {
				throw failure;
			},
		});
		const closed: unknown[] = [];
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'runtime',
					packageDigest: digest,
					profileId: 'pty',
					title: 'PTY',
					invoke: async (operation, payload) => {
						if (operation === 'createTerminalProfile')
							return {
								options: { name: 'Issued PTY' },
								pty: { ptyId: 'pty.1', registrationId: 'resource.1', acceptsInput: true },
							};
						assert.equal(operation, 'closeTaskTerminal');
						closed.push(payload);
						return null;
					},
				},
			]),
		);
		await assert.rejects(
			profiles.getContributedProfileProvider('acme.extension', 'pty')!.createContributedTerminalProfile({}),
			error => error === failure,
		);
		assert.deepEqual(closed, [{ ptyId: 'pty.1' }]);
	});

	for (const malformed of ['name', 'options', 'inputFlag'] as const)
		test(`extension profile releases its issued PTY after rejecting ${malformed}`, async () => {
			using owner = new DisposableStore();
			const { services, profiles } = createServices(owner);
			const digest = `sha256:${'a'.repeat(64)}`;
			Object.assign(services.get(IExtensionService), {
				currentCatalog: {
					generation: 1,
					diagnostics: [],
					extensions: [{ id: 'acme.extension', packageSha256: digest }],
				},
			});
			Object.assign(services.get(ITerminalService), {
				createTerminal: async () => assert.fail('Rejected profile created a terminal'),
			});
			const closed: unknown[] = [];
			const bridge = owner.add(services.createInstance(MainThreadTerminalService));
			bridge.replaceProfiles(
				withPtyResources([
					{
						runtimeId: 'runtime',
						packageDigest: digest,
						profileId: 'pty',
						title: 'PTY',
						invoke: async (
							operation,
							payload,
						): Promise<
							import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue
						> => {
							if (operation === 'createTerminalProfile')
								return {
									options:
										malformed === 'name'
											? { name: 'x'.repeat(257) }
											: malformed === 'options'
												? { unknown: true }
												: { name: 'PTY' },
									pty: {
										ptyId: 'pty.1',
										registrationId: 'resource.1',
										acceptsInput: malformed === 'inputFlag' ? 'invalid' : true,
									},
								};
							assert.equal(operation, 'closeTaskTerminal');
							closed.push(payload);
							return null;
						},
					},
				]),
			);
			await assert.rejects(
				profiles.getContributedProfileProvider('acme.extension', 'pty')!.createContributedTerminalProfile({}),
				TypeError,
			);
			assert.deepEqual(closed, [{ ptyId: 'pty.1' }]);
		});

	test('extension profile abandons a late PTY result after the workspace changes', async () => {
		using owner = new DisposableStore();
		const { services, profiles, workspace } = createServices(owner);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.extension', packageSha256: digest }],
			},
		});
		Object.assign(services.get(ITerminalService), {
			createTerminal: async () => assert.fail('Stale profile created a terminal'),
		});
		let release!: (value: import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue) => void;
		const closed: unknown[] = [];
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'runtime',
					packageDigest: digest,
					profileId: 'pty',
					title: 'PTY',
					invoke: async (operation, payload) => {
						if (operation === 'createTerminalProfile')
							return new Promise(resolve => {
								release = resolve;
							});
						assert.equal(operation, 'closeTaskTerminal');
						closed.push(payload);
						return null;
					},
				},
			]),
		);
		const cancelled = assert.rejects(
			profiles.getContributedProfileProvider('acme.extension', 'pty')!.createContributedTerminalProfile({}),
			isCancellationError,
		);
		while (!release) await new Promise(resolve => setTimeout(resolve, 0));
		workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		release({
			options: { name: 'Late PTY' },
			pty: { ptyId: 'pty.1', registrationId: 'resource.1', acceptsInput: true },
		});
		await cancelled;
		assert.deepEqual(closed, [{ ptyId: 'pty.1' }]);
	});

	test('removing an extension profile cancels its pending callback and closes a late PTY', async () => {
		using owner = new DisposableStore();
		const { services, profiles } = createServices(owner);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.extension', packageSha256: digest }],
			},
		});
		let release!: (value: import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue) => void;
		let signal: AbortSignal | undefined;
		const closed: unknown[] = [];
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles(
			withPtyResources([
				{
					runtimeId: 'runtime',
					packageDigest: digest,
					profileId: 'pty',
					title: 'PTY',
					invoke: async (operation, payload, cancellation) => {
						if (operation === 'createTerminalProfile') {
							signal = cancellation;
							return new Promise(resolve => {
								release = resolve;
							});
						}
						assert.equal(operation, 'closeTaskTerminal');
						assert.equal(cancellation?.aborted, false);
						closed.push(payload);
						return null;
					},
				},
			]),
		);
		const cancelled = assert.rejects(
			profiles.getContributedProfileProvider('acme.extension', 'pty')!.createContributedTerminalProfile({}),
			isCancellationError,
		);
		while (!release) await new Promise(resolve => setTimeout(resolve, 0));
		bridge.replaceProfiles([]);
		await cancelled;
		assert.equal(signal?.aborted, true);
		release({
			options: { name: 'Late PTY' },
			pty: { ptyId: 'pty.1', registrationId: 'resource.1', acceptsInput: true },
		});
		await waitFor(() => closed.length === 1);
		assert.deepEqual(closed, [{ ptyId: 'pty.1' }]);
	});
});

suite('Extension terminal ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('output is bounded and handles cannot cross activation fences', async () => {
		using owner = new DisposableStore();
		const parent = createServices(owner).services;
		const services = owner.add(parent.createChild());
		const output = owner.add(new Emitter<{ data: string }>());
		const exit = owner.add(new Emitter<number | undefined>());
		let closes = 0;
		let createdEnvironment: unknown;
		const terminal = {
			state: 'running',
			onDidWriteData: output.event,
			onDidExit: exit.event,
		} as unknown as ITerminalInstance;
		services.registerInstance(ITerminalService, {
			createTerminal: async (options: { env?: unknown }) => {
				createdEnvironment = options.env;
				return terminal;
			},
			setActiveInstance: () => {},
			onDidDisposeInstance: Event.None,
			closeTerminal: async () => {
				closes++;
			},
		} as unknown as ITerminalService);
		services.registerInstance(ITerminalGroupService, {
			showPanel: async () => {},
		} as unknown as import('../../browser/terminal.js').ITerminalGroupService);
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		const source = { extensionId: 'acme.debug', activationGeneration: 1, incarnation: 2 };
		const signal = new AbortController().signal;
		const created = await bridge.handle(
			{
				operation: 'createTerminal',
				name: 'Debug',
				cwd: null,
				env: { NODE_OPTIONS: '--no-warnings' },
				appendEnv: { NODE_OPTIONS: ' --require=debug.cjs' },
				command: null,
			},
			signal,
			source,
		);
		assert.equal(created.result, 'value');
		assert.equal((createdEnvironment as Record<string, string>).NODE_OPTIONS, '--no-warnings --require=debug.cjs');
		const id = (created as unknown as { value: { id: string } }).value.id;
		output.fire({ data: 'x'.repeat(100_000) });
		const result = await bridge.handle(
			{ operation: 'readTerminal', terminalId: id, afterSequence: 0 },
			signal,
			source,
		);
		assert.equal(result.result, 'value');
		const value = (result as unknown as { value: { output: string; outputGap: boolean; closed: boolean } }).value;
		assert.ok(value.output.length <= 65536);
		assert.equal(value.outputGap, true);
		assert.equal(value.closed, false);
		for (const foreign of [
			{ ...source, incarnation: 3 },
			{ ...source, extensionId: 'other' },
		]) {
			await assert.rejects(bridge.handle({ operation: 'disposeTerminal', terminalId: id }, signal, foreign));
		}
		exit.fire(0);
		const closed = await bridge.handle(
			{ operation: 'readTerminal', terminalId: id, afterSequence: 0 },
			signal,
			source,
		);
		assert.equal((closed as unknown as { value: { closed: boolean } }).value.closed, true);
		bridge.clearOwnedTerminals();
		assert.equal(closes, 1);
		await assert.rejects(
			bridge.handle({ operation: 'readTerminal', terminalId: id, afterSequence: 0 }, signal, source),
		);
		const delayed = new DeferredPromise<ITerminalInstance>();
		const creating = new DeferredPromise<void>();
		Object.assign(services.get(ITerminalService), {
			createTerminal: async () => {
				await creating.complete();
				return delayed.p;
			},
		});
		const pending = bridge.handle(
			{ operation: 'createTerminal', name: 'Late debug', cwd: null, env: {}, command: null },
			signal,
			source,
		);
		await creating.p;
		bridge.clearOwnedTerminals();
		await delayed.complete(terminal);
		await assert.rejects(pending, isCancellationError);
		assert.equal(closes, 2);
	});
});

suite('Terminal creation owner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates the default and explicit shell through the service without a View', async () => {
		using owner = new DisposableStore();
		const { services, launches } = createServices(owner, true);
		const terminals = services.get(ITerminalService);
		const first = await terminals.createTerminal({ deferStart: true });
		const second = await terminals.createTerminal({
			config: { executable: '/custom/shell', args: ['literal value'], env: { CUSTOM: 'value' } },
			deferStart: true,
		});
		assert.equal(terminals.instances.length, 2);
		assert.equal(first.xterm, undefined);
		assert.equal(second.xterm, undefined);
		assert.equal(launches.length, 2);
		assert.deepEqual(launches[1]!.profile, {
			type: 'custom',
			name: 'Shell',
			path: ['/custom/shell'],
			args: ['literal value'],
		});
		assert.equal(launches[1]!.env?.CUSTOM, 'value');
	});

	test('joins a split to the captured parent through the group owner', async () => {
		using owner = new DisposableStore();
		const { services } = createServices(owner, true);
		const terminals = services.get(ITerminalService);
		const parent = await terminals.createTerminal({ deferStart: true });
		const child = await terminals.createTerminal({
			location: { parentTerminal: Promise.resolve(parent) },
			deferStart: true,
		});
		const group = services.get(ITerminalGroupService).getGroupForInstance(parent);
		assert.deepEqual(group?.terminalInstances, [parent, child]);
	});

	test('cancels after profile discovery if the workspace scope changes without launching', async () => {
		using owner = new DisposableStore();
		const { services, workspace, setRead, launches } = createServices(owner, true);
		let release!: (value: readonly ITerminalProfile[]) => void;
		setRead(
			() =>
				new Promise(resolve => {
					release ??= resolve;
				}),
		);
		const operation = services.get(ITerminalService).createTerminal();
		while (!release) await new Promise(resolve => setTimeout(resolve, 0));
		workspace.updateWorkspace({ id: 'changed', uri: URI.file('/another') });
		release(shells);
		await assert.rejects(operation, isCancellationError);
		assert.equal(launches.length, 0);
	});

	test('publishes the editor target before listeners run and closes the process if editor open fails', async () => {
		using owner = new DisposableStore();
		const { services, closed } = createServices(owner, true, async () => {
			throw new Error('Editor failed');
		});
		const terminals = services.get(ITerminalService);
		const targets: unknown[] = [];
		owner.add(terminals.onDidCreateInstance(instance => targets.push(instance.target)));
		await assert.rejects(
			terminals.createTerminal({ location: { viewColumn: 12 }, deferStart: true }),
			/Editor failed/,
		);
		assert.deepEqual(targets, [TerminalLocation.Editor]);
		assert.equal(terminals.instances.length, 0);
		assert.equal(closed.length, 1);
	});
});

suite('Extension terminal resource completion escaping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function complete(owner: DisposableStore, shellType: TerminalShellType, commandLine = 'cat sp') {
		const { services } = createServices(owner);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), {
			currentCatalog: {
				generation: 1,
				diagnostics: [],
				extensions: [{ id: 'acme.extension', packageSha256: digest }],
			},
		});
		const instance = {
			id: 'terminal',
			processId: 42,
			state: 'running',
			dirId: 'test',
			shellType,
			onDidChangeState: Event.None,
		} as unknown as ITerminalInstance;
		Object.assign(services.get(ITerminalService), { instances: [instance], onDidDisposeInstance: Event.None });
		const files = services.get(IFileService);
		await files.createDirectory(URI.file('/workspace'));
		for (const name of ["sp ace'$(literal);&`literal`\\[x].txt", 'special.txt', 'sp\nunsafe']) {
			await files.createFile(URI.from({ scheme: 'file', path: `/workspace/${name}` }), 'overwrite');
		}
		await files.createDirectory(URI.from({ scheme: 'file', path: '/workspace/sp dir$(literal)' }));
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceCompletionProviders([
			{
				runtimeId: 'runtime',
				packageDigest: digest,
				registrationId: 'resources',
				triggerCharacters: [],
				invoke: async operation => {
					assert.equal(operation, 'provideTerminalCompletions');
					return {
						items: [{ label: 'provider $(syntax)', replacementRange: [4, commandLine.length] }],
						resourceOptions: { showFiles: true, showDirectories: true, cwd: 'file:///workspace' },
					};
				},
			},
		]);
		return services
			.get(ITerminalCompletionService)
			.provideCompletions(instance, commandLine, commandLine.length, new AbortController().signal);
	}

	for (const { shell, insertText } of [
		{ shell: PosixShellType.Bash, insertText: "'sp ace'\"'\"'$(literal);&`literal`\\[x].txt'" },
		{ shell: PosixShellType.Zsh, insertText: "'sp ace'\"'\"'$(literal);&`literal`\\[x].txt'" },
		{ shell: PosixShellType.Sh, insertText: "'sp ace'\"'\"'$(literal);&`literal`\\[x].txt'" },
		{ shell: PosixShellType.Ksh, insertText: "'sp ace'\"'\"'$(literal);&`literal`\\[x].txt'" },
		{ shell: WindowsShellType.GitBash, insertText: "'sp ace'\"'\"'$(literal);&`literal`\\[x].txt'" },
		{ shell: PosixShellType.Fish, insertText: "'sp ace\\'$(literal);&`literal`\\\\[x].txt'" },
		{ shell: GeneralShellType.PowerShell, insertText: "'sp ace''$(literal);&`literal`\\[x].txt'" },
	]) {
		test(`keeps resource labels literal and generates ${shell} insertion text through the extension bridge`, async () => {
			using owner = new DisposableStore();
			const result = await complete(owner, shell);
			assert.deepEqual(
				result
					.map(({ label, insertText, replacementRange }) => ({ label, insertText, replacementRange }))
					.sort((a, b) => a.label.localeCompare(b.label)),
				[
					{ label: 'provider $(syntax)', insertText: undefined, replacementRange: [4, 6] },
					{ label: "sp ace'$(literal);&`literal`\\[x].txt", insertText, replacementRange: [4, 6] },
					{ label: 'sp dir$(literal)/', insertText: "'sp dir$(literal)/'", replacementRange: [4, 6] },
					{ label: 'special.txt', insertText: "'special.txt'", replacementRange: [4, 6] },
				].sort((a, b) => a.label.localeCompare(b.label)),
			);
		});
	}

	for (const { shell, commandLine } of [
		{ shell: undefined, commandLine: 'cat sp' },
		{ shell: WindowsShellType.CommandPrompt, commandLine: 'cat sp' },
		{ shell: GeneralShellType.Python, commandLine: 'cat sp' },
		{ shell: PosixShellType.Bash, commandLine: "cat 'sp" },
		{ shell: PosixShellType.Bash, commandLine: 'cat $(sp' },
	]) {
		test(`leaves resource parsing to ${shell ?? 'unknown shell'} for ${JSON.stringify(commandLine)}`, async () => {
			using owner = new DisposableStore();
			const result = await complete(owner, shell, commandLine);
			assert.deepEqual(
				result.map(({ label, insertText }) => ({ label, insertText })),
				[{ label: 'provider $(syntax)', insertText: undefined }],
			);
		});
	}
});
