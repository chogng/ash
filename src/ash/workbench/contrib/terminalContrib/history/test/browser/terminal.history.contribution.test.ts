import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickSeparator } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { ITerminalService, type ITerminalCommandStatusEvent, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { TerminalExtensionsRegistry } from '../../../../terminal/browser/terminalExtensions.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../../../workbench/services/storage/browser/storageService.js';
import { TerminalCommandHistory, TerminalDirectoryHistory } from '../../common/history.js';
import { URI } from '../../../../../../base/common/uri.js';
import { TerminalHistoryCommandId } from '../../common/terminal.history.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { PosixShellType } from '../../../../../../platform/terminal/common/terminal.js';
import '../../../../terminal/common/terminalConfiguration.js';
import '../../browser/terminal.history.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('Terminal history contribution keeps commands across PTY reuse and rejects Task or untrusted events', () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using resources = new DisposableStore();
		const configuration = resources.add(new WorkbenchConfigurationService());
		const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'history-contribution', backend: dom.window.localStorage, flushInterval: 0 }));
		const services = resources.add(new InstantiationService());
		services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'history', folders: [{ id: 'folder', uri: URI.file('/workspace'), name: 'root', index: 0 }] })));
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		const commands = resources.add(new Emitter<ITerminalCommandStatusEvent>());
		let commandStorageDisabled = false;
		const instance = {
			dirId: 'folder',
			profile: { profileId: 'bash', title: 'Bash', isDefault: true },
			get shellIntegration() { return { commandDetection: true, cwdDetection: false, hasRichCommandDetection: true, commandStorageDisabled, commands: [] }; },
			onDidChangeCommandStatus: commands.event,
		} as unknown as ITerminalInstance;
		const contribution = TerminalExtensionsRegistry.getTerminalContributions().find(value => value.id === 'terminal.history');
		assert.ok(contribution);
		const history = services.createInstance(contribution.ctor, { instance });
		resources.add(history);

		commands.fire({ commandId: 'command-1', status: 'succeeded', exitCode: 0, command: 'echo before reuse', isTrusted: true, cwd: '/earlier directory' });
		// A replacement PTY starts its command IDs over, while this Terminal instance and contribution survive.
		commands.fire({ commandId: 'command-1', status: 'succeeded', exitCode: 0, command: 'echo after reuse', isTrusted: true, cwd: '/later directory' });
		commandStorageDisabled = true;
		commands.fire({ commandId: 'task-command', status: 'succeeded', exitCode: 0, command: 'echo task', isTrusted: true });
		commandStorageDisabled = false;
		commands.fire({ commandId: 'untrusted-command', status: 'succeeded', exitCode: 0, command: 'echo forged', isTrusted: false });
		commands.fire({ commandId: 'missing-nonce-command', status: 'succeeded', exitCode: 0, command: 'echo missing nonce' });

		assert.deepEqual(JSON.parse(storage.get('terminal.shellIntegration.commandHistory.v1', StorageScope.APPLICATION)!).entries, [
			{ shellId: 'bash', command: 'echo before reuse' },
			{ shellId: 'bash', command: 'echo after reuse' },
		]);
	} finally {
		dom.window.close();
	}
});

