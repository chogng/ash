import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { environment } from '../../../../../../base/common/platform.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { ITerminalService, type ITerminalInstance, type IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import { TerminalExtensionsRegistry } from '../../../../terminal/browser/terminalExtensions.js';
import { TerminalClipboardContribution } from '../../browser/terminal.clipboard.contribution.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { TerminalSettingId } from '../../../../../../platform/terminal/common/terminal.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import '../../../../terminal/common/terminalConfiguration.js';
import { shouldPasteTerminalText } from '../../browser/terminalClipboard.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstanceContext } from '../../../../terminal/browser/terminalContextMenu.js';
import { TerminalCommandId } from '../../../../terminal/common/terminal.js';

for (const newline of ['\n', '\r\n', '\r']) {
	test(`terminal paste handles ${JSON.stringify(newline)} with auto, always and never policies`, async () => {
		using services = new InstantiationService();
		using configuration = new InMemoryConfigurationService();
		using dialogs = new DialogService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IDialogService, dialogs);
		let confirmations = 0;
		using listener = dialogs.model.onWillShowDialog(item => {
			confirmations++;
			item.close({ button: DialogResult.Cancel });
		});
		const paste = (text: string, bracketed = false) => services.invokeFunction(shouldPasteTerminalText, text, bracketed);
		const single = `echo hello${newline} \t`;
		const multiple = `echo hello${newline}echo world`;
		assert.equal(configuration.getValue(TerminalSettingId.EnableMultiLinePasteWarning), 'auto');
		assert.equal(await paste('echo hello'), true);
		assert.deepEqual(await paste(single), { modifiedText: 'echo hello' });
		assert.equal(await paste(single, true), true);
		assert.equal(await paste(multiple), false);
		assert.equal(await paste(multiple, true), true);
		assert.equal(confirmations, 1);

		await configuration.updateValue(TerminalSettingId.EnableMultiLinePasteWarning, 'always');
		assert.equal(await paste('echo hello'), true);
		assert.equal(await paste(single), false);
		assert.equal(await paste(multiple, true), false);
		assert.equal(confirmations, 3);
		await configuration.updateValue(TerminalSettingId.EnableMultiLinePasteWarning, 'never');
		assert.equal(await paste(single), true);
		assert.equal(await paste(multiple, true), true);
		assert.equal(confirmations, 3);
	});
}

test('terminal paste confirmation bounds its preview without rewriting accepted text', async () => {
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	using dialogs = new DialogService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IDialogService, dialogs);
	using listener = dialogs.model.onWillShowDialog(item => {
		assert.ok(item.request.detail!.length < 2200);
		assert.ok(item.request.detail!.split('\n').length <= 12);
		assert.ok(!item.request.detail!.includes('hidden tail'));
		item.close({ button: DialogResult.Primary, buttonIndex: 0 });
	});
	const text = `${'a'.repeat(3000)}\n${'line\n'.repeat(20)}hidden tail`;
	assert.equal(await services.invokeFunction(shouldPasteTerminalText, text, false), true);
});

for (const policy of [false, true, 123, 'unknown']) {
	test(`terminal paste respects legacy or invalid warning policy ${JSON.stringify(policy)}`, async () => {
		using services = new InstantiationService();
		using dialogs = new DialogService();
		services.registerInstance(IConfigurationService, {
			getValue: () => policy,
		} as unknown as IConfigurationService);
		services.registerInstance(IDialogService, dialogs);
		let confirmations = 0;
		using listener = dialogs.model.onWillShowDialog(item => {
			confirmations++;
			item.close({ button: DialogResult.Cancel });
		});
		assert.equal(await services.invokeFunction(shouldPasteTerminalText, 'first\nsecond', false), policy === false);
		assert.equal(confirmations, policy === false ? 0 : 1);
		assert.equal(await services.invokeFunction(shouldPasteTerminalText, 'first\nsecond', true), true);
	});
}

