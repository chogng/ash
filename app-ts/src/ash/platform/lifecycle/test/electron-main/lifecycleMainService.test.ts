import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_PREPARE_LOAD_CHANNEL } from '../../../window/common/window.js';
import type { IStateService } from '../../../state/node/state.js';
import { LifecycleMainService, windowCloseResponseIpcRoute } from '../../electron-main/lifecycleMainService.js';

class TestWindow {
	readonly messages: { channel: string; token: number }[] = [];
	private readonly closeListeners = new Set<(event: { preventDefault(): void }) => void>();
	private readonly rendererListeners = new Map<string, Set<() => void>>();
	readonly webContents = {
		on: (event: 'did-start-loading' | 'render-process-gone', listener: () => void): void => {
			const listeners = this.rendererListeners.get(event) ?? new Set<() => void>();
			listeners.add(listener);
			this.rendererListeners.set(event, listeners);
		},
		off: (event: 'did-start-loading' | 'render-process-gone', listener: () => void): void => { this.rendererListeners.get(event)?.delete(listener); },
		send: (channel: string, token: number): void => { this.messages.push({ channel, token }); },
	};
	destroyed = false;

	on(_event: 'close', listener: (event: { preventDefault(): void }) => void): void { this.closeListeners.add(listener); }
	off(_event: 'close', listener: (event: { preventDefault(): void }) => void): void { this.closeListeners.delete(listener); }
	isDestroyed(): boolean { return this.destroyed; }
	close(): void {
		let prevented = false;
		for (const listener of this.closeListeners) listener({ preventDefault: () => { prevented = true; } });
		if (!prevented) this.destroyed = true;
	}
	emitRendererLoading(): void { for (const listener of this.rendererListeners.get('did-start-loading') ?? []) listener(); }
}

function createStateService(): IStateService {
	const items = new Map<string, unknown>();
	return {
		getItem: key => items.get(key),
		setItem: (key, value) => { items.set(key, value); },
		removeItem: key => { items.delete(key); },
		flush: async () => {},
		close: async () => {},
	};
}