test('Run Recent Command executes only an accepted item in the still-active terminal', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using resources = new DisposableStore();
		const configuration = resources.add(new WorkbenchConfigurationService());
		const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'history-action', backend: dom.window.localStorage, flushInterval: 0 }));
		new TerminalCommandHistory(configuration, storage).record('bash', 'succeeded', 'echo explicitly accepted', true, false);
		const services = resources.add(new InstantiationService());
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'history-action', folders: [] })));

		const sent: Array<{ text: string; shouldExecute: boolean; }> = [];
		const instance = {
			profile: { profileId: 'bash', title: 'Bash', isDefault: true }, state: 'running', isReadOnly: false,
			onDidChangeState: Event.None, onDidExit: Event.None,
			sendText: async (text: string, shouldExecute: boolean) => { sent.push({ text, shouldExecute }); },
		} as unknown as ITerminalInstance;
		let activeInstance: ITerminalInstance | undefined = instance;
		services.registerInstance(ITerminalService, {
			get activeInstance() { return activeInstance; },
			instances: [instance],
			onDidChangeActiveInstance: Event.None, onDidDisposeInstance: Event.None,
		} as unknown as ITerminalService);

		const pickers: Array<{ readonly items: readonly (IQuickPickItem | IQuickPickSeparator)[]; readonly accept: (item: IQuickPickItem) => void; readonly hidden: Emitter<void>; readonly shown: Promise<void>; }> = [];
		services.registerInstance(IQuickInputService, {
			createQuickPick: () => {
				const accepted = resources.add(new Emitter<{ inBackground: boolean; }>());
				const hidden = resources.add(new Emitter<void>());
				let show!: () => void;
				const shown = new Promise<void>(resolve => show = resolve);
				const picker = {
					items: [] as readonly (IQuickPickItem | IQuickPickSeparator)[], selectedItems: [] as IQuickPickItem[], ariaLabel: '', placeholder: '',
					onDidAccept: accepted.event, onDidHide: hidden.event,
					show: () => show(), hide: () => hidden.fire(),
					dispose() { }, [Symbol.dispose]() { },
				} as unknown as IQuickPick<IQuickPickItem>;
				pickers.push({ get items() { return picker.items; }, accept: item => { picker.selectedItems = [item]; accepted.fire({ inBackground: false }); }, hidden, shown });
				return picker;
			},
			input: async () => undefined,
		} as unknown as IQuickInputService);

		const runRecent = CommandsRegistry.getCommand(TerminalHistoryCommandId.RunRecentCommand)!;
		const canceled = services.invokeFunction(runRecent);
		await pickers[0]!.shown;
		assert.deepEqual(sent, []);
		pickers[0]!.hidden.fire();
		await canceled;

		const stale = services.invokeFunction(runRecent);
		await pickers[1]!.shown;
		activeInstance = undefined;
		pickers[1]!.accept(pickers[1]!.items[0]! as IQuickPickItem);
		await stale;
		assert.deepEqual(sent, []);

		activeInstance = instance;
		const accepted = services.invokeFunction(runRecent);
		await pickers[2]!.shown;
		assert.deepEqual(sent, []);
		pickers[2]!.accept(pickers[2]!.items[0]! as IQuickPickItem);
		await accepted;
		assert.deepEqual(sent, [{ text: 'echo explicitly accepted', shouldExecute: true }]);
	} finally {
		dom.window.close();
	}
});

function createHistoryPickerTest(resources: DisposableStore) {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	resources.add(toDisposable(() => dom.window.close()));
	const configuration = resources.add(new WorkbenchConfigurationService());
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'history-lifetime', backend: dom.window.localStorage, flushInterval: 0 }));
	const folder = { id: 'folder', uri: URI.file('/workspace'), name: 'root', index: 0 };
	const workspace = resources.add(new TestWorkspaceService({ id: 'history-lifetime', folders: [folder] }));
	new TerminalCommandHistory(configuration, storage).record('bash', 'succeeded', 'echo accepted', true, false);
	new TerminalDirectoryHistory(configuration, storage).record(JSON.stringify(['history-lifetime', '', 'file', '']), '/saved directory', true, false);
	const services = resources.add(new InstantiationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IWorkspaceContextService, workspace);

	const states = resources.add(new Emitter<ITerminalInstance['state']>());
	const exits = resources.add(new Emitter<number | undefined>());
	const activeChanges = resources.add(new Emitter<ITerminalInstance | undefined>());
	const disposals = resources.add(new Emitter<ITerminalInstance>());
	const sent: Array<{ text: string; shouldExecute: boolean; }> = [];
	const started = new DeferredPromise<void>();
	let sendGate: Promise<void> | undefined;
	let focusCount = 0;
	let processId = 10;
	const instance = {
		dirId: folder.id, profile: { profileId: 'bash', title: 'Bash', isDefault: true },
		shellType: PosixShellType.Bash, state: 'running', isReadOnly: false,
		get processId() { return processId; },
		onDidChangeState: states.event, onDidExit: exits.event,
		xterm: { focus: () => focusCount++ },
		sendText: async (text: string, shouldExecute: boolean) => {
			sent.push({ text, shouldExecute });
			await started.complete();
			await sendGate;
		},
	} as unknown as ITerminalInstance;
	let activeInstance: ITerminalInstance | undefined = instance;
	services.registerInstance(ITerminalService, {
		get activeInstance() { return activeInstance; }, instances: [instance],
		onDidChangeActiveInstance: activeChanges.event, onDidDisposeInstance: disposals.event,
	} as unknown as ITerminalService);
	const accepted = resources.add(new Emitter<{ inBackground: boolean; }>());
	const hidden = resources.add(new Emitter<void>());
	let hideCount = 0;
	let show!: () => void;
	const shown = new Promise<void>(resolve => show = resolve);
	const picker = {
		items: [] as readonly (IQuickPickItem | IQuickPickSeparator)[], selectedItems: [] as IQuickPickItem[],
		onDidAccept: accepted.event, onDidHide: hidden.event,
		show: () => show(), hide: () => { hideCount++; hidden.fire(); },
		dispose() { }, [Symbol.dispose]() { },
	} as unknown as IQuickPick<IQuickPickItem>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	return {
		services, workspace, folder, instance, shown, sent, started: started.p,
		get hideCount() { return hideCount; },
		get focusCount() { return focusCount; },
		accept: () => { picker.selectedItems = [picker.items[0]! as IQuickPickItem]; accepted.fire({ inBackground: false }); },
		switchAwayAndBack: () => {
			activeInstance = undefined;
			activeChanges.fire(undefined);
			activeInstance = instance;
			activeChanges.fire(instance);
		},
		reconnect: () => { states.fire('reconnecting'); states.fire('running'); },
		replaceProcess: () => { processId++; },
		exit: () => exits.fire(0),
		disposeInstance: () => disposals.fire(instance),
		delaySend: (gate: Promise<void>) => { sendGate = gate; },
	};
}

