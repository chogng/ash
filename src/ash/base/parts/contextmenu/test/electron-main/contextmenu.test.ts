import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from 'electron/main';
import { suite, suiteSetup, test } from 'mocha';
import { Disposable, toDisposable } from '../../../../common/lifecycle.js';
import type { INativeContextMenuRequest } from '../../common/contextmenu.js';

suite('Electron context menu owner', () => {
	let owner: typeof import('../../electron-main/contextmenu.js');
	let boundary: { setMenuApi(api: unknown): void; };
	const boundaryUrl = `data:text/javascript,${encodeURIComponent('export let Menu; export function setMenuApi(api) { Menu = api; }')}`;

	suiteSetup(async () => {
		// Node cannot load Electron's main-process API. Only that external boundary is controlled.
		const hooks = registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === 'electron/main') { return { url: boundaryUrl, shortCircuit: true }; }
				return nextResolve(specifier, context);
			},
		});
		try {
			owner = await import('../../electron-main/contextmenu.js');
			boundary = await import(boundaryUrl);
		} finally { hooks.deregister(); }
	});

	class HostMenuFixture extends Disposable {
		readonly menus: InstanceType<typeof owner.ElectronContextMenu>;
		readonly request: INativeContextMenuRequest = { items: [{ type: 'action', id: 'copy', label: 'Copy Text', enabled: true }], x: 10, y: 20 };
		readonly failure = new Error('Electron closePopup fixture failure');
		readonly window = new EventEmitter();
		options: PopupOptions | undefined;
		template: MenuItemConstructorOptions[] = [];
		readonly popups: PopupOptions[] = [];
		closeAttempts = 0;
		closeFailures = 0;
		buildFailures = 0;
		popupFailures = 0;
		isDestroyed = false;
		callbackCalled = false;

		constructor() {
			super();
			this._register(toDisposable(() => boundary.setMenuApi(undefined)));
			this._register(toDisposable(() => this.destroyWindow()));
			boundary.setMenuApi({
				buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
					if (this.buildFailures > 0) { this.buildFailures--; throw this.failure; }
					this.template = template;
					return {
						popup: (options: PopupOptions) => {
							this.options = options;
							this.popups.push(options);
							if (this.popupFailures > 0) { this.popupFailures--; throw this.failure; }
						},
						closePopup: () => {
							this.closeAttempts++;
							if (this.closeFailures > 0) { this.closeFailures--; throw this.failure; }
							// Requesting close does not stand in for Electron's popup callback.
						},
					};
				},
			});
			Object.assign(this.window, { isDestroyed: () => this.isDestroyed, webContents: { getZoomFactor: () => 1 } });
			this.menus = this._register(new owner.ElectronContextMenu(this.window as unknown as BrowserWindow));
		}

		finish(): void {
			this.callbackCalled = true;
			this.options?.callback?.();
		}

		destroyWindow(): void {
			if (this.isDestroyed) { return; }
			this.isDestroyed = true;
			this.window.emit('closed');
		}
	}

	test('requesting OS close keeps the popup result pending until its actual callback', async () => {
		using fixture = new HostMenuFixture();
		let settled = false;
		const popup = fixture.menus.popup(fixture.request).then(result => { settled = true; return result; });
		try {
			await fixture.menus.close();
			const click = fixture.template[0].click;
			assert.ok(click);
			Reflect.apply(click, undefined, []);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual({ settled, closeAttempts: fixture.closeAttempts, callbackCalled: fixture.callbackCalled }, { settled: false, closeAttempts: 1, callbackCalled: false });
		} finally { fixture.finish(); assert.deepEqual(await popup, {}); }
	});

	test('an OS close failure retains the popup result and the menu for a real retry', async () => {
		using fixture = new HostMenuFixture();
		fixture.closeFailures = 1;
		let settled = false;
		const popup = fixture.menus.popup(fixture.request).then(result => { settled = true; return result; });
		try {
			await assert.rejects(Promise.resolve().then(() => fixture.menus.close()), error => error === fixture.failure);
			await new Promise<void>(resolve => setImmediate(resolve));
			const afterFailure = { settled, closeAttempts: fixture.closeAttempts };
			await fixture.menus.close();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual({ afterFailure, afterRetry: { settled, closeAttempts: fixture.closeAttempts, callbackCalled: fixture.callbackCalled } }, {
				afterFailure: { settled: false, closeAttempts: 1 }, afterRetry: { settled: false, closeAttempts: 2, callbackCalled: false },
			});
		} finally { fixture.finish(); await popup; }
	});

	test('a selected OS action is returned only after the popup callback', async () => {
		using fixture = new HostMenuFixture();
		let settled = false;
		const popup = fixture.menus.popup(fixture.request).then(result => { settled = true; return result; });
		const click = fixture.template[0].click;
		assert.ok(click);
		Reflect.apply(click, undefined, []);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, false);
		fixture.finish();
		assert.deepEqual(await popup, { selectedId: 'copy' });
		assert.equal(fixture.window.listenerCount('closed'), 0);
	});

	test('a displayed or closing OS popup refuses overlap and an old callback cannot finish its successor', async () => {
		using fixture = new HostMenuFixture();
		const first = fixture.menus.popup(fixture.request);
		assert.deepEqual(await fixture.menus.popup(fixture.request), {});
		fixture.menus.close();
		assert.deepEqual(await fixture.menus.popup(fixture.request), {});
		assert.equal(fixture.popups.length, 1);
		const oldCallback = fixture.options!.callback!;
		fixture.finish();
		await first;
		let settled = false;
		const next = fixture.menus.popup(fixture.request).then(result => { settled = true; return result; });
		oldCallback();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ settled, popups: fixture.popups.length, listeners: fixture.window.listenerCount('closed') }, { settled: false, popups: 2, listeners: 1 });
		fixture.finish();
		await next;
	});

	test('a destroyed window completes its pending popup without calling the OS close API', async () => {
		using fixture = new HostMenuFixture();
		const popup = fixture.menus.popup(fixture.request);
		fixture.destroyWindow();
		fixture.menus.close();
		assert.deepEqual({ result: await popup, retry: await fixture.menus.popup(fixture.request), closes: fixture.closeAttempts, listeners: fixture.window.listenerCount('closed') }, { result: {}, retry: {}, closes: 0, listeners: 0 });
	});

	test('a window already destroyed never builds or presents an OS menu', async () => {
		using fixture = new HostMenuFixture();
		fixture.destroyWindow();
		assert.deepEqual({ result: await fixture.menus.popup(fixture.request), template: fixture.template, listeners: fixture.window.listenerCount('closed') }, { result: {}, template: [], listeners: 0 });
	});

	for (const failure of ['build', 'popup'] as const) {
		test(`OS ${failure} failure releases its slot and listeners before another presentation`, async () => {
			using fixture = new HostMenuFixture();
			if (failure === 'build') { fixture.buildFailures = 1; }
			else { fixture.popupFailures = 1; }
			assert.throws(() => fixture.menus.popup(fixture.request), error => error === fixture.failure);
			assert.equal(fixture.window.listenerCount('closed'), 0);
			const next = fixture.menus.popup(fixture.request);
			fixture.finish();
			assert.deepEqual({ result: await next, listeners: fixture.window.listenerCount('closed'), closes: fixture.closeAttempts }, { result: {}, listeners: 0, closes: 0 });
		});
	}

	test('disposal requests OS close but retains the pending window listener until destruction', async () => {
		using fixture = new HostMenuFixture();
		let settled = false;
		const popup = fixture.menus.popup(fixture.request).then(result => { settled = true; return result; });
		fixture.menus.dispose();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ settled, closes: fixture.closeAttempts, listeners: fixture.window.listenerCount('closed'), retry: await fixture.menus.popup(fixture.request) }, { settled: false, closes: 1, listeners: 1, retry: {} });
		fixture.destroyWindow();
		assert.deepEqual({ result: await popup, listeners: fixture.window.listenerCount('closed') }, { result: {}, listeners: 0 });
	});
});