suite('LifecycleMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

test('loading a workspace shares the shutdown handshake without closing the window', async () => {
	const window = new TestWindow();
	using service = new LifecycleMainService<TestWindow>(() => {}, () => {}, createStateService(), '1.0.0');
	using registration = service.registerWindow(window);
	const route = windowCloseResponseIpcRoute(service, window);
	route.invoke(route.validate({ kind: 'ready' }));
	const cancelled = service.unload(window);
	assert.deepEqual(window.messages, [{ channel: WINDOW_PREPARE_LOAD_CHANNEL, token: 1 }]);
	route.invoke(route.validate({ kind: 'vetoed', token: 1 }));
	assert.equal(await cancelled, false);
	const accepted = service.unload(window);
	route.invoke(route.validate({ kind: 'complete', token: 2 }));
	assert.equal(await accepted, true);
	assert.equal(window.destroyed, false);
	window.emitRendererLoading();
	route.invoke(route.validate({ kind: 'ready' }));
	window.close();
	assert.deepEqual(window.messages.at(-1), { channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 3 });
	assert.equal(window.destroyed, false);
	route.invoke(route.validate({ kind: 'complete', token: 3 }));
});

test('main lifecycle waits for renderer shutdown, reports failure, and permits retry', () => {
	const window = new TestWindow();
	const failures: string[] = [];
	using service = new LifecycleMainService<TestWindow>((_window, message) => { failures.push(message); }, () => {}, createStateService(), '1.0.0');
	using registration = service.registerWindow(window);
	const route = windowCloseResponseIpcRoute(service, window);
	assert.equal(route.channel, WINDOW_CLOSE_RESPONSE_CHANNEL);
	assert.throws(() => route.validate({ kind: 'complete', token: -1 }), /Invalid window close response/);
	route.invoke(route.validate({ kind: 'ready' }));
	window.close();
	assert.equal(window.destroyed, false);
	route.invoke(route.validate({ kind: 'failed', token: 1, message: 'Save failed' }));
	window.close();
	assert.deepEqual({ failures, messages: window.messages }, {
		failures: ['Save failed'],
		messages: [
			{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 1 },
			{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 2 },
		],
	});
	assert.throws(() => route.invoke(route.validate({ kind: 'complete', token: 1 })), /no longer active/);
	route.invoke(route.validate({ kind: 'complete', token: 2 }));
	assert.equal(window.destroyed, true);
});

test('main lifecycle lets a loading renderer close without a shutdown request', () => {
	const window = new TestWindow();
	using service = new LifecycleMainService<TestWindow>(() => {}, () => {}, createStateService(), '1.0.0');
	using registration = service.registerWindow(window);
	service.respondToClose(window, { kind: 'ready' });
	window.emitRendererLoading();
	window.close();
	assert.deepEqual({ destroyed: window.destroyed, messages: window.messages }, { destroyed: true, messages: [] });
});

test('main lifecycle releases window listeners when its owner is disposed', () => {
	const window = new TestWindow();
	const service = new LifecycleMainService<TestWindow>(() => {}, () => {}, createStateService(), '1.0.0');
	const registration = service.registerWindow(window);
	service.respondToClose(window, { kind: 'ready' });
	service.dispose();
	window.close();
	registration.dispose();
	assert.deepEqual({ destroyed: window.destroyed, messages: window.messages }, { destroyed: true, messages: [] });
});

test('main lifecycle keeps a vetoed window open without reporting a save failure', () => {
	const window = new TestWindow();
	const failures: string[] = [];
	let vetoes = 0;
	using service = new LifecycleMainService<TestWindow>((_window, message) => { failures.push(message); }, () => { vetoes++; }, createStateService(), '1.0.0');
	using registration = service.registerWindow(window);
	const route = windowCloseResponseIpcRoute(service, window);
	route.invoke(route.validate({ kind: 'ready' }));
	assert.throws(() => route.validate({ kind: 'vetoed', token: -1 }), /Invalid window close response/);
	window.close();
	route.invoke(route.validate({ kind: 'vetoed', token: 1 }));
	assert.deepEqual({ destroyed: window.destroyed, failures, vetoes }, { destroyed: false, failures: [], vetoes: 1 });
	window.close();
	assert.deepEqual(window.messages, [
		{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 1 },
		{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 2 },
	]);
});

test('update restart marker is consumed once by the matching version', async () => {
	const state = createStateService();
	using beforeUpdate = new LifecycleMainService<TestWindow>(() => {}, () => {}, state, '1.0.0');
	await beforeUpdate.prepareUpdateRestart('2.0.0');
	using updated = new LifecycleMainService<TestWindow>(() => {}, () => {}, state, '2.0.0');
	assert.equal(updated.wasRestarted, true);
	using nextLaunch = new LifecycleMainService<TestWindow>(() => {}, () => {}, state, '2.0.0');
	assert.equal(nextLaunch.wasRestarted, false);
});

});

suite('Desktop startup shutdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('quit before Electron readiness cancels startup without waiting for ready', async () => {
		using service = new LifecycleMainService<TestWindow>(() => {}, () => {}, createStateService(), '1.0.0');
		const ready = new DeferredPromise<void>();
		let initialized = false;
		const startup = service.startup(ready.p, async () => { initialized = true; });
		const cancelled = assert.rejects(startup, isCancellationError);
		await service.stopStartup();
		await cancelled;
		await ready.complete();
		assert.deepEqual({ initialized, starting: service.isStarting }, { initialized: false, starting: false });
	});

	test('quit waits for in-flight initialization before allowing resource cleanup', async () => {
		using service = new LifecycleMainService<TestWindow>(() => {}, () => {}, createStateService(), '1.0.0');
		const entered = new DeferredPromise<void>();
		const initialized = new DeferredPromise<void>();
		const events: string[] = [];
		const startup = service.startup(Promise.resolve(), async token => {
			await entered.complete();
			await initialized.p;
			events.push('initialized');
			throwIfCancelled(token);
			events.push('opened-window');
		});
		const cancelled = assert.rejects(startup, isCancellationError);
		await entered.p;
		const stopped = service.stopStartup().then(() => { events.push('closed-services'); });
		assert.equal(service.isStarting, true);
		await initialized.complete();
		await stopped;
		await cancelled;
		assert.deepEqual(events, ['initialized', 'closed-services']);
	});
});