for (const commandId of [TerminalHistoryCommandId.RunRecentCommand, TerminalHistoryCommandId.GoToRecentDirectory]) {
	for (const scenario of ['switch away and back', 'reconnect', 'exit', 'dispose', 'replace workspace'] as const) {
		test(`${commandId} retires its picker after ${scenario}`, async () => {
			using resources = new DisposableStore();
			const fixture = createHistoryPickerTest(resources);
			const running = fixture.services.invokeFunction(CommandsRegistry.getCommand(commandId)!);
			await fixture.shown;
			switch (scenario) {
				case 'switch away and back': fixture.switchAwayAndBack(); break;
				case 'reconnect': fixture.reconnect(); break;
				case 'exit': fixture.exit(); break;
				case 'dispose': fixture.disposeInstance(); break;
				case 'replace workspace': fixture.workspace.updateWorkspace({ id: 'replacement', folders: [fixture.folder] }); break;
			}
			assert.ok(fixture.hideCount > 0, 'the stale picker must close immediately');
			fixture.accept();
			await running;
			assert.deepEqual(fixture.sent, []);
			assert.equal(fixture.focusCount, 0);
		});
	}

	test(`${commandId} rejects an accepted item after its process was replaced`, async () => {
		using resources = new DisposableStore();
		const fixture = createHistoryPickerTest(resources);
		const running = fixture.services.invokeFunction(CommandsRegistry.getCommand(commandId)!);
		await fixture.shown;
		fixture.replaceProcess();
		fixture.accept();
		await running;
		assert.deepEqual(fixture.sent, []);
	});
}

test('Go to Recent Directory preserves execution and does not steal focus after a delayed send', async () => {
	using resources = new DisposableStore();
	const fixture = createHistoryPickerTest(resources);
	const gate = new DeferredPromise<void>();
	fixture.delaySend(gate.p);
	const running = fixture.services.invokeFunction(CommandsRegistry.getCommand(TerminalHistoryCommandId.GoToRecentDirectory)!);
	await fixture.shown;
	fixture.accept();
	await fixture.started;
	fixture.switchAwayAndBack();
	await gate.complete();
	await running;
	assert.deepEqual(fixture.sent, [{ text: "cd -- '/saved directory'", shouldExecute: true }]);
	assert.equal(fixture.focusCount, 0);
});

test('Go to Recent Directory executes the accepted path and restores focus to the unchanged terminal', async () => {
	using resources = new DisposableStore();
	const fixture = createHistoryPickerTest(resources);
	const running = fixture.services.invokeFunction(CommandsRegistry.getCommand(TerminalHistoryCommandId.GoToRecentDirectory)!);
	await fixture.shown;
	assert.deepEqual(fixture.sent, []);
	fixture.accept();
	await running;
	assert.deepEqual(fixture.sent, [{ text: "cd -- '/saved directory'", shouldExecute: true }]);
	assert.equal(fixture.focusCount, 1);
});