function clipboardFixture() {
	const store = new DisposableStore();
	const dom = new JSDOM('<div><textarea></textarea></div><input>');
	store.add(toDisposable(() => dom.window.close()));
	const configuration = store.add(new InMemoryConfigurationService());
	const services = store.add(new InstantiationService());
	const contextKeys = store.add(new ContextKeyService());
	const activeChanged = store.add(new Emitter<ITerminalInstance | undefined>());
	const stateChanged = store.add(new Emitter<ITerminalInstance['state']>());
	const selectionChanged = store.add(new Emitter<void>());
	let selection = '';
	let selectionX = 0;
	let activeInstance: ITerminalInstance | undefined;
	const copied: string[] = [];
	const sent: string[] = [];
	const sendCalls: Array<{ text: string; shouldExecute: boolean; bracketedPaste: boolean | undefined }> = [];
	const sendStarted = new DeferredPromise<void>();
	let sendGate: Promise<void> | undefined;
	const errors: unknown[] = [];
	const reported = new DeferredPromise<void>();
	let read: () => Promise<string> = async () => 'pasted';
	let write: (text: string) => Promise<void> = async text => {
		copied.push(text);
	};
	const element = dom.window.document.querySelector('div')!;
	const textarea = dom.window.document.querySelector('textarea')!;
	const instance = {
		instanceId: 1,
		getContribution: () => contribution,
		state: 'running',
		onDidChangeState: stateChanged.event,
		onDidExit: Event.None,
		sendText: async (text: string, shouldExecute: boolean, bracketedPaste?: boolean) => {
			sent.push(text);
			sendCalls.push({ text, shouldExecute, bracketedPaste });
			await sendStarted.complete();
			await sendGate;
		},
	} as unknown as ITerminalInstance;
	activeInstance = instance;
	const instances = [instance];
	const screen = {
		element,
		isDisposed: false,
		onDidRequestRunCommand: Event.None,
		focus: () => textarea.focus(),
		raw: {
			textarea,
			options: {},
			modes: { bracketedPasteMode: false },
			onSelectionChange: selectionChanged.event,
			hasSelection: () => !!selection,
			getSelection: () => selection,
			getSelectionPosition: () => (selection ? { start: { x: selectionX, y: 0 }, end: { x: selectionX + selection.length, y: 0 } } : undefined),
			clearSelection: () => {
				selection = '';
				selectionChanged.fire();
			},
		},
	} as unknown as IXtermTerminal;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, contextKeys);
	const dialogs = store.add(new DialogService());
	services.registerInstance(IDialogService, dialogs);
	services.registerInstance(IClipboardService, {
		readText: () => read(),
		writeText: (text: string) => write(text),
	} as IClipboardService);
	services.registerInstance(INotificationService, {
		error: (error: unknown) => {
			errors.push(error);
			void reported.complete();
		},
	} as INotificationService);
	services.registerInstance(ITerminalService, {
		instances,
		get activeInstance() {
			return activeInstance;
		},
		onDidChangeActiveInstance: activeChanged.event,
		setActiveInstance: (value: ITerminalInstance | undefined) => {
			activeInstance = value;
			activeChanged.fire(value);
		},
	} as unknown as ITerminalService);
	const registration = TerminalExtensionsRegistry.getTerminalContributions().find(item => item.id === TerminalClipboardContribution.ID)!;
	const contribution = store.add(services.createInstance(registration.ctor, { instance })) as TerminalClipboardContribution;
	contribution.xtermReady(screen);
	return {
		context: new InstanceContext(instance),
		command: (id: string, context?: unknown) => services.invokeFunction(CommandsRegistry.getCommands().get(id)!.handler, context),
		closeTarget: () => {
			instances.length = 0;
		},
		[Symbol.dispose]: () => store.dispose(),
		configuration,
		contribution,
		copied,
		sent,
		sendCalls,
		errors,
		element,
		textarea,
		screen,
		dialogs,
		sendStarted: sendStarted.p,
		reported: reported.p,
		select: (value: string, x = 0) => {
			selection = value;
			selectionX = x;
			selectionChanged.fire();
		},
		selection: () => selection,
		read: (value: () => Promise<string>) => {
			read = value;
		},
		write: (value: (text: string) => Promise<void>) => {
			write = value;
		},
		delaySend: (gate: Promise<void>) => {
			sendGate = gate;
		},
		reconnect: () => {
			stateChanged.fire('reconnecting');
			stateChanged.fire('running');
		},
		switch: () => {
			activeInstance = undefined;
			activeChanged.fire(undefined);
		},
		outside: () => dom.window.document.querySelector('input')!.focus(),
		mouse: (type = 'mousedown', shiftKey = false) => {
			const event = new dom.window.MouseEvent(type, { button: 2, bubbles: true, cancelable: true, shiftKey });
			element.dispatchEvent(event);
			return event;
		},
	};
}

