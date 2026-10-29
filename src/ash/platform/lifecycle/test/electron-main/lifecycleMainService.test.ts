import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { DeferredPromise } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_PREPARE_QUIT_CHANNEL, WINDOW_PREPARE_LOAD_CHANNEL, WINDOW_PREPARE_RELOAD_CHANNEL } from '../../../window/common/window.js';
import type { IStateService } from '../../../state/node/state.js';
import { LifecycleMainService, windowCloseResponseIpcRoute } from '../../electron-main/lifecycleMainService.js';

class TestWindow {
	readonly messages: { channel: string; token: number; }[] = [];
	private readonly closeListeners = new Set<(event: { preventDefault(): void; }) => void>();
	private readonly rendererEvents = new EventEmitter();
	readonly webContents = {
		on: this.rendererEvents.on.bind(this.rendererEvents),
		off: this.rendererEvents.off.bind(this.rendererEvents),
		send: (channel: string, token: number): void => { this.messages.push({ channel, token }); },
	};
	destroyed = false;

	on(_event: 'close', listener: (event: { preventDefault(): void; }) => void): void { this.closeListeners.add(listener); }
	off(_event: 'close', listener: (event: { preventDefault(): void; }) => void): void { this.closeListeners.delete(listener); }
	isDestroyed(): boolean { return this.destroyed; }
	close(): void {
		let prevented = false;
		for (const listener of this.closeListeners) listener({ preventDefault: () => { prevented = true; } });
		if (!prevented) this.destroyed = true;
	}
	startNavigation(mainFrame = true, inPlace = false): void {
		this.rendererEvents.emit('did-start-navigation', {}, 'file:///workbench.html', inPlace, mainFrame);
	}
	commitNavigation(): void { this.rendererEvents.emit('did-navigate'); }
	rendererGone(): void { this.rendererEvents.emit('render-process-gone'); }
}

function createStateService(): IStateService {
	const items = new Map<string, unknown>();
	return {
		getItem: key => items.get(key),
		setItem: (key, value) => { items.set(key, value); },
		removeItem: key => { items.delete(key); },
		flush: async () => { },
		close: async () => { },
	};
}

