import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserLifecycleService } from "../../browser/browserLifecycleService.js";

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
