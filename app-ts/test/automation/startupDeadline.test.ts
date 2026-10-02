import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { StartupDeadline } from './startupDeadline.js';
import { Workbench } from './workbench.js';
import { waitForNewElectronWindow } from './playwrightElectron.js';

test('startup stages spend one monotonic budget including process launch time', async () => {
	using clock = createClock();
	const deadline = new StartupDeadline();
	await clock.advance(9_000);
	const received: number[] = [];
	await deadline.run('window', async timeout => { received.push(timeout); await clock.advance(4_000); });
	await deadline.run('restoration', async timeout => { received.push(timeout); });
	assert.deepEqual(received, [21_000, 17_000]);
});

for (const elapsed of [30_000, 30_001]) {
	test(`startup at ${elapsed}ms fails before dispatch instead of passing an unlimited zero timeout`, async () => {
		using clock = createClock();
		const deadline = new StartupDeadline();
		await clock.advance(elapsed);
		let called = false;
		await assert.rejects(deadline.run('window', async () => { called = true; }), /30000ms deadline.*window/u);
		assert.equal(called, false);
	});
}

test('startup does not renew its budget for an operation without a Playwright timeout', async () => {
	using clock = createClock();
	const deadline = new StartupDeadline();
	await clock.advance(29_000);
	const rejected = assert.rejects(deadline.run('rendering frames', () => new Promise(() => {})), /30000ms deadline.*rendering frames/u);
	await clock.advance(1_000);
	await rejected;
});

test('startup preserves an operation error and does not report timeout instead', async () => {
	using clock = createClock();
	const failure = new Error('Renderer closed');
	await assert.rejects(new StartupDeadline().run('restoration', async () => { throw failure; }), error => error === failure);
	await clock.advance(30_000);
});

test('Workbench readiness waits past an ordinary assertion deadline until restoration publishes aria-busy=false', async () => {
	using clock = createClock();
	using fixture = createWorkbench();
	let state = 'pending';
	const ready = fixture.workbench.waitForReady().then(() => { state = 'ready'; }, error => { state = 'failed'; throw error; });
	// Attach the rejection handler before advancing the controlled clock.
	const outcome = ready.catch(error => error as Error);
	try {
		await setImmediate();
		await clock.advance(11_000);
		assert.equal(state, 'pending');
		fixture.restore();
		assert.equal(await outcome, undefined);
		assert.equal(state, 'ready');
	} finally {
		fixture.restore();
		await outcome;
	}
});

test('Workbench readiness fails at the shared deadline while recovery is still pending', async () => {
	using clock = createClock();
	using fixture = createWorkbench();
	const deadline = new StartupDeadline();
	await clock.advance(9_000);
	const rejected = assert.rejects(fixture.workbench.waitForReady(deadline), /30000ms deadline.*Workbench/u);
	void rejected.catch(() => {});
	await setImmediate();
	await clock.advance(21_000);
	await rejected;
	assert.equal(fixture.root.getAttribute('aria-busy'), 'true');
});

test('restored Workbench still obeys the startup deadline if rendering frames stop', async () => {
	using clock = createClock();
	using fixture = createWorkbench(true);
	fixture.restore();
	const rejected = assert.rejects(fixture.workbench.waitForReady(), /30000ms deadline.*Workbench/u);
	void rejected.catch(() => {});
	await setImmediate();
	await clock.advance(30_000);
	await rejected;
});

test('new Electron Sessions window waits for navigation, preload and shell before invoking renderer IPC once', async () => {
	using clock = createClock();
	using fixture = createElectronWindow();
	const opened = waitForNewElectronWindow(fixture.application, 'sessions').then(page => page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:configuration:read');
	}));
	try {
		assert.deepEqual(fixture.stages, ['window']);
		await clock.advance(9_000);
		fixture.created.release();
		await fixture.navigation.started;
		assert.deepEqual({ url: fixture.page.url(), ipcCalls: fixture.ipcCalls, stages: fixture.stages }, { url: 'about:blank', ipcCalls: 0, stages: ['window', 'navigation'] });
		fixture.navigate();
		await clock.advance(4_000);
		assert.equal(fixture.ipcCalls, 0, 'committing the URL does not finish loading the new document');
		fixture.navigation.release();
		await fixture.preload.started;
		assert.equal(fixture.ipcCalls, 0, 'the loaded document must install its renderer bridge');
		fixture.preload.release();
		await fixture.shell.started;
		assert.equal(fixture.ipcCalls, 0, 'the Sessions shell must connect IPC and load configuration');
		fixture.shell.release();
		assert.deepEqual(await opened, { revision: 1 });
		assert.deepEqual({ ipcCalls: fixture.ipcCalls, timeouts: fixture.timeouts }, { ipcCalls: 1, timeouts: [30_000, 21_000, 17_000, 17_000] });
	} finally {
		fixture.release();
		await opened;
	}
});

test('new Electron Workbench window uses the existing restoration readiness contract', async () => {
	using clock = createClock();
	using workbench = createWorkbench();
	using fixture = createElectronWindow(workbench.page);
	let ready = false;
	const opened = waitForNewElectronWindow(fixture.application, 'workbench').then(page => { ready = true; return page; });
	try {
		fixture.release();
		await setImmediate();
		assert.equal(ready, false, 'window creation and a loaded document do not finish Workbench restoration');
		workbench.restore();
		assert.equal(await opened, fixture.page);
		assert.equal(ready, true);
	} finally {
		fixture.release();
		workbench.restore();
		await opened;
	}
});

