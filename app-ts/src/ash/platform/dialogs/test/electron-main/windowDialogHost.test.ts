import assert from 'node:assert/strict';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { test } from 'mocha';
import { DialogResult, DialogSeverity } from '../../common/dialogs.js';
import { WindowDialogHost } from '../../electron-main/windowDialogHost.js';

test('window dialog host maps message, confirmation, and prompt results', async () => {
	const options: MessageBoxOptions[] = [];
	const responses = [0, 1, 1, 2];
	using host = new WindowDialogHost({} as BrowserWindow, async (_window, value) => {
		options.push(value);
		return { response: responses.shift()!, checkboxChecked: true };
	});
	const message = await host.perform({ kind: 'show', id: 1, request: { kind: 'message', severity: DialogSeverity.Info, message: 'Notice' } });
	const confirmation = await host.perform({ kind: 'show', id: 2, request: { kind: 'confirmation', message: 'Continue?' } });
	const prompt = await host.perform({ kind: 'show', id: 3, request: { kind: 'prompt', message: 'Save?', primaryButton: 'Save', secondaryButton: 'Discard' } });
	const cancelledPrompt = await host.perform({ kind: 'show', id: 4, request: { kind: 'prompt', message: 'Save?', primaryButton: 'Save', secondaryButton: 'Discard' } });
	assert.deepEqual({ message, confirmation, prompt, cancelledPrompt, buttons: options.map(value => value.buttons) }, {
		message: { button: DialogResult.Primary, checkboxChecked: true },
		confirmation: { button: DialogResult.Cancel, checkboxChecked: true },
		prompt: { button: DialogResult.Secondary, checkboxChecked: true },
		cancelledPrompt: { button: DialogResult.Cancel, checkboxChecked: true },
		buttons: [['OK'], ['Confirm', 'Cancel'], ['Save', 'Discard', 'Cancel'], ['Save', 'Discard', 'Cancel']],
	});
});

test('window dialog host returns cancellation when a request or window is aborted', async () => {
	let requested!: MessageBoxOptions;
	const showMessageBox = async (_window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue> => {
		requested = options;
		return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
	};
	const host = new WindowDialogHost({} as BrowserWindow, showMessageBox);
	const first = host.perform({ kind: 'show', id: 1, request: { kind: 'message', severity: DialogSeverity.Error, message: 'Error' } });
	await host.perform({ kind: 'cancel', id: 1 });
	assert.equal(requested.signal?.aborted, true);
	assert.deepEqual(await first, { button: DialogResult.Cancel });
	const second = host.perform({ kind: 'show', id: 2, request: { kind: 'confirmation', message: 'Continue?' } });
	host.dispose();
	assert.deepEqual(await second, { button: DialogResult.Cancel });
});
