import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { StartupDeadline } from './startupDeadline.js';
import { Workbench } from './workbench.js';

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
	return { root, workbench: new Workbench(page), restore: () => root.setAttribute('aria-busy', 'false'), [Symbol.dispose]: () => dom.window.close() };
}
