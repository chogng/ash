import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, SaveDialogOptions } from '../../../../base/parts/sandbox/common/electronTypes.js';
import { test } from 'mocha';
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
	const first = dialogs.perform(window, { kind: 'show', id: 1, options: { message: 'Error', buttons: ['OK'], cancelId: 0 } });
	const second = dialogs.perform(window, { kind: 'show', id: 2, options: { message: 'Continue?', buttons: ['Confirm', 'Cancel'], cancelId: 1 } });
	await Promise.resolve();
	await Promise.resolve();
	dialogs.cancelWindow(window);
	assert.equal(activeOptions.signal?.aborted, true);
	releaseActive({ response: 0, checkboxChecked: false });
	assert.deepEqual([await first, await second, shows], [{ response: 0, checkboxChecked: false }, { response: 1, checkboxChecked: false }, 1]);
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
