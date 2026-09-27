import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { test } from 'mocha';
import { DialogResult, DialogSeverity } from '../../common/dialogs.js';
import { DialogMainService, type ISystemDialogApi } from '../../electron-main/dialogMainService.js';
import { massageMessageBoxOptions } from '../../electron-main/dialogMainUtils.js';

function windowWithId(id: number): BrowserWindow {
	return { id } as BrowserWindow;
}

function api(
	showMessageBox: ISystemDialogApi['showMessageBox'] = async () => ({ response: 0, checkboxChecked: false }),
	showOpenDialog: ISystemDialogApi['showOpenDialog'] = async () => ({ canceled: true, filePaths: [] }),
	showSaveDialog: ISystemDialogApi['showSaveDialog'] = async () => ({ canceled: true, filePath: '' }),
): ISystemDialogApi {
	return { showMessageBox, showOpenDialog, showSaveDialog };
}

test('message box button order preserves caller response indices on Linux', () => {
	const prepared = massageMessageBoxOptions({
		message: 'Save changes?',
		buttons: ['Save', 'Discard', 'Cancel'],
		defaultId: 0,
		cancelId: 2,
	}, 'linux');
	assert.deepEqual({
		buttons: prepared.options.buttons,
		defaultId: prepared.options.defaultId,
		cancelId: prepared.options.cancelId,
		buttonIndices: prepared.buttonIndices,
		noLink: prepared.options.noLink,
	}, {
		buttons: ['Discard', 'Cancel', 'Save'],
		defaultId: 2,
		cancelId: 1,
		buttonIndices: [1, 2, 0],
		noLink: true,
	});
});

test('four-button prompt keeps its cancel and default positions on Linux', () => {
	const prepared = massageMessageBoxOptions({
		message: 'Choose', buttons: ['First', 'Second', 'Third', 'Cancel'], defaultId: 0, cancelId: 3,
	}, 'linux');
	assert.deepEqual({
		buttons: prepared.options.buttons,
		defaultId: prepared.options.defaultId,
		cancelId: prepared.options.cancelId,
		buttonIndices: prepared.buttonIndices,
	}, {
		buttons: ['Third', 'Second', 'Cancel', 'First'],
		defaultId: 3,
		cancelId: 2,
		buttonIndices: [2, 1, 3, 0],
	});
});

test('dialog main service maps message, confirmation, and prompt results', async () => {
	const options: MessageBoxOptions[] = [];
	const responses = [0, 1, 1, 2];
	using dialogs = new DialogMainService(api(async value => {
		options.push(value);
		return { response: responses.shift()!, checkboxChecked: true };
	}));
	const window = windowWithId(1);
	const message = await dialogs.perform(window, { kind: 'show', id: 1, request: { kind: 'message', severity: DialogSeverity.Info, message: 'Notice' } });
	const confirmation = await dialogs.perform(window, { kind: 'show', id: 2, request: { kind: 'confirmation', message: 'Continue?' } });
	const prompt = await dialogs.perform(window, { kind: 'show', id: 3, request: { kind: 'prompt', message: 'Save?', primaryButton: 'Save', secondaryButton: 'Discard' } });
	const cancelledPrompt = await dialogs.perform(window, { kind: 'show', id: 4, request: { kind: 'prompt', message: 'Save?', primaryButton: 'Save', secondaryButton: 'Discard' } });
	assert.deepEqual({ message, confirmation, prompt, cancelledPrompt, buttons: options.map(value => value.buttons) }, {
		message: { button: DialogResult.Primary, checkboxChecked: true },
		confirmation: { button: DialogResult.Cancel, checkboxChecked: true },
		prompt: { button: DialogResult.Secondary, checkboxChecked: true },
		cancelledPrompt: { button: DialogResult.Cancel, checkboxChecked: true },
		buttons: [['OK'], ['Confirm', 'Cancel'], ['Save', 'Discard', 'Cancel'], ['Save', 'Discard', 'Cancel']],
	});
});

test('dialog main service returns the selected action index and checkbox state', async () => {
	let shown: MessageBoxOptions | undefined;
	using dialogs = new DialogMainService(api(async options => {
		shown = options;
		return { response: 2, checkboxChecked: true };
	}));
	const request = { kind: 'choice' as const, severity: DialogSeverity.Warning, message: 'Choose action', buttons: ['First', 'Second', 'Third'], cancelButton: 'Cancel' };
	const result = await dialogs.perform(windowWithId(11), { kind: 'show', id: 1, request });
	assert.deepEqual(shown?.buttons, ['First', 'Second', 'Third', 'Cancel']);
	assert.equal(shown?.type, 'warning');
	assert.deepEqual(result, { button: DialogResult.Primary, buttonIndex: 2, checkboxChecked: true });
});

