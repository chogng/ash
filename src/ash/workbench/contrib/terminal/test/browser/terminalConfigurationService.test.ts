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
import { ITerminalProfileService } from '../../common/terminal.js';
import { ITerminalService, type ITerminalProfile } from '../../browser/terminal.js';
import { TerminalConfigurationService } from '../../browser/terminalConfigurationService.js';
import { TerminalProfileService } from '../../browser/terminalProfileService.js';
import { TerminalProfileQuickpick } from '../../browser/terminalProfileQuickpick.js';

const shells = [
	{ profileId: 'host-default', title: 'Host shell', isDefault: true },
	{ profileId: 'pwsh', title: 'PowerShell', isDefault: false },
];

function createServices(owner: DisposableStore) {
	const services = owner.add(new InstantiationService());
	const configuration = owner.add(new WorkbenchConfigurationService());
	const connection = owner.add(new Emitter<import('../../../../../platform/terminal/common/terminal.js').TerminalProcessConnectionState>());
	const workspace = owner.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') }));
	let calls = 0;
	let read: () => Promise<readonly ITerminalProfile[]> = async () => shells;
	const processes = { operatingSystem: OperatingSystem.Windows as OperatingSystem | undefined, onConnectionState: connection.event } as ITerminalProcessService;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(ITerminalProcessService, processes);
	services.registerInstance(ITerminalService, { ...Disposable.None, getProfiles: () => { calls++; return read(); } } as ITerminalService);
	const profiles = owner.add(services.createInstance(TerminalProfileService));
	services.registerInstance(ITerminalProfileService, profiles);
	return { services, configuration, profiles, processes, workspace, connection, calls: () => calls, setRead: (fn: typeof read) => { read = fn; } };
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
});
