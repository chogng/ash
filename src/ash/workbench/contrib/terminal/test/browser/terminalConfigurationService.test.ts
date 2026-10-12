import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../../../../services/terminal/common/terminal.js';
import { BrowserTerminalProfileResolverService } from '../../browser/terminalProfileResolverService.js';
import { MainThreadTerminalService } from '../../../../api/browser/mainThreadTerminalService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { WorkbenchConfigurationService } from '../../../../services/configuration/browser/configurationService.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';

import { ITerminalService, type ITerminalProfile } from '../../../../services/terminal/browser/terminal.js';
import { TerminalConfigurationService } from '../../browser/terminalConfigurationService.js';
import { TerminalProfileService } from '../../browser/terminalProfileService.js';
import { TerminalProfileQuickpick } from '../../browser/terminalProfileQuickpick.js';
import { TerminalService } from '../../browser/terminalService.js';
import type { ITerminalProcessCreateOptions, ITerminalProcessCloseOptions } from '../../../../../platform/terminal/common/terminal.js';

const shells = [
	{ profileId: 'host-default', title: 'Host shell', isDefault: true },
	{ profileId: 'pwsh', title: 'PowerShell', isDefault: false },
];

function createServices(owner: DisposableStore, useInstances = false) {
	const services = owner.add(new InstantiationService());
	const configuration = owner.add(new WorkbenchConfigurationService());
	const connection = owner.add(new Emitter<import('../../../../../platform/terminal/common/terminal.js').TerminalProcessConnectionState>());
	const workspace = owner.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
	let calls = 0;
	const launches: ITerminalProcessCreateOptions[] = [];
	const closed: ITerminalProcessCloseOptions[] = [];
	let read: () => Promise<readonly ITerminalProfile[]> = async () => shells;
	const processes = {
		operatingSystem: OperatingSystem.Windows as OperatingSystem | undefined, onConnectionState: connection.event,
		listProfiles: async () => shells,
		getEnvironment: async () => ({ HOME: '/execution/home', PATH: '/execution/bin', PROFILE_VALUE: 'environment value' }),
		resolveProfile: async (selection: import('../../../../../platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({
			profile: selection.type === 'custom' ? { profileId: `custom:${selection.name}`, title: selection.name, isDefault: false } : shells.find(profile => selection.type === 'profile' && selection.profileId === profile.profileId) ?? shells[0]!,
			executable: selection.type === 'custom' ? selection.path.at(-1)! : '/execution/bin/shell', args: selection.type === 'custom' ? (typeof selection.args === 'string' ? selection.args : [...selection.args]) : [],
		}),
		getConnectionState: async () => 'ready',
		create: async (options: ITerminalProcessCreateOptions) => {
			launches.push(options);
			return {
				terminalId: `process-${launches.length}`, ready: { pid: 42, cwd: options.cwd ?? '/workspace' },
				profile: shells[0], connectionPersistence: 'connectionOwned',
			};
		},
		read: async ({ terminalId }: { terminalId: string; }) => ({
			terminalId, chunks: [{ sequence: 1, data: new TextEncoder().encode('shell output') }],
			nextSequence: 1, outputGap: false, commandEvents: [], nextCommandSequence: 0,
			commandEventGap: false, exited: true, exitCode: 0,
		}),
		close: async (options: ITerminalProcessCloseOptions) => { closed.push(options); },
	} as unknown as ITerminalProcessService;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IExtensionService, { ...Disposable.None, terminalProfiles: [], currentCatalog: { generation: 0, extensions: [], diagnostics: [] }, onDidChange: Event.None, activateByEvent: async () => { } } as unknown as IExtensionService);
	services.registerInstance(IConfigurationResolverService, { resolveWithEnvironment: async (env, folder, value) => value.replaceAll('${workspaceFolder}', folder?.uri.path ?? '').replace(/\$\{env:([^}]+)\}/g, (_match: string, key: string) => env[key] ?? '') } as IConfigurationResolverService);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(ITerminalProcessService, processes);
	services.registerInstance(ITerminalService, useInstances
		? owner.add(services.createInstance(TerminalService))
		: { ...Disposable.None, getProfiles: () => { calls++; return read(); } } as ITerminalService);
	const profiles = owner.add(services.createInstance(TerminalProfileService));
	services.registerInstance(ITerminalProfileService, profiles);
	services.registerInstance(ITerminalProfileResolverService, owner.add(services.createInstance(BrowserTerminalProfileResolverService)));
	return { services, configuration, profiles, processes, workspace, connection, launches, closed, calls: () => calls, setRead: (fn: typeof read) => { read = fn; } };
}

