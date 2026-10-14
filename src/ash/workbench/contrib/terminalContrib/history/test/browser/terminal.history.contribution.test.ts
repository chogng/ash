import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickSeparator } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { ITerminalService, type ITerminalCommandStatusEvent, type ITerminalInstance } from '../../../../../services/terminal/browser/terminal.js';
import { TerminalExtensionsRegistry } from '../../../../terminal/browser/terminalExtensions.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../../../workbench/services/storage/browser/storageService.js';
import { TerminalCommandHistory } from '../../common/history.js';
import { TerminalHistoryCommandId } from '../../common/terminal.history.js';
import '../../../../terminal/common/terminalConfiguration.js';
import '../../browser/terminal.history.contribution.js';

test('Terminal history contribution keeps commands across PTY reuse and rejects Task or untrusted events', () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using resources = new DisposableStore();
		const configuration = resources.add(new WorkbenchConfigurationService());
		const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'history-contribution', backend: dom.window.localStorage, flushInterval: 0 }));
		const services = resources.add(new InstantiationService());
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		const commands = resources.add(new Emitter<ITerminalCommandStatusEvent>());
		let commandStorageDisabled = false;
		const instance = {
			profile: { profileId: 'bash', title: 'Bash', isDefault: true },
			get shellIntegration() { return { commandDetection: true, cwdDetection: false, hasRichCommandDetection: true, commandStorageDisabled, commands: [] }; },
			onDidChangeCommandStatus: commands.event,
		} as unknown as ITerminalInstance;
		const contribution = TerminalExtensionsRegistry.getTerminalContributions().find(value => value.id === 'terminal.history');
		assert.ok(contribution);
		const history = services.createInstance(contribution.ctor, { instance });
		resources.add(history);

		commands.fire({ commandId: 'command-1', status: 'succeeded', exitCode: 0, command: 'echo before reuse', isTrusted: true });
		// A replacement PTY starts its command IDs over, while this Terminal instance and contribution survive.
		commands.fire({ commandId: 'command-1', status: 'succeeded', exitCode: 0, command: 'echo after reuse', isTrusted: true });
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

		const sent: Array<{ text: string; shouldExecute: boolean; }> = [];
		const instance = {
			profile: { profileId: 'bash', title: 'Bash', isDefault: true }, state: 'running', isReadOnly: false,
			sendText: async (text: string, shouldExecute: boolean) => { sent.push({ text, shouldExecute }); },
		} as unknown as ITerminalInstance;
		let activeInstance: ITerminalInstance | undefined = instance;
		services.registerInstance(ITerminalService, {
			get activeInstance() { return activeInstance; },
			instances: [instance],
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
