import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, HandlerDetails } from 'electron';
import { test } from 'mocha';
import { ContextMenuWindow } from '../../electron-main/contextMenuWindow.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

class TestWindow extends EventEmitter {
	readonly webContents = Object.assign(new EventEmitter(), {
		mainFrame: { name: '' },
		setWindowOpenHandler: (handler: () => { action: string; }) => { this.openHandler = handler; },
	});
	openHandler: (() => { action: string; }) | undefined;
	closes = 0;
	menu: unknown;
	private destroyed = false;
	focused = false;
	visible = false;
	bounds = { x: 0, y: 33, width: 480, height: 720 };
	readonly children: TestWindow[] = [];
	constructor(parent?: TestWindow) { super(); parent?.children.push(this); }
	getChildWindows() { return this.children.filter(window => !window.isDestroyed()).map(window => window.native); }
	setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
	isVisible() { return this.visible; }
	show() { this.visible = this.focused = true; this.emit('show'); this.emit('focus'); }
	isFocused() { return this.focused; }
	getContentBounds() { return { x: 100, y: 100, width: 1200, height: 800 }; }
	isDestroyed() { return this.destroyed; }
	setMenu(menu: unknown) { this.menu = menu; }
	close() { this.closes++; this.destroyed = true; this.emit('closed'); }
	get native() { return this as unknown as BrowserWindow; }
}

test('menu windows admit only their empty document and enforce a non-modal sandbox', () => {
	const parent = new TestWindow();
	using windows = new ContextMenuWindow(parent.native, () => { });
	const request = { url: 'about:blank', frameName: 'ash-context-menu-11111111-1111-4111-8111-111111111111', features: 'x=120,y=180,width=9999,height=9999,nodeIntegration=yes' } as HandlerDetails;
	const options = windows.getWindowOpenOptions(request)!;
	assert.equal(options.parent, parent.native);
	assert.equal(options.show, false, 'The initial left-hand bounds must never be visible');
	assert.deepEqual([options.modal, options.frame, options.transparent], [false, false, true]);
	assert.deepEqual([options.x, options.y, options.width, options.height], [100, 100, 480, 720]);
	assert.deepEqual(options.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1 });
	assert.equal(windows.getWindowOpenOptions({ ...request, url: 'https://example.test/' }), undefined);
	assert.equal(windows.getWindowOpenOptions({ ...request, frameName: 'ash-auxiliary-other' }), undefined);
});

test('navigation is blocked and parent changes release every menu window', () => {
	const parent = new TestWindow();
	const child = new TestWindow();
	const windows = new ContextMenuWindow(parent.native, () => { });
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

test('menu key focus preserves parent activation without refocusing either window', () => {
	const parent = new TestWindow();
	const child = new TestWindow();
	const restored: BrowserWindow[] = [];
	using windows = new ContextMenuWindow(parent.native, window => restored.push(window));
	windows.registerWindow(child.native);
	assert.deepEqual(restored, []);
	child.focused = false;
	child.emit('focus');
	assert.equal(restored.length, 0);
	child.focused = true;
	child.emit('focus');
	assert.deepEqual(restored, [parent.native]);
	parent.close();
	assert.equal(child.closes, 1);
	assert.equal(child.listenerCount('focus'), 0);
	child.emit('focus');
	assert.equal(restored.length, 1);
});

test('a hidden menu first appears at its final bounds and a cancelled request never reopens it', () => {
	const parent = new TestWindow();
	const child = new TestWindow(parent);
	child.webContents.mainFrame.name = 'ash-context-menu-11111111-1111-4111-8111-111111111111';
	const shown: typeof child.bounds[] = [];
	child.on('show', () => shown.push({ ...child.bounds }));
	const restored: BrowserWindow[] = [];
	using windows = new ContextMenuWindow(parent.native, window => restored.push(window));
	windows.registerWindow(child.native);
	assert.deepEqual(shown, []);
	const request = { windowName: child.webContents.mainFrame.name, bounds: { x: 1200, y: 100, width: 200, height: 400 } };
	assert.equal(windows.present(request), true);
	assert.deepEqual(shown, [request.bounds]);
	assert.deepEqual(restored, [parent.native]);
	assert.equal(windows.present(request), true);
	assert.equal(shown.length, 1);
	assert.deepEqual(restored, [parent.native]);
	child.close();
	assert.equal(windows.present(request), false);
	assert.equal(shown.length, 1);
});

test('owner blur cancels pending presentation but preserves a menu taking key focus', () => {
	const parent = new TestWindow();
	using windows = new ContextMenuWindow(parent.native, () => { });
	const pending = new TestWindow(parent);
	pending.webContents.mainFrame.name = 'ash-context-menu-11111111-1111-4111-8111-111111111111';
	windows.registerWindow(pending.native);
	parent.emit('blur');
	assert.equal(pending.closes, 1, 'A pending menu must not steal focus after its owner is left');
	assert.equal(windows.present({ windowName: pending.webContents.mainFrame.name, bounds: pending.bounds }), false);

	const shown = new TestWindow(parent);
	shown.webContents.mainFrame.name = 'ash-context-menu-22222222-2222-4222-8222-222222222222';
	windows.registerWindow(shown.native);
	// Showing the native menu itself transfers focus away from the owner.
	shown.on('focus', () => parent.emit('blur'));
	assert.equal(windows.present({ windowName: shown.webContents.mainFrame.name, bounds: shown.bounds }), true);
	assert.equal(shown.closes, 0);
	assert.equal(shown.isFocused(), true);
	windows.dispose();
	assert.equal(shown.closes, 1);
	assert.equal(parent.listenerCount('blur'), 0);
});

test('presentation is scoped to the owning window tree, including auxiliary workbenches', () => {
	const parent = new TestWindow();
	const auxiliary = new TestWindow(parent);
	const menu = new TestWindow(auxiliary);
	menu.webContents.mainFrame.name = 'ash-context-menu-11111111-1111-4111-8111-111111111111';
	using windows = new ContextMenuWindow(parent.native, () => { });
	const request = { windowName: menu.webContents.mainFrame.name, bounds: menu.bounds };
	assert.equal(windows.present(request), true);
	const other = new TestWindow();
	using foreign = new ContextMenuWindow(other.native, () => { });
	assert.equal(foreign.present(request), false);
});