function installPicker(owner: DisposableStore, services: InstantiationService) {
	const accept = owner.add(new Emitter<IQuickPickItem>());
	const hide = owner.add(new Emitter<void>());
	let shown = false;
	let disposed = 0;
	const picker = Object.assign(toDisposable(() => { disposed++; }), {
		items: [] as readonly IQuickPickItem[], placeholder: '', ariaLabel: '',
		onDidAccept: accept.event, onDidHide: hide.event,
		show: () => { shown = true; }, hide: () => hide.fire(),
	});
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker as unknown as IQuickPick<IQuickPickItem> } as IQuickInputService);
	return { picker, accept: (index: number) => accept.fire(picker.items[index]!), hide: () => hide.fire(), shown: () => shown, disposed: () => disposed };
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) { if (check()) return; await Promise.resolve(); }
	assert.ok(check(), 'Expected asynchronous transition');
}

suite('Terminal configuration and interactive profiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('validates configuration values before changing the active snapshot', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		const terminalConfig = owner.add(services.createInstance(TerminalConfigurationService));
		let changes = 0;
		owner.add(terminalConfig.onConfigChanged(() => changes++));
		await configuration.updateValue('terminal.integrated.fontSize', 18);
		assert.equal(terminalConfig.config.fontSize, 18);
		for (const [key, value] of [['fontSize', 0], ['fontSize', Infinity], ['scrollback', -1], ['scrollback', 1.5], ['cursorStyle', 'bar'], ['cursorBlinking', 'true'], ['minimumContrastRatio', 22]] as const) {
			await assert.rejects(configuration.updateValue(`terminal.integrated.${key}`, value));
		}
		assert.equal(terminalConfig.config.fontSize, 18);
		assert.equal(changes, 1);
		await configuration.updateValue('terminal.integrated.cursorStyle', 'line');
		assert.equal(terminalConfig.config.cursorStyle, 'line');
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
		assert.deepEqual(profiles.availableProfiles.map(p => p.isDefault), [false, true]);
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

	test('coalesces discoveries and rejects late results after disconnect or replacement', async () => {
		using owner = new DisposableStore();
		const { profiles, connection, calls, setRead } = createServices(owner);
		let release!: (profiles: readonly ITerminalProfile[]) => void;
		setRead(() => new Promise(resolve => { release = resolve; }));
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
		assert.deepEqual(profiles.availableProfiles.map(p => p.profileId), ['host-default', 'pwsh']);
	});

	test('releases a pending discovery and all subscriptions with the profile owner', async () => {
		using owner = new DisposableStore();
		const { profiles, setRead } = createServices(owner);
		let release!: (profiles: readonly ITerminalProfile[]) => void;
		setRead(() => new Promise(resolve => { release = resolve; }));
		let events = 0;
		owner.add(profiles.onDidChangeAvailableProfiles(() => events++));
		const pending = profiles.refreshAvailableProfiles();
		const cancelled = assert.rejects(pending, isCancellationError);
		profiles.dispose(); release(shells);
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

	test('default selection persists the profile name at USER and updates available labels', async () => {
		using owner = new DisposableStore();
		const { services, profiles, configuration } = createServices(owner);
		const ui = installPicker(owner, services);
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('setDefault');
		await waitFor(ui.shown); ui.accept(1);
		assert.equal(await result, 'PowerShell');
		assert.equal(configuration.inspect('terminal.integrated.defaultProfile.windows').userValue, 'PowerShell');
		assert.deepEqual(profiles.availableProfiles.map(p => p.isDefault), [false, true]);
	});

	test('cancel and owner disposal settle a quick pick without a profile update', async () => {
		for (const cancel of ['hide', 'dispose'] as const) {
			using owner = new DisposableStore();
			const { services, configuration } = createServices(owner);
			const ui = installPicker(owner, services);
			using picker = services.createInstance(TerminalProfileQuickpick);
			const result = picker.showAndGetResult('setDefault');
			await waitFor(ui.shown);
			if (cancel === 'hide') ui.hide(); else picker.dispose();
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

	test('workspace transitions withdraw a pending catalogue and refresh the next folder', async () => {
		using owner = new DisposableStore();
		const { profiles, workspace, calls, setRead } = createServices(owner);
		await profiles.refreshAvailableProfiles();
		workspace.updateWorkspace({ id: 'empty-window' });
		assert.equal(profiles.availableProfiles.length, 0);
		assert.equal(calls(), 1);
		setRead(async () => [{ profileId: 'other', title: 'Other shell', isDefault: true }]);
		workspace.updateWorkspace({ id: 'other-folder', uri: URI.file('/other') });
		await waitFor(() => profiles.availableProfiles.length === 1);
		assert.equal(profiles.getDefaultProfile()?.profileId, 'other');
		assert.equal(calls(), 2);
	});

	test('default selection exposes a write failure without changing the runtime default', async () => {
		using owner = new DisposableStore();
		const { services, configuration, profiles } = createServices(owner);
		const ui = installPicker(owner, services);
		configuration.updateValue = async () => { throw new Error('settings write rejected'); };
		using picker = services.createInstance(TerminalProfileQuickpick);
		const result = picker.showAndGetResult('setDefault');
		const failed = assert.rejects(result, /settings write rejected/);
		await waitFor(ui.shown); ui.accept(1);
		await failed;
		assert.equal(profiles.getDefaultProfile()?.profileId, 'host-default');
		assert.equal(ui.disposed(), 1);
	});

	test('configuration service fails if its required owner is absent', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(TerminalConfigurationService), /Unknown service: configurationService/);
	});
	test('custom profile configuration hides detected entries and resolves argv, cwd and environment', async () => {
		using owner = new DisposableStore();
		const { services, configuration, profiles } = createServices(owner);
		await configuration.updateValue('terminal.integrated.profiles.windows', {
			'Host shell': null,
			'Configured shell': { path: ['/missing/shell', '${env:HOME}/shell'], args: ['${env:PROFILE_VALUE}', 'literal;$HOME'], env: { MODE: 'profile', REMOVED: null } },
		});
		await configuration.updateValue('terminal.integrated.defaultProfile.windows', 'Configured shell');
		await configuration.updateValue('terminal.integrated.env.windows', { MODE: 'global', Path: 'global path' });
		await configuration.updateValue('terminal.integrated.cwd', '${workspaceFolder}/subdirectory');
		await profiles.profilesReady;
		assert.deepEqual(profiles.availableProfiles.map(profile => profile.profileName), ['PowerShell', 'Configured shell']);
		const resolver = services.get(ITerminalProfileResolverService);
		const shell: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig = { env: { mode: 'caller', PATH: '${env:PATH}' } };
		await resolver.resolveShellLaunchConfig(shell, { os: OperatingSystem.Windows, remoteAuthority: undefined });
		assert.equal(shell.executable, '/execution/home/shell');
		assert.deepEqual(shell.args, ['environment value', 'literal;$HOME']);
		assert.equal(shell.cwd, '/workspace/subdirectory');
		assert.deepEqual(shell.env, { MODE: 'caller', Path: '/execution/bin', REMOVED: null });
		await assert.rejects(configuration.updateValue('terminal.integrated.profiles.windows', { Bad: { args: ['without path'] } }));
		await assert.rejects(configuration.updateValue('terminal.integrated.profiles.windows', { Bad: { path: [] } }));
		await assert.rejects(configuration.updateValue('terminal.integrated.profiles.windows', { 'Bad\nname': { path: '/shell' } }));
		await assert.rejects(configuration.updateValue('terminal.integrated.profiles.windows', { Bad: { path: '/shell', source: 'PowerShell' } }));
		await assert.rejects(configuration.updateValue('terminal.integrated.env.windows', { 'BAD=KEY': 'value' }));
	});

	test('resolver getters select automation policy and reject an unselected execution target', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		await configuration.updateValue('terminal.integrated.automationProfile.windows', { path: '/automation/shell', args: ['literal argument'] });
		const resolver = services.get(ITerminalProfileResolverService);
		const options = { os: OperatingSystem.Windows, remoteAuthority: undefined, allowAutomationShell: true };
		assert.equal(await resolver.getDefaultShell(options), '/automation/shell');
		assert.deepEqual(await resolver.getDefaultShellArgs(options), ['literal argument']);
		assert.equal((await resolver.getDefaultProfile(options)).path, '/automation/shell');
		const shell = { executable: '/original/shell', args: ['original'] };
		await assert.rejects(resolver.resolveShellLaunchConfig(shell, { os: OperatingSystem.Linux, remoteAuthority: undefined }), /execution host/);
		assert.deepEqual(shell, { executable: '/original/shell', args: ['original'] });
		await assert.rejects(resolver.getEnvironment('unselected-host'), /execution host/);
		assert.equal(resolver.getDefaultIcon().id, 'terminal');
	});

	for (const args of ['/d /s /c "echo ${env:PROFILE_VALUE}"', '']) test(`Windows resolver preserves raw profile and launch arguments ${JSON.stringify(args)}`, async () => {
		using owner = new DisposableStore();
		const { services, configuration, launches } = createServices(owner, true);
		await configuration.updateValue('terminal.integrated.automationProfile.windows', { path: 'C:\\Windows\\cmd.exe', args });
		const resolver = services.get(ITerminalProfileResolverService);
		const options = { os: OperatingSystem.Windows, remoteAuthority: undefined, allowAutomationShell: true };
		assert.equal(await resolver.getDefaultShellArgs(options), args.replace('${env:PROFILE_VALUE}', 'environment value'));
		await configuration.updateValue('terminal.integrated.agentHostProfile.windows', { path: 'C:\\Windows\\cmd.exe', args });
		assert.equal(await resolver.getDefaultShellArgs({ ...options, allowAutomationShell: false, allowAgentHostShell: true }), args.replace('${env:PROFILE_VALUE}', 'environment value'));
		const shell: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig = { executable: 'C:\\Windows\\cmd.exe', args };
		await resolver.resolveShellLaunchConfig(shell, options);
		const terminal = await services.get(ITerminalService).createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'custom', name: 'Shell', path: [shell.executable as string], args: shell.args! } });
		assert.deepEqual(launches[0].profile, { type: 'custom', name: 'Shell', path: ['C:\\Windows\\cmd.exe'], args: args.replace('${env:PROFILE_VALUE}', 'environment value') });
		await waitFor(() => terminal.state === 'exited');
		await services.get(ITerminalService).relaunchTerminal(terminal, { rows: 30, cols: 100 });
		assert.deepEqual(launches[1].profile, launches[0].profile);
	});

	for (const os of [OperatingSystem.Linux, OperatingSystem.Macintosh]) test(`non-Windows resolver rejects raw strings before resolving or creating a process on OS ${os}`, async () => {
		using owner = new DisposableStore();
		const { services, configuration, processes, launches } = createServices(owner, true);
		Object.assign(processes, { operatingSystem: os });
		const platform = os === OperatingSystem.Linux ? 'linux' : 'osx';
		await assert.rejects(configuration.updateValue(`terminal.integrated.profiles.${platform}`, { Shell: { path: '/bin/sh', args: '-c echo' } }));
		await assert.rejects(configuration.updateValue(`terminal.integrated.automationProfile.${platform}`, { path: '/bin/sh', args: '' }));
		await assert.rejects(configuration.updateValue(`terminal.integrated.agentHostProfile.${platform}`, { path: '/bin/sh', args: '-l' }));
		const resolver = services.get(ITerminalProfileResolverService);
		for (const executable of [undefined, '/bin/sh']) {
			const shell = { executable, args: '-c "literal"' };
			await assert.rejects(resolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: undefined }), /only supported on Windows/);
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
			await assert.rejects(services.get(ITerminalProfileResolverService).resolveShellLaunchConfig({ executable: '/bin/sh', args: '-c echo' }, { os: OperatingSystem.Linux, remoteAuthority: undefined }), { message: '原始命令行字符串仅在 Windows 上受支持。' });
		} finally { resetNlsResolver(); }
	});

	test('extension Windows raw shell options pass through the bridge and original resolver without splitting', async () => {
		using owner = new DisposableStore();
		const { services, profiles, launches } = createServices(owner, true);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), { currentCatalog: { generation: 1, diagnostics: [], extensions: [{ id: 'acme.extension', packageSha256: digest }] } });
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles([{
			runtimeId: 'runtime', packageDigest: digest, profileId: 'raw', title: 'Raw shell',
			invoke: async () => ({ options: { name: 'Raw shell', shellPath: 'C:\\Windows\\cmd.exe', shellArgs: '/d /s /c "echo ${env:PROFILE_VALUE}"' } }),
		}]);
		await profiles.getContributedProfileProvider('acme.extension', 'raw')!.createContributedTerminalProfile({});
		assert.deepEqual(launches[0].profile, { type: 'custom', name: 'Raw shell', path: ['C:\\Windows\\cmd.exe'], args: '/d /s /c "echo environment value"' });
		assert.equal(services.get(ITerminalService).instances.length, 1);
	});

	test('resolver cancels a late environment result without partially changing launch data', async () => {
		using owner = new DisposableStore();
		const { services, processes, connection } = createServices(owner);
		let release!: (env: Readonly<Record<string, string>>) => void;
		Object.assign(processes, { getEnvironment: () => new Promise(resolve => { release = resolve; }) });
		const shell = { name: 'Original', executable: '/original/shell', args: ['original'], env: { ORIGINAL: 'value' } };
		const pending = services.get(ITerminalProfileResolverService).resolveShellLaunchConfig(shell, { os: OperatingSystem.Windows, remoteAuthority: undefined });
		const cancelled = assert.rejects(pending, isCancellationError);
		await waitFor(() => Boolean(release));
		connection.fire('crashed'); release({ HOME: '/late' });
		await cancelled;
		assert.deepEqual(shell, { name: 'Original', executable: '/original/shell', args: ['original'], env: { ORIGINAL: 'value' } });
	});

	test('extension defaults use the registered provider and disposable overrides restore selection', async () => {
		using owner = new DisposableStore();
		const { services, profiles, configuration } = createServices(owner);
		owner.add(profiles.registerInternalContributedProfile({ extensionIdentifier: 'acme.extension', id: 'first', title: 'Extension first' }));
		owner.add(profiles.registerInternalContributedProfile({ extensionIdentifier: 'acme.extension', id: 'second', title: 'Extension second' }));
		await profiles.registerContributedProfile({ extensionIdentifier: 'acme.extension', id: 'first', title: 'Extension first', options: {} });
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
				owner.add(profiles.registerTerminalProfileProvider('acme.extension', 'first', { createContributedTerminalProfile: async () => { calls++; } }));
			}
		});
		await profiles.getContributedProfileProvider('acme.extension', 'first')!.createContributedTerminalProfile({});
		assert.equal(calls, 1);
	});

	for (const custom of [false, true]) test(`extension profile bridge creates ${custom ? 'a live Pseudoterminal' : 'an execution-host shell'} and withdraws its registration`, async () => {
		using owner = new DisposableStore();
		const { services, profiles } = createServices(owner);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), { currentCatalog: { generation: 1, diagnostics: [], extensions: [{ id: 'acme.extension', name: 'extension', publisher: 'acme', version: '1.0.0', displayName: 'Extension', sourceKind: 'user', manifestSha256: digest, packageSha256: digest }] } });
		const launches: import('../../../../services/terminal/browser/terminal.js').ITerminalCreateOptions[] = [];
		const writes: string[] = [];
		const exits: (number | undefined)[] = [];
		let child: import('../../../../../platform/terminal/common/terminal.js').ITerminalChildProcess | undefined;
		Object.assign(services.get(ITerminalService), {
			createTerminal: async (options: import('../../../../services/terminal/browser/terminal.js').ITerminalCreateOptions) => {
				launches.push(options);
				if (options.config) {
					child = owner.add(options.config.customPtyImplementation(1, 80, 24));
					owner.add(child.onProcessData(data => writes.push(data))); owner.add(child.onProcessExit(code => exits.push(code)));
					await child.start();
				}
				return {};
			}
		});
		const operations: string[] = [];
		const invoke: import('../../../../api/browser/extensionHostLanguageBridge.js').ExtensionHostProviderInvoker = async (operation, payload, signal): Promise<import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue> => {
			signal.throwIfAborted(); operations.push(operation);
			if (operation === 'createTerminalProfile') return custom ? { options: { name: 'Extension PTY' }, pty: { ptyId: 'pty.1', acceptsInput: true } } : { options: { name: 'Extension shell', shellPath: '/extension/shell', shellArgs: ['literal argument'], env: { PROFILE: 'value' } } };
			if (operation === 'openTaskTerminal') return { events: [{ type: 'data', data: 'synchronous open output' }] };
			if (operation === 'inputTaskTerminal') return { events: [{ type: 'data', data: `echo:${(payload as { data: string; }).data}` }] };
			if (operation === 'closeTaskTerminal') return null;
			return { events: [] };
		};
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		const descriptor = { runtimeId: 'runtime', packageDigest: digest, profileId: 'test', title: 'Extension test', invoke };
		bridge.replaceProfiles([descriptor]);
		bridge.replaceProfiles([descriptor]);
		await profiles.getContributedProfileProvider('acme.extension', 'test')!.createContributedTerminalProfile({});
		assert.equal(launches.length, 1);
		if (custom) {
			assert.deepEqual(writes, ['synchronous open output']);
			child!.input!('typed'); await waitFor(() => writes.length === 2);
			assert.deepEqual(writes, ['synchronous open output', 'echo:typed']);
			child!.dispose();
			child = owner.add(launches[0]!.config!.customPtyImplementation(1, 100, 30));
			owner.add(child.onProcessData(data => writes.push(data)));
			owner.add(child.onProcessExit(code => exits.push(code)));
			await child.start();
			assert.equal(operations.filter(operation => operation === 'createTerminalProfile').length, 2);
			assert.deepEqual(writes, ['synchronous open output', 'echo:typed', 'synchronous open output']);
		} else assert.deepEqual(launches[0]!.profile, { type: 'custom', name: 'Extension shell', path: ['/extension/shell'], args: ['literal argument'] });
		bridge.replaceProfiles([]);
		assert.equal(profiles.getContributedProfileProvider('acme.extension', 'test'), undefined);
		if (custom) { assert.deepEqual(exits, [undefined, undefined]); assert.equal(operations.filter(operation => operation === 'closeTaskTerminal').length, 2); }
	});

	for (const custom of [false, true]) test(`shared terminal contracts connect an extension ${custom ? 'PTY' : 'shell'} to the original instance and release owners`, async () => {
		using owner = new DisposableStore();
		const { services, configuration, profiles, launches, closed } = createServices(owner, true);
		const terminals = services.get(ITerminalService);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), { currentCatalog: { generation: 1, diagnostics: [], extensions: [{ id: 'acme.extension', packageSha256: digest }] } });
		await configuration.updateValue('terminal.integrated.env.windows', { GLOBAL: 'global', REMOVED: 'remove me' });
		const output: string[] = [];
		const exits: (number | undefined)[] = [];
		owner.add(terminals.onDidCreateInstance(instance => {
			owner.add(instance.onDidWriteData(event => output.push(new TextDecoder().decode(event.data))));
			owner.add(instance.onDidExit(code => exits.push(code)));
		}));
		const operations: { operation: string; payload: unknown; }[] = [];
		let nextPty = 0;
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles([{
			runtimeId: 'runtime', packageDigest: digest, profileId: 'test', title: 'Extension',
			invoke: async (operation, payload, signal): Promise<import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue> => {
				signal.throwIfAborted();
				operations.push({ operation, payload });
				if (operation === 'createTerminalProfile') return custom
					? { options: { name: 'Extension PTY' }, pty: { ptyId: `pty.${++nextPty}`, acceptsInput: true } }
					: { options: { name: 'Extension shell', shellPath: '/extension/shell', shellArgs: ['${env:PROFILE_VALUE}'], cwd: '${workspaceFolder}/run', env: { CALLER: '${env:PROFILE_VALUE}', REMOVED: null } } };
				if (operation === 'openTaskTerminal') return { events: [{ type: 'data', data: 'PTY output' }, { type: 'close', code: 0 }] };
				assert.equal(operation, 'closeTaskTerminal');
				return null;
			},
		}]);
		await profiles.getContributedProfileProvider('acme.extension', 'test')!.createContributedTerminalProfile({});
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
			assert.deepEqual(operations.filter(value => value.operation === 'closeTaskTerminal').map(value => value.payload), [{ ptyId: 'pty.1' }, { ptyId: 'pty.2' }]);
		} else {
			assert.deepEqual(launches, [{
				rows: 24, cols: 80, profile: { type: 'custom', name: 'Extension shell', path: ['/extension/shell'], args: ['environment value'] },
				env: { GLOBAL: 'global', REMOVED: null, CALLER: 'environment value' }, cwd: '/workspace/run',
			}]);
		}
		bridge.replaceProfiles([]);
		assert.equal(profiles.getContributedProfileProvider('acme.extension', 'test'), undefined);
		await terminals.closeTerminal(instance);
		assert.deepEqual(terminals.instances, []);
		assert.deepEqual(closed, custom ? [] : [{ terminalId: 'process-1' }]);
	});

	test('extension profile abandons a late PTY result after the workspace changes', async () => {
		using owner = new DisposableStore();
		const { services, profiles, workspace } = createServices(owner);
		const digest = `sha256:${'a'.repeat(64)}`;
		Object.assign(services.get(IExtensionService), { currentCatalog: { generation: 1, diagnostics: [], extensions: [{ id: 'acme.extension', packageSha256: digest }] } });
		Object.assign(services.get(ITerminalService), { createTerminal: async () => assert.fail('Stale profile created a terminal') });
		let release!: (value: import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue) => void;
		const closed: unknown[] = [];
		const bridge = owner.add(services.createInstance(MainThreadTerminalService));
		bridge.replaceProfiles([{
			runtimeId: 'runtime', packageDigest: digest, profileId: 'pty', title: 'PTY', invoke: async (operation, payload) => {
				if (operation === 'createTerminalProfile') return new Promise(resolve => { release = resolve; });
				assert.equal(operation, 'closeTaskTerminal'); closed.push(payload); return null;
			}
		}]);
		const cancelled = assert.rejects(profiles.getContributedProfileProvider('acme.extension', 'pty')!.createContributedTerminalProfile({}), isCancellationError);
		await waitFor(() => Boolean(release));
		workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		release({ options: { name: 'Late PTY' }, pty: { ptyId: 'pty.1', acceptsInput: true } });
		await cancelled;
		assert.deepEqual(closed, [{ ptyId: 'pty.1' }]);
	});

});