test('terminal clipboard commands honor captured and serialized targets and reject closed targets', async () => {
	using fixture = clipboardFixture();
	fixture.select('original selection');
	fixture.switch();
	await fixture.command(TerminalCommandId.CopySelection, fixture.context);
	await fixture.command(TerminalCommandId.CopySelection, fixture.context.toJSON());
	assert.deepEqual(fixture.copied, ['original selection', 'original selection']);
	await fixture.command(TerminalCommandId.Paste, fixture.context);
	assert.deepEqual(fixture.sent, ['pasted']);
	fixture.closeTarget();
	for (const command of [TerminalCommandId.CopySelection, TerminalCommandId.Paste]) {
		await assert.rejects(async () => fixture.command(command, fixture.context), /This terminal has been closed/);
		for (const context of [null, {}, { instanceId: 1 }, { ...fixture.context.toJSON(), instanceId: -1 }]) {
			await assert.rejects(async () => fixture.command(command, context), /Invalid terminal instance context/);
		}
	}
	assert.deepEqual(fixture.sent, ['pasted']);
});

for (const newline of ['\n', '\r\n', '\r']) {
	test(`terminal Paste as One Line preserves whitespace and waits for acknowledged input with ${JSON.stringify(newline)}`, async () => {
		using fixture = clipboardFixture();
		fixture.read(async () => ` echo first ${newline}\techo second ${newline}`);
		const acknowledged = new DeferredPromise<void>();
		fixture.delaySend(acknowledged.p);
		using listener = fixture.dialogs.model.onWillShowDialog(item => {
			assert.equal(item.request.kind, 'choice');
			assert.deepEqual(item.request.kind === 'choice' && item.request.buttons, ['Paste', 'Paste as One Line']);
			item.close({ button: DialogResult.Secondary, buttonIndex: 1 });
		});
		let completed = false;
		const paste = fixture.contribution.paste().then(() => {
			completed = true;
		});
		await fixture.sendStarted;
		assert.deepEqual(fixture.sendCalls, [{ text: ' echo first \techo second ', shouldExecute: false, bracketedPaste: true }]);
		assert.equal(completed, false);
		await acknowledged.complete();
		await paste;
		assert.equal(completed, true);
		assert.equal(fixture.configuration.getValue(TerminalSettingId.EnableMultiLinePasteWarning), 'auto');
	});
}

test('terminal paste remembers an accepted warning choice and preserves original newlines', async () => {
	using fixture = clipboardFixture();
	const text = 'first\r\nsecond\n';
	fixture.read(async () => text);
	let confirmations = 0;
	using listener = fixture.dialogs.model.onWillShowDialog(item => {
		confirmations++;
		item.close({ button: DialogResult.Primary, buttonIndex: 0, checkboxChecked: true });
	});
	await fixture.contribution.paste();
	assert.equal(fixture.configuration.getValue(TerminalSettingId.EnableMultiLinePasteWarning), 'never');
	await fixture.contribution.paste();
	assert.equal(confirmations, 1);
	assert.deepEqual(fixture.sent, [text, text]);
});

test('terminal paste cancel leaves input and warning preferences untouched', async () => {
	using fixture = clipboardFixture();
	fixture.read(async () => 'first\nsecond');
	using listener = fixture.dialogs.model.onWillShowDialog(item => {
		item.close({ button: DialogResult.Cancel, checkboxChecked: true });
	});
	await fixture.contribution.paste();
	assert.deepEqual(fixture.sent, []);
	assert.equal(fixture.configuration.getValue(TerminalSettingId.EnableMultiLinePasteWarning), 'auto');
});

for (const transition of ['switch', 'reconnect', 'dispose'] as const) {
	test(`terminal paste drops an accepted single-line choice after ${transition}`, async () => {
		using fixture = clipboardFixture();
		fixture.read(async () => 'first\nsecond');
		using listener = fixture.dialogs.model.onWillShowDialog(item => {
			if (transition === 'switch') fixture.switch();
			else if (transition === 'reconnect') fixture.reconnect();
			else fixture.contribution.dispose();
			item.close({ button: DialogResult.Secondary, buttonIndex: 1 });
		});
		await fixture.contribution.paste();
		assert.deepEqual(fixture.sent, []);
	});
}

