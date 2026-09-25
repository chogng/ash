import assert from 'node:assert/strict';
import { test } from 'mocha';
import { TrustedIpcRouter, type IpcMainInvokeEventLike, type IpcMainLike } from '../../../ipc/electron-main/trustedIpcRouter.js';
import { OPEN_DEDICATED_WINDOW_CHANNEL, RETURN_TO_PARENT_WINDOW_CHANNEL } from '../../common/dedicatedWindow.js';
import { openDedicatedWindowIpcRoute, returnToParentWindowIpcRoute } from '../../electron-main/dedicatedWindowIpc.js';

class FakeIpcMain implements IpcMainLike {
	readonly handlers = new Map<string, (event: IpcMainInvokeEventLike, params: unknown) => unknown>();

	handle(channel: string, listener: (event: IpcMainInvokeEventLike, params: unknown) => unknown): void {
		this.handlers.set(channel, listener);
	}

	removeHandler(channel: string): void {
		this.handlers.delete(channel);
	}
}

function target(url: string) {
	const mainFrame = { url };
	const webContents = { mainFrame };
	return { webContents, event: { sender: webContents, senderFrame: mainFrame } };
}

test('dedicated window IPC grants open to the parent and return to the child only', async () => {
	const ipcMain = new FakeIpcMain();
	using router = new TrustedIpcRouter(ipcMain);
	const parentUrl = 'file:///app-rs/workbench.html';
	const childUrl = 'file:///app-rs/sessions.html';
	const parent = target(parentUrl);
	const child = target(childUrl);
	const calls: string[] = [];
	const parentRegistration = router.register({
		webContents: parent.webContents,
		allowedEntryUrls: new Set([parentUrl]),
	}, [openDedicatedWindowIpcRoute(() => { calls.push('open'); })]);
	const childRegistration = router.register({
		webContents: child.webContents,
		allowedEntryUrls: new Set([childUrl]),
	}, [returnToParentWindowIpcRoute(() => { calls.push('return'); })]);
	const open = ipcMain.handlers.get(OPEN_DEDICATED_WINDOW_CHANNEL)!;
	const returnToParent = ipcMain.handlers.get(RETURN_TO_PARENT_WINDOW_CHANNEL)!;

	assert.equal(await open(parent.event, undefined), undefined);
	assert.equal(await returnToParent(child.event, undefined), undefined);
	assert.deepEqual(calls, ['open', 'return']);
	assert.throws(() => open(child.event, undefined), /Untrusted renderer IPC sender/);
	assert.throws(() => returnToParent(parent.event, undefined), /Untrusted renderer IPC sender/);
	assert.throws(() => open(parent.event, { windowId: 1 }), /do not accept parameters/);
	assert.throws(() => returnToParent(child.event, { windowId: 1 }), /do not accept parameters/);
	assert.deepEqual(calls, ['open', 'return']);

	childRegistration.dispose();
	assert.equal(ipcMain.handlers.has(RETURN_TO_PARENT_WINDOW_CHANNEL), false);
	assert.equal(ipcMain.handlers.has(OPEN_DEDICATED_WINDOW_CHANNEL), true);
	parentRegistration.dispose();
	assert.equal(ipcMain.handlers.size, 0);
});
