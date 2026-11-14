import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, HandlerDetails } from 'electron';
import { test } from 'mocha';
import { ContextMenuWindow } from '../../electron-main/contextMenuWindow.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

class TestWindow extends EventEmitter {
	readonly webContents = Object.assign(new EventEmitter(), {
		setWindowOpenHandler: (handler: () => { action: string; }) => { this.openHandler = handler; },
	});
	openHandler: (() => { action: string; }) | undefined;
	closes = 0;
	menu: unknown;
	private destroyed = false;
	getContentBounds() { return { x: 100, y: 100, width: 1200, height: 800 }; }
	isDestroyed() { return this.destroyed; }
	setMenu(menu: unknown) { this.menu = menu; }
	close() { this.closes++; this.destroyed = true; this.emit('closed'); }
	get native() { return this as unknown as BrowserWindow; }
}

test('menu windows admit only their empty document and enforce a non-modal sandbox', () => {
	const parent = new TestWindow();
	using windows = new ContextMenuWindow(parent.native);
	const request = { url: 'about:blank', frameName: 'ash-context-menu-11111111-1111-4111-8111-111111111111', features: 'x=120,y=180,nodeIntegration=yes' } as HandlerDetails;
	const options = windows.getWindowOpenOptions(request)!;
	assert.equal(options.parent, parent.native);
	assert.deepEqual([options.modal, options.frame, options.transparent, options.x, options.y], [false, false, true, 120, 180]);
	assert.deepEqual(options.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1 });
	assert.equal(windows.getWindowOpenOptions({ ...request, url: 'https://example.test/' }), undefined);
	assert.equal(windows.getWindowOpenOptions({ ...request, frameName: 'ash-auxiliary-other' }), undefined);
	assert.throws(() => windows.getWindowOpenOptions({ ...request, features: 'x=NaN' }), /Invalid menu window x/);
});

test('navigation is blocked and parent changes release every menu window', () => {
	const parent = new TestWindow();
	const child = new TestWindow();
	const windows = new ContextMenuWindow(parent.native);
	windows.registerWindow(child.native);
	assert.equal(child.menu, null);
	assert.deepEqual(child.openHandler?.(), { action: 'deny' });
	let prevented = 0;
	child.webContents.emit('will-navigate', { preventDefault() { prevented++; } });
	assert.equal(prevented, 1);
	parent.emit('resize');
	assert.equal(child.closes, 1);
	assert.equal(child.webContents.listenerCount('will-navigate'), 0);
	const replacement = new TestWindow();
	windows.registerWindow(replacement.native);
	windows.dispose();
	assert.equal(replacement.closes, 1);
	assert.equal(parent.listenerCount('resize'), 0);
	assert.equal(parent.webContents.listenerCount('did-start-navigation'), 0);
});
