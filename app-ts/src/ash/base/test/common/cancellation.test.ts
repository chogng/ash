import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	CancellationToken,
	CancellationTokenPool,
	CancellationTokenSource,
	cancelOnDispose,
	throwIfCancelled,
} from "../../common/cancellation.js";
import { raceCancellationError } from "../../common/async.js";
import { isCancellationError } from "../../common/errors.js";
import { DisposableStore } from "../../common/lifecycle.js";

test("CancellationToken exposes stable none and cancelled tokens", async () => {
	assert.equal(CancellationToken.isCancellationToken(CancellationToken.None), true);
	assert.equal(CancellationToken.None.isCancellationRequested, false);
	assert.equal(CancellationToken.Cancelled.isCancellationRequested, true);
	let cancelled = false;
	using listener = CancellationToken.Cancelled.onCancellationRequested(() => cancelled = true);
	assert.equal(cancelled, false);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(cancelled, true);
});

test("CancellationTokenSource cancels once, keeps token identity, and follows its parent", () => {
	using parent = new CancellationTokenSource();
	using child = new CancellationTokenSource(parent.token);
	const token = child.token;
	let count = 0;
	using listener = token.onCancellationRequested(() => count += 1);

	parent.cancel();
	parent.cancel();

	assert.equal(child.token, token);
	assert.equal(token.isCancellationRequested, true);
	assert.equal(count, 1);
});

test("CancellationTokenSource disposal only cancels when requested", () => {
	const retained = new CancellationTokenSource();
	const retainedToken = retained.token;
	retained.dispose();
	assert.equal(retainedToken.isCancellationRequested, false);

	const cancelled = new CancellationTokenSource();
	const cancelledToken = cancelled.token;
	cancelled.dispose(true);
	assert.equal(cancelledToken.isCancellationRequested, true);
});

test("cancelOnDispose and CancellationTokenPool preserve aggregate lifecycle", () => {
	using store = new DisposableStore();
	const disposedToken = cancelOnDispose(store);
	assert.equal(disposedToken.isCancellationRequested, false);
	store.dispose();
	assert.equal(disposedToken.isCancellationRequested, true);

	using first = new CancellationTokenSource();
	using second = new CancellationTokenSource();
	using pool = new CancellationTokenPool();
	pool.add(first.token);
	pool.add(second.token);
	first.cancel();
	assert.equal(pool.token.isCancellationRequested, false);
	second.cancel();
	assert.equal(pool.token.isCancellationRequested, true);
});

test("CancellationTokenPool counts an already cancelled token immediately", () => {
	using pool = new CancellationTokenPool();
	pool.add(CancellationToken.Cancelled);
	assert.equal(pool.token.isCancellationRequested, true);
	pool.add(CancellationToken.None);
	assert.equal(pool.token.isCancellationRequested, true);
});

test("live AbortSignals do not cancel an operation", () => {
	const controller = new AbortController();

	assert.doesNotThrow(() => throwIfCancelled(controller.signal));
});

test("aborted signals produce a classified error and preserve their reason", () => {
	const controller = new AbortController();
	const reason = new Error("superseded");
	controller.abort(reason);

	assert.throws(
		() => throwIfCancelled(controller.signal, "Request cancelled"),
		(error: unknown) => {
			assert.ok(isCancellationError(error));
			assert.equal(error.message, "Request cancelled");
			assert.equal(error.reason, reason);
			assert.equal(error.cause, reason);
			return true;
		},
	);
});

test("raceCancellationError preserves settlement and classifies caller cancellation", async () => {
	const live = new AbortController();
	assert.equal(await raceCancellationError(Promise.resolve(42), live.signal), 42);

	const cancelled = new AbortController();
	const reason = new Error("stop waiting");
	const pending = raceCancellationError(new Promise<number>(() => undefined), cancelled.signal, "Module wait cancelled");
	cancelled.abort(reason);
	await assert.rejects(pending, error => (
		isCancellationError(error) &&
		error.message === "Module wait cancelled" &&
		error.reason === reason
	));

	const alreadyCancelled = new AbortController();
	alreadyCancelled.abort("already");
	await assert.rejects(raceCancellationError(Promise.resolve(1), alreadyCancelled.signal), error => (
		isCancellationError(error) && error.reason === "already"
	));

	using source = new CancellationTokenSource();
	const tokenRace = raceCancellationError(new Promise<number>(() => undefined), source.token, "Token wait cancelled");
	source.cancel();
	await assert.rejects(tokenRace, error => (
		isCancellationError(error) && error.message === "Token wait cancelled"
	));
});