test('terminal auto-copy is configurable, ignores empty selections and reports clipboard failures', async () => {
	using fixture = clipboardFixture();
	assert.equal(fixture.configuration.getValue(TerminalSettingId.CopyOnSelection), false);
	assert.equal(fixture.configuration.getValue(TerminalSettingId.RightClickBehavior), environment.os === 'mac' ? 'selectWord' : environment.os === 'windows' ? 'copyPaste' : 'default');
	fixture.select('disabled');
	assert.deepEqual(fixture.copied, []);
	await fixture.configuration.updateValue(TerminalSettingId.CopyOnSelection, true);
	fixture.select('unfocused');
	assert.deepEqual(fixture.copied, []);
	fixture.textarea.focus();
	fixture.select('enabled');
	fixture.select('');
	assert.deepEqual(fixture.copied, ['enabled']);
	const error = new Error('Write denied');
	fixture.write(async () => {
		throw error;
	});
	fixture.select('still selected');
	await fixture.reported;
	assert.deepEqual(fixture.errors, [error]);
	assert.equal(fixture.selection(), 'still selected');
	fixture.switch();
	fixture.select('background');
	assert.deepEqual(fixture.copied, ['enabled']);
});

test('terminal right click copies and clears only after its clipboard write succeeds', async () => {
	using fixture = clipboardFixture();
	await fixture.configuration.updateValue(TerminalSettingId.RightClickBehavior, 'copyPaste');
	fixture.select('original');
	const pending = new DeferredPromise<void>();
	fixture.write(() => pending.p);
	const operation = fixture.contribution.handleMouseEvent({ button: 2, shiftKey: false } as MouseEvent);
	assert.equal(fixture.selection(), 'original');
	fixture.select('new selection');
	await pending.complete();
	assert.deepEqual(await operation, { handled: true });
	assert.equal(fixture.selection(), 'new selection');
	fixture.write(async () => {
		throw new Error('Write denied');
	});
	await assert.rejects(fixture.contribution.handleMouseEvent({ button: 2, shiftKey: false } as MouseEvent), /Write denied/);
	assert.equal(fixture.selection(), 'new selection');
	fixture.write(async () => {});
	await fixture.contribution.handleMouseEvent({ button: 2, shiftKey: false } as MouseEvent);
	assert.equal(fixture.selection(), '');
});

for (const transition of ['focus', 'switch', 'dispose'] as const) {
	test(`terminal right click drops its delayed clipboard read after ${transition}`, async () => {
		using fixture = clipboardFixture();
		await fixture.configuration.updateValue(TerminalSettingId.RightClickBehavior, 'paste');
		const pending = new DeferredPromise<string>();
		fixture.read(() => pending.p);
		const operation = fixture.contribution.handleMouseEvent({ button: 2, shiftKey: false } as MouseEvent);
		if (transition === 'focus') {
			fixture.outside();
			fixture.textarea.focus();
		} else if (transition === 'switch') fixture.switch();
		else fixture.contribution.dispose();
		await pending.complete('stale');
		await operation;
		assert.deepEqual(fixture.sent, []);
	});
}

test('terminal mouse policy preserves Shift and keyboard menus and updates word selection', async () => {
	using fixture = clipboardFixture();
	for (const behavior of ['default', 'copyPaste', 'paste', 'selectWord', 'nothing']) {
		await fixture.configuration.updateValue(TerminalSettingId.RightClickBehavior, behavior);
		assert.equal(fixture.screen.raw.options.rightClickSelectsWord, behavior === 'selectWord');
		assert.equal(fixture.mouse('contextmenu').defaultPrevented, ['copyPaste', 'paste', 'nothing'].includes(behavior));
		assert.equal(fixture.mouse('contextmenu', true).defaultPrevented, false);
		assert.equal(fixture.mouse('mousedown', true).defaultPrevented, false);
	}
	await fixture.configuration.updateValue(TerminalSettingId.RightClickBehavior, 'paste');
	for (const markup of ['<div class="ash-terminal-widget-overlay"><input></div>', '<div role="button"></div>']) {
		fixture.element.insertAdjacentHTML('beforeend', markup);
		const interactive = fixture.element.lastElementChild!;
		const event = new fixture.element.ownerDocument.defaultView!.MouseEvent('mousedown', {
			button: 2,
			bubbles: true,
			cancelable: true,
		});
		interactive.dispatchEvent(event);
		assert.equal(event.defaultPrevented, false);
		interactive.remove();
	}
	const pending = new DeferredPromise<string>();
	fixture.read(() => pending.p);
	assert.equal(fixture.mouse().defaultPrevented, true);
	await pending.error(new Error('Read denied'));
	await fixture.reported;
	assert.equal((fixture.errors[0] as Error).message, 'Read denied');
	assert.deepEqual(fixture.sent, []);
	fixture.contribution.dispose();
	assert.equal(fixture.mouse().defaultPrevented, false);
});
