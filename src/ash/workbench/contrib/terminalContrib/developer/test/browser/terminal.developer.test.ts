import { StatusbarService } from '../../../../../browser/parts/statusbar/statusbarPart.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../../services/statusbar/browser/statusbar.js';
import {
	ITerminalEditorService,
	ITerminalGroupService,
	ITerminalService,
	type ITerminalInstance,
	type IXtermTerminal,
} from '../../../../terminal/browser/terminal.js';
import type { IProcessDataEvent } from '../../../../../../platform/terminal/common/terminal.js';
import { TerminalDeveloperCommandId } from '../../common/terminal.developer.js';
import '../../browser/terminal.developer.contribution.js';

function fixture(owner: DisposableStore) {
	const services = owner.add(new InstantiationService());
	const activeChanged = owner.add(new Emitter<ITerminalInstance | undefined>());
	const disposed = owner.add(new Emitter<ITerminalInstance>());
	const changed = owner.add(new Emitter<ITerminalInstance['state']>());
	const exit = owner.add(new Emitter<number | undefined>());
	const output = owner.add(new Emitter<IProcessDataEvent>());
	const input = owner.add(new Emitter<string>());
	const resized = owner.add(new Emitter<{ cols: number; rows: number }>());
	const prompt = new DeferredPromise<string | undefined>();
	const prompted = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	const displayWrites: string[] = [];
	const clipboard: string[] = [];
	let focusCalls = 0;
	let panelCalls = 0;
	let creationOptions: unknown;
	const screen = {
		isDisposed: false,
		dimensions: () => ({ cols: 80, rows: 24 }),
		focus: () => {
			focusCalls++;
		},
		raw: {
			write: (data: string, callback: () => void) => {
				displayWrites.push(data);
				callback();
			},
			onData: input.event,
			onResize: resized.event,
		},
	} as unknown as IXtermTerminal;
	const instance = {
		processId: 1,
		instanceId: 1,
		state: 'running',
		xtermReadyPromise: Promise.resolve(screen),
		onDidChangeState: changed.event,
		onDidExit: exit.event,
		onDidWriteData: output.event,
		start: () => {
			assert.equal(output.hasListeners(), true);
			assert.equal(input.hasListeners(), true);
			output.fire({ data: 'first child output', trackCommit: false });
			void started.complete();
		},
	} as unknown as ITerminalInstance;
	let active: ITerminalInstance | undefined = instance;
	services.registerInstance(ITerminalService, {
		instances: [instance],
		get activeInstance() {
			return active;
		},
		onDidChangeActiveInstance: activeChanged.event,
		onDidDisposeInstance: disposed.event,
		setActiveInstance: (value: ITerminalInstance) => {
			active = value;
			activeChanged.fire(value);
		},
		createTerminal: async (options: unknown) => {
			creationOptions = options;
			return instance;
		},
	} as unknown as ITerminalService);
	services.registerInstance(ITerminalGroupService, {
		showPanel: async () => {
			panelCalls++;
		},
	} as unknown as ITerminalGroupService);
	services.registerInstance(ITerminalEditorService, {} as ITerminalEditorService);
	services.registerInstance(IQuickInputService, {
		input: async () => {
			void prompted.complete();
			return prompt.p;
		},
	} as unknown as IQuickInputService);
	services.registerInstance(IClipboardService, {
		writeText: async (text: string) => {
			clipboard.push(text);
		},
	} as IClipboardService);
	const statusbar = owner.add(new StatusbarService());
	services.registerInstance(IStatusbarService, statusbar);
	const commands = owner.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	return {
		commands,
		statusbar,
		screen,
		instance,
		prompt,
		prompted,
		started,
		changed,
		disposed,
		output,
		input,
		resized,
		activeChanged,
		displayWrites,
		clipboard,
		focusCalls: () => focusCalls,
		panelCalls: () => panelCalls,
		creationOptions: () => creationOptions,
	};
}

test('Developer Write Data command decodes one escape layer and writes only to the original renderer', async () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	const command = f.commands.executeCommand(TerminalDeveloperCommandId.WriteDataToTerminal);
	await f.prompted.p;
	await f.prompt.complete('one\\nline\\r\\x1b\\x5cn');
	await command;
	assert.deepEqual(f.displayWrites, ['one\nline\r\x1b\\n']);
	assert.equal(f.panelCalls(), 1);
	assert.equal(f.focusCalls(), 1);
});

test('Developer Write Data abandons a prompt after the active terminal changes or its process reconnects', async () => {
	for (const change of ['active', 'process']) {
		using owner = new DisposableStore();
		const f = fixture(owner);
		const command = f.commands.executeCommand(TerminalDeveloperCommandId.WriteDataToTerminal);
		await f.prompted.p;
		if (change === 'active') f.activeChanged.fire(undefined);
		else f.changed.fire('reconnecting');
		await f.prompt.complete('retired');
		await command;
		assert.deepEqual(f.displayWrites, []);
	}
});

test('Developer Record Session subscribes before process startup, captures output and sizes through TerminalRecorder, then copies after inactivity', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using owner = new DisposableStore();
		const f = fixture(owner);
		const command = f.commands.executeCommand(TerminalDeveloperCommandId.RecordSession);
		await f.started.p;
		assert.deepEqual(f.creationOptions(), { deferStart: true, location: 1 });
		f.resized.fire({ cols: 92, rows: 30 });
		f.output.fire({ data: 'second output', trackCommit: false });
		f.input.fire('typed input');
		assert.equal(f.statusbar.getEntries(StatusbarAlignment.Left).length, 1);
		mock.timers.tick(5000);
		await command;
		assert.deepEqual(JSON.parse(f.clipboard[0]), {
			replay: {
				events: [
					{ cols: 80, rows: 24, data: 'first child output' },
					{ cols: 92, rows: 30, data: 'second output' },
				],
			},
			events: [{ type: 'input', data: 'typed input' }],
			truncated: false,
		});
		assert.equal(f.statusbar.getEntries(StatusbarAlignment.Left).length, 0);
		assert.equal(f.input.hasListeners(), false);
		assert.equal(f.output.hasListeners(), false);
		assert.equal(f.resized.hasListeners(), false);
	} finally {
		mock.timers.reset();
	}
});

test('Developer Record Session status entry stops recording and disposed terminals settle it once without retained listeners', async () => {
	for (const reason of ['entry', 'dispose']) {
		using owner = new DisposableStore();
		const f = fixture(owner);
		const command = f.commands.executeCommand(TerminalDeveloperCommandId.RecordSession);
		await f.started.p;
		if (reason === 'entry') f.statusbar.getEntries(StatusbarAlignment.Left)[0].entry.run!();
		else f.disposed.fire(f.instance);
		await command;
		f.disposed.fire(f.instance);
		assert.equal(f.clipboard.length, 1);
		assert.equal(f.statusbar.getEntries(StatusbarAlignment.Left).length, 0);
		assert.equal(f.output.hasListeners(), false);
	}
});

test('Developer Record Session bounds input capture and marks a stopped capture as truncated', async () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	const command = f.commands.executeCommand(TerminalDeveloperCommandId.RecordSession);
	await f.started.p;
	f.input.fire('x'.repeat(600000));
	await command;
	const capture = JSON.parse(f.clipboard[0]);
	assert.equal(capture.truncated, true);
	assert.deepEqual(capture.events, []);
	assert.equal(f.input.hasListeners(), false);
	assert.equal(f.statusbar.getEntries(StatusbarAlignment.Left).length, 0);
});