suite('LifecycleMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const reason of ['load', 'reload', 'windowClose'] as const) {
		test(`${reason} timeout keeps waiting on the original request and accepts a late completion`, async () => {
			mock.timers.enable({ apis: ['setTimeout'] });
			try {
				const window = new TestWindow();
				const prompts: AbortSignal[] = [];
				const requests: { token: number; reason: string; elapsedMs: number; }[] = [];
				const choice = new DeferredPromise<void>();
				using service = new LifecycleMainService<TestWindow>((_, failure) => {
					assert.equal(failure.kind, 'unresponsive');
					if (failure.kind !== 'unresponsive') return;
					prompts.push(failure.signal);
					requests.push({ token: failure.token, reason: failure.reason, elapsedMs: failure.elapsedMs });
					return prompts.length === 1 ? Promise.resolve() : choice.p;
				}, () => { }, createStateService(), 'test');
				using registration = service.registerWindow(window);
				service.respondToClose(window, { kind: 'ready' });
				let completed = false;
				const unload = reason === 'windowClose' ? undefined : service.unload(window, reason).then(value => { completed = true; return value; });
				if (reason === 'windowClose') window.close();
				mock.timers.tick(30_000);
				await new Promise(resolve => setImmediate(resolve));
				assert.deepEqual({ prompts: prompts.length, completed, destroyed: window.destroyed, requests: window.messages.length }, {
					prompts: 1, completed: false, destroyed: false, requests: 1,
				});
				mock.timers.tick(30_000);
				await new Promise(resolve => setImmediate(resolve));
				assert.equal(prompts.length, 2);
				assert.deepEqual(requests.map(({ token, reason }) => ({ token, reason })), [{ token: 1, reason }, { token: 1, reason }]);
				assert.ok(requests[0]!.elapsedMs >= 0 && requests[1]!.elapsedMs >= requests[0]!.elapsedMs);
				service.respondToClose(window, { kind: 'complete', token: 1 });
				assert.equal(prompts[1]!.aborted, true);
				if (unload) assert.equal(await unload, true);
				else assert.equal(window.destroyed, true);
				await choice.complete();
				await new Promise(resolve => setImmediate(resolve));
				mock.timers.tick(60_000);
				assert.equal(prompts.length, 2);
			} finally { mock.timers.reset(); }
		});
	}

	test('disposing a timed-out window dismisses recovery and settles its load without another request', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const window = new TestWindow();
			const shown = new DeferredPromise<AbortSignal>();
			const choice = new DeferredPromise<void>();
			using service = new LifecycleMainService<TestWindow>((_, failure) => {
				assert.equal(failure.kind, 'unresponsive');
				if (failure.kind === 'unresponsive') void shown.complete(failure.signal);
				return choice.p;
			}, () => { }, createStateService(), 'test');
			const registration = service.registerWindow(window);
			service.respondToClose(window, { kind: 'ready' });
			const unloaded = service.unload(window);
			mock.timers.tick(30_000);
			const signal = await shown.p;
			registration.dispose();
			assert.equal(signal.aborted, true);
			assert.equal(await unloaded, false);
			await choice.complete();
			await new Promise(resolve => setImmediate(resolve));
			mock.timers.tick(60_000);
			assert.equal(window.messages.length, 1);
		} finally { mock.timers.reset(); }
	});

	test('application quit reaches the renderer as quit and a vetoed quit returns to ordinary window closing', () => {
		let quitting = true;
		const window = new TestWindow();
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { quitting = false; }, createStateService(), '1.0.0', () => quitting ? 'quit' : 'windowClose');
		using registration = service.registerWindow(window);
		service.respondToClose(window, { kind: 'ready' });
		window.close();
		assert.deepEqual(window.messages.at(-1), { channel: WINDOW_PREPARE_QUIT_CHANNEL, token: 1 });
		service.respondToClose(window, { kind: 'vetoed', token: 1 });
		window.close();
		assert.deepEqual(window.messages.at(-1), { channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 2 });
		service.respondToClose(window, { kind: 'complete', token: 2 });
		assert.equal(window.destroyed, true);
	});

	test('a prevented reload retains the old renderer handshake after loading starts and can be canceled', async () => {
		const window = new TestWindow();
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), '1.0.0');
		using registration = service.registerWindow(window);
		const route = windowCloseResponseIpcRoute(service, window);
		route.invoke(route.validate({ kind: 'ready' }));
		window.startNavigation();
		const reloading = service.unload(window, 'reload');
		assert.deepEqual(window.messages, [{ channel: WINDOW_PREPARE_RELOAD_CHANNEL, token: 1 }]);
		route.invoke(route.validate({ kind: 'vetoed', token: 1 }));
		assert.equal(await reloading, false);
		assert.equal(window.destroyed, false);
		window.close();
		assert.deepEqual(window.messages.at(-1), { channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 2 });
		route.invoke(route.validate({ kind: 'complete', token: 2 }));
	});

	test('webview and same-document navigation preserve the ready renderer and its pending shutdown', () => {
		const window = new TestWindow();
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), 'test');
		using registration = service.registerWindow(window);
		service.respondToClose(window, { kind: 'ready' });
		window.startNavigation(false);
		window.startNavigation(true, true);
		window.close();
		assert.equal(window.destroyed, false);
		assert.deepEqual(window.messages, [{ channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 1 }]);
		window.startNavigation(false);
		service.respondToClose(window, { kind: 'complete', token: 1 });
		assert.equal(window.destroyed, true);
	});

	test('loading a workspace shares the shutdown handshake without closing the window', async () => {
		const window = new TestWindow();
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), '1.0.0');
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
		window.commitNavigation();
		route.invoke(route.validate({ kind: 'ready' }));
		window.close();
		assert.deepEqual(window.messages.at(-1), { channel: WINDOW_PREPARE_CLOSE_CHANNEL, token: 3 });
		assert.equal(window.destroyed, false);
		route.invoke(route.validate({ kind: 'complete', token: 3 }));
	});

	test('main lifecycle waits for renderer shutdown, reports failure, and permits retry', () => {
		const window = new TestWindow();
		const failures: string[] = [];
		using service = new LifecycleMainService<TestWindow>((_window, failure) => { if (failure.kind === 'failed') failures.push(failure.message); }, () => { }, createStateService(), '1.0.0');
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
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), '1.0.0');
		using registration = service.registerWindow(window);
		service.respondToClose(window, { kind: 'ready' });
		window.commitNavigation();
		window.close();
		assert.deepEqual({ destroyed: window.destroyed, messages: window.messages }, { destroyed: true, messages: [] });
	});

	for (const phase of ['startup', 'navigation', 'crash'] as const) {
		test(`Retry during ${phase} does not wait for an unavailable renderer or block closing`, async () => {
			const window = new TestWindow();
			using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), 'test');
			using registration = service.registerWindow(window);
			if (phase !== 'startup') {
				service.respondToClose(window, { kind: 'ready' });
				if (phase === 'navigation') window.commitNavigation();
				else window.rendererGone();
			}
			const reloading = service.unload(window, 'reload');
			window.close();
			assert.deepEqual({ destroyed: window.destroyed, messages: window.messages }, { destroyed: true, messages: [] });
			assert.equal(await reloading, true);
		});
	}

	test('main lifecycle releases window listeners when its owner is disposed', () => {
		const window = new TestWindow();
		const service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), '1.0.0');
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
		using service = new LifecycleMainService<TestWindow>((_window, failure) => { if (failure.kind === 'failed') failures.push(failure.message); }, () => { vetoes++; }, createStateService(), '1.0.0');
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
		using beforeUpdate = new LifecycleMainService<TestWindow>(() => { }, () => { }, state, '1.0.0');
		await beforeUpdate.prepareUpdateRestart('2.0.0');
		using updated = new LifecycleMainService<TestWindow>(() => { }, () => { }, state, '2.0.0');
		assert.equal(updated.wasRestarted, true);
		using nextLaunch = new LifecycleMainService<TestWindow>(() => { }, () => { }, state, '2.0.0');
		assert.equal(nextLaunch.wasRestarted, false);
	});

});

suite('Desktop startup shutdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('quit before Electron readiness cancels startup without waiting for ready', async () => {
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), '1.0.0');
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
		using service = new LifecycleMainService<TestWindow>(() => { }, () => { }, createStateService(), '1.0.0');
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
