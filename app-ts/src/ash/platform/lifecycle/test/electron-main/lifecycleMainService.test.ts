import assert from 'node:assert/strict';
import { test } from 'mocha';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL } from '../../../window/common/window.js';
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

test('main lifecycle waits for renderer shutdown, reports failure, and permits retry', () => {
	const window = new TestWindow();
	const failures: string[] = [];
	using service = new LifecycleMainService<TestWindow>((_window, message) => { failures.push(message); }, () => {});
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
	using service = new LifecycleMainService<TestWindow>(() => {}, () => {});
	using registration = service.registerWindow(window);
	service.respondToClose(window, { kind: 'ready' });
	window.emitRendererLoading();
	window.close();
	assert.deepEqual({ destroyed: window.destroyed, messages: window.messages }, { destroyed: true, messages: [] });
});

test('main lifecycle releases window listeners when its owner is disposed', () => {
	const window = new TestWindow();
	const service = new LifecycleMainService<TestWindow>(() => {}, () => {});
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
	using service = new LifecycleMainService<TestWindow>((_window, message) => { failures.push(message); }, () => { vetoes++; });
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