test('dialog main service cancels active and queued renderer requests', async () => {
	let activeOptions!: MessageBoxOptions;
	let releaseActive!: (result: MessageBoxReturnValue) => void;
	let shows = 0;
	using dialogs = new DialogMainService(api(async options => {
		shows += 1;
		activeOptions = options;
		return new Promise(resolve => { releaseActive = resolve; });
	}));
	const window = windowWithId(2);
	const first = dialogs.perform(window, { kind: 'show', id: 1, request: { kind: 'message', severity: DialogSeverity.Error, message: 'Error' } });
	const second = dialogs.perform(window, { kind: 'show', id: 2, request: { kind: 'confirmation', message: 'Continue?' } });
	await Promise.resolve();
	await Promise.resolve();
	dialogs.cancelWindow(window);
	assert.equal(activeOptions.signal?.aborted, true);
	releaseActive({ response: 0, checkboxChecked: false });
	assert.deepEqual([await first, await second, shows], [{ button: DialogResult.Cancel }, { button: DialogResult.Cancel }, 1]);
});

test('dialog main service serializes system dialogs per window and rejects duplicate file dialogs', async () => {
	const started: string[] = [];
	let releaseFirst!: () => void;
	using dialogs = new DialogMainService(api(
		async (_options, window) => {
			started.push(`message:${window?.id}`);
			await new Promise<void>(resolve => { releaseFirst = resolve; });
			return { response: 0, checkboxChecked: false };
		},
		async (_options: OpenDialogOptions, window) => {
			started.push(`open:${window?.id}`);
			return { canceled: false, filePaths: ['/picked'] };
		},
		async (_options: SaveDialogOptions, window) => {
			started.push(`save:${window?.id}`);
			return { canceled: false, filePath: '/saved' };
		},
	));
	const firstWindow = windowWithId(3);
	const secondWindow = windowWithId(4);
	const message = dialogs.showMessageBox({ message: 'First' }, firstWindow);
	const open = dialogs.showOpenDialog({ properties: ['openFile'] }, firstWindow);
	const duplicateOpen = dialogs.showOpenDialog({ properties: ['openFile'] }, firstWindow);
	const save = dialogs.showSaveDialog({ title: 'Save' }, secondWindow);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(started, ['message:3', 'save:4']);
	assert.deepEqual(await duplicateOpen, { canceled: true, filePaths: [] });
	releaseFirst();
	await Promise.all([message, open, save]);
	assert.deepEqual(started, ['message:3', 'save:4', 'open:3']);
});

test('closing a window cancels its queued file dialog', async () => {
	let releaseMessage!: () => void;
	let fileShows = 0;
	using dialogs = new DialogMainService(api(
		async () => {
			await new Promise<void>(resolve => { releaseMessage = resolve; });
			return { response: 0, checkboxChecked: false };
		},
		async () => {
			fileShows += 1;
			return { canceled: false, filePaths: ['/picked'] };
		},
	));
	const window = windowWithId(5);
	const message = dialogs.showMessageBox({ message: 'First' }, window);
	const file = dialogs.showOpenDialog({ properties: ['openFile'] }, window);
	await Promise.resolve();
	await Promise.resolve();
	dialogs.cancelWindow(window);
	releaseMessage();
	await message;
	assert.deepEqual([await file, fileShows], [{ canceled: true, filePaths: [] }, 0]);
});

test('file dialog ignores a missing default path and releases its lock after completion', async () => {
	const defaults: Array<string | undefined> = [];
	using dialogs = new DialogMainService(api(undefined, async options => {
		defaults.push(options.defaultPath);
		return { canceled: false, filePaths: ['/picked'] };
	}));
	const window = windowWithId(6);
	const options = { properties: ['openFile' as const], defaultPath: join(tmpdir(), `missing-ash-dialog-${randomUUID()}`) };
	await dialogs.showOpenDialog(options, window);
	await dialogs.showOpenDialog(options, window);
	assert.deepEqual(defaults, [undefined, undefined]);
});