for (const stage of ['initial navigation', 'Sessions shell'] as const) {
	test(`new Electron window retains its URL and shared deadline while waiting for ${stage}`, async () => {
		using clock = createClock();
		using fixture = createElectronWindow();
		const opened = waitForNewElectronWindow(fixture.application, 'sessions');
		const url = stage === 'initial navigation' ? 'about:blank' : fixture.targetUrl;
		const rejected = assert.rejects(opened, error => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(`New sessions window failed at ${url}`));
			assert.match(error.message, /30000ms deadline/u);
			assert.ok(error.message.includes(stage));
			return true;
		});
		void rejected.catch(() => {});
		try {
			await clock.advance(9_000);
			fixture.created.release();
			await fixture.navigation.started;
			if (stage === 'Sessions shell') {
				fixture.navigate();
				fixture.navigation.release();
				fixture.preload.release();
				await fixture.shell.started;
			}
			await clock.advance(21_000);
			await rejected;
		} finally {
			fixture.release();
			await rejected;
		}
	});
}

function createGate() {
	let release!: () => void;
	let entered!: () => void;
	const released = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	return { started, release, wait: () => { entered(); return released; } };
}

function createElectronWindow(workbenchPage?: Page) {
	const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
	let ipcCalls = 0;
	const targetUrl = 'file:///ash/sessions-code.html';
	let url = 'about:blank';
	const created = createGate();
	const navigation = createGate();
	const preload = createGate();
	const shell = createGate();
	const stages: string[] = [];
	const timeouts: number[] = [];
	const page = {
		...workbenchPage,
		url: () => url,
		waitForURL: async (matches: (url: URL) => boolean, options: { waitUntil: string; timeout: number }) => {
			assert.equal(matches(new URL('about:blank')), false);
			assert.equal(options.waitUntil, 'load');
			stages.push('navigation');
			timeouts.push(options.timeout);
			await navigation.wait();
			assert.equal(matches(new URL(url)), true);
		},
		waitForFunction: async (predicate: () => boolean, argument: undefined, options: { timeout: number }) => {
			if (stages.includes('preload')) return;
			stages.push('preload');
			timeouts.push(options.timeout);
			await preload.wait();
			(dom.window as unknown as { ash: unknown }).ash = { ipcRenderer: { invoke: async (channel: string) => {
				assert.equal(channel, 'ash:configuration:read');
				ipcCalls++;
				return { revision: 1 };
			} } };
			assert.equal(dom.window.eval(`(${predicate.toString()})()`), true);
		},
		locator: workbenchPage?.locator ?? ((selector: string) => ({
			waitFor: async (options: { state: string; timeout: number }) => {
				assert.equal(selector, '.ash-code-sessions-window');
				assert.equal(options.state, 'visible');
				stages.push('shell');
				timeouts.push(options.timeout);
				await shell.wait();
			},
		})),
		evaluate: workbenchPage?.evaluate ?? (async (callback: () => unknown) => dom.window.eval(`(${callback.toString()})()`)),
	} as unknown as Page;
	const application = {
		waitForEvent: async (event: string, options: { timeout: number }) => {
			assert.equal(event, 'window');
			stages.push('window');
			timeouts.push(options.timeout);
			await created.wait();
			return page;
		},
	} as unknown as ElectronApplication;
	return {
		application, page, targetUrl, created, navigation, preload, shell, stages, timeouts,
		get ipcCalls() { return ipcCalls; },
		[Symbol.dispose]: () => dom.window.close(),
		navigate: () => { url = targetUrl; },
		release: () => { url = targetUrl; created.release(); navigation.release(); preload.release(); shell.release(); },
	};
}

function createClock() {
	let now = performance.now();
	const performanceClock = mock.method(performance, 'now', () => now);
	mock.timers.enable({ apis: ['setTimeout'] });
	return {
		async advance(milliseconds: number) { now += milliseconds; mock.timers.tick(milliseconds); await setImmediate(); },
		[Symbol.dispose]() { mock.timers.reset(); performanceClock.mock.restore(); },
	};
}

function createWorkbench(blockFrames = false) {
	const dom = new JSDOM('<!doctype html><main class="ash-workbench" aria-busy="true"><div class="ash-workbench-editor"><div class="ash-editor-group"><div class="ash-editor-title-control"></div><div class="ash-editor-group-content"></div></div></div></main>');
	const document = dom.window.document;
	const root = document.querySelector('main')!;
	class Locator {
		readonly _apiName = 'Locator';
		constructor(private readonly selector: string) {}
		locator(selector: string) { return new Locator(`${this.selector} ${selector}`); }
		nth() { return this; }
		getByRole(role: string) { return this.locator(`[role="${role}"]`); }
		async waitFor() { assert.ok(document.querySelector(this.selector), this.selector); }
		async _expect(expression: string, options: { expressionArg: string; expectedText: { string: string }[]; timeout: number }) {
			assert.equal(expression, 'to.have.attribute.value');
			const element = document.querySelector(this.selector)!;
			const expected = options.expectedText[0]!.string;
			return new Promise(resolve => {
				const complete = () => {
					observer.disconnect();
					clearTimeout(timer);
					resolve({ matches: element.getAttribute(options.expressionArg) === expected, received: element.getAttribute(options.expressionArg), log: [], timedOut: false });
				};
				const observer = new dom.window.MutationObserver(() => { if (element.getAttribute(options.expressionArg) === expected) complete(); });
				const timer = setTimeout(complete, options.timeout);
				observer.observe(element, { attributes: true });
				if (element.getAttribute(options.expressionArg) === expected) complete();
			});
		}
	}
	const page = {
		locator: (selector: string) => new Locator(selector),
		waitForFunction: async () => {},
		evaluate: async () => { if (blockFrames) await new Promise(() => {}); },
	} as unknown as Page;
	return { root, page, workbench: new Workbench(page), restore: () => root.setAttribute('aria-busy', 'false'), [Symbol.dispose]: () => dom.window.close() };
}
