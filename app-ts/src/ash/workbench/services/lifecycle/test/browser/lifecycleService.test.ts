import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserLifecycleService } from "../../browser/lifecycleService.js";
import { ShutdownVetoError } from '../../common/lifecycle.js';

test("BrowserLifecycleService joins participants once before completing shutdown", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const errors: unknown[] = [];
	using lifecycle = new BrowserLifecycleService({ ownerWindow: browser.window as unknown as Window, onError: error => errors.push(error) });
	const events: string[] = [];
	lifecycle.onWillShutdown(event => {
		events.push(`will:${event.reason}`);
		event.join(Promise.resolve().then(() => { events.push("joined"); }), "test participant");
	});
	lifecycle.onDidShutdown(reason => events.push(`did:${reason}`));
	const first = lifecycle.shutdown("reload");
	assert.equal(lifecycle.shutdown("quit"), first);
	await first;
	assert.deepEqual(events, ["will:reload", "joined", "did:reload"]);
	assert.equal(lifecycle.phase, "shutdown");
	assert.deepEqual(errors, []);
	browser.window.close();
});

test("BrowserLifecycleService reports pagehide participant failures", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const errors: unknown[] = [];
	using lifecycle = new BrowserLifecycleService({ ownerWindow: browser.window as unknown as Window, onError: error => errors.push(error) });
	lifecycle.onWillShutdown(event => event.join(Promise.reject(new Error("flush failed")), "failing flush"));
	browser.window.dispatchEvent(new browser.window.PageTransitionEvent("pagehide"));
	await new Promise(resolve => globalThis.setTimeout(resolve, 0));
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /shutdown participants failed/iu);
	browser.window.close();
});

test("BrowserLifecycleService returns the same shutdown promise during onWillShutdown", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	using lifecycle = new BrowserLifecycleService({ ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	let reentrant: Promise<void> | undefined;
	lifecycle.onWillShutdown(() => { reentrant = lifecycle.shutdown("quit"); });
	const initial = lifecycle.shutdown("reload");
	assert.equal(reentrant, initial);
	await initial;
	browser.window.close();
});

test('BrowserLifecycleService retries a failed shutdown without publishing completion', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using lifecycle = new BrowserLifecycleService({ ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	let attempts = 0;
	const completed: string[] = [];
	lifecycle.onWillShutdown(event => event.join(++attempts === 1 ? Promise.reject(new Error('save failed')) : Promise.resolve(), 'backup'));
	lifecycle.onDidShutdown(reason => completed.push(reason));
	await assert.rejects(lifecycle.shutdown('windowClose'), /shutdown participants failed/);
	assert.equal(lifecycle.phase, 'running');
	assert.deepEqual(completed, []);
	await lifecycle.shutdown('windowClose');
	assert.equal(lifecycle.phase, 'shutdown');
	assert.deepEqual(completed, ['windowClose']);
	browser.window.close();
});

test('BrowserLifecycleService waits for an asynchronous veto before shutdown and permits retry', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using lifecycle = new BrowserLifecycleService({ ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	let shouldVeto = true;
	let reentrant: Promise<void> | undefined;
	const events: string[] = [];
	lifecycle.onBeforeShutdown(event => {
		reentrant = lifecycle.shutdown('quit');
		event.veto(Promise.resolve(shouldVeto), 'editor');
	});
	lifecycle.onShutdownVeto(() => events.push('veto'));
	lifecycle.onWillShutdown(() => events.push('will'));
	const first = lifecycle.shutdown('windowClose');
	assert.equal(reentrant, first);
	await assert.rejects(first, ShutdownVetoError);
	assert.deepEqual({ events, phase: lifecycle.phase }, { events: ['veto'], phase: 'running' });
	shouldVeto = false;
	await lifecycle.shutdown('windowClose');
	assert.deepEqual(events, ['veto', 'will']);
	browser.window.close();
});

test('BrowserLifecycleService treats a rejected pre-shutdown check as a veto error', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using lifecycle = new BrowserLifecycleService({ ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	const errors: string[] = [];
	lifecycle.onBeforeShutdown(event => event.veto(Promise.reject(new Error('backup failed')), 'backup'));
	lifecycle.onBeforeShutdownError(event => errors.push(event.error.message));
	lifecycle.onWillShutdown(() => errors.push('will'));
	await assert.rejects(lifecycle.shutdown('windowClose'), /shutdown vetoes failed/);
	assert.deepEqual({ errors, phase: lifecycle.phase }, { errors: ["Shutdown veto 'backup' failed"], phase: 'running' });
	browser.window.close();
});
