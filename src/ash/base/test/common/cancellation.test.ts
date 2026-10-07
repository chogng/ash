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
import { errorHandler, isCancellationError, setUnexpectedErrorHandler } from "../../common/errors.js";
import { DisposableStore, type IDisposable } from "../../common/lifecycle.js";
import { runWithBufferedEvents } from "../../common/event.js";

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

test("CancellationTokenSource propagates cancellation synchronously inside event buffering", () => {
	using parent = new CancellationTokenSource();
	using child = new CancellationTokenSource(parent.token);
	using pool = new CancellationTokenPool();
	pool.add(child.token);
	const notifications: string[] = [];
	using parentListener = parent.token.onCancellationRequested(() => notifications.push("parent"));
	using childListener = child.token.onCancellationRequested(() => notifications.push("child"));
	using poolListener = pool.token.onCancellationRequested(() => notifications.push("pool"));

	runWithBufferedEvents(() => {
		parent.cancel();
		assert.deepEqual({
			cancelled: [parent.token, child.token, pool.token].map(token => token.isCancellationRequested),
			notifications,
		}, { cancelled: [true, true, true], notifications: ["pool", "child", "parent"] });
	});
	parent.cancel();
	assert.deepEqual(notifications, ["pool", "child", "parent"]);
});

test("failed buffered mutations cannot roll back cancellation propagation", async () => {
	using parent = new CancellationTokenSource();
	using child = new CancellationTokenSource(parent.token);
	const pending = raceCancellationError(new Promise<void>(() => undefined), child.token);
	const failure = new Error("mutation failed");

	assert.throws(() => runWithBufferedEvents(() => {
		parent.cancel();
		throw failure;
	}), error => error === failure);

	assert.equal(child.token.isCancellationRequested, true);
	await assert.rejects(pending, isCancellationError);
});

test("cancelOnDispose notifies listeners before a buffered owner disposal returns", () => {
	using store = new DisposableStore();
	const token = cancelOnDispose(store);
	let notifications = 0;
	using listener = token.onCancellationRequested(() => notifications++);

	runWithBufferedEvents(() => {
		store.dispose();
		assert.deepEqual([token.isCancellationRequested, notifications], [true, 1]);
	});
});

test("an existing token can be cancelled after source disposal without reviving old listeners", () => {
	for (const cancelThroughDispose of [false, true]) {
		using source = new CancellationTokenSource();
		const token = source.token;
		let notifications = 0;
		using listener = token.onCancellationRequested(() => notifications++);
		source.dispose();
		if (cancelThroughDispose) {
			source.dispose(true);
		} else {
			source.cancel();
		}
		assert.deepEqual([source.token === token, token.isCancellationRequested, notifications], [true, true, 0]);
	}
});

test("disposing a source before reading its token keeps the empty token even after cancellation", () => {
	using source = new CancellationTokenSource();
	source.dispose();
	source.cancel();
	source.dispose(true);
	assert.equal(source.token, CancellationToken.None);
});

test("cancellation keeps duplicate registrations independent and skips removed listeners", () => {
	using source = new CancellationTokenSource();
	const context = { notifications: 0 };
	const subscriptions: IDisposable[] = [];
	function listener(this: typeof context): void {
		this.notifications++;
	}
	using remover = source.token.onCancellationRequested(() => removed.dispose());
	using removed = source.token.onCancellationRequested(listener, context, subscriptions);
	using first = source.token.onCancellationRequested(listener, context, subscriptions);
	using second = source.token.onCancellationRequested(listener, context, subscriptions);
	source.cancel();
	source.cancel();
	assert.deepEqual([context.notifications, subscriptions.length], [2, 3]);
});

test("late subscriptions through a retained event are asynchronous and can be disposed", async () => {
	using source = new CancellationTokenSource();
	const event = source.token.onCancellationRequested;
	source.cancel();
	const notifications: string[] = [];
	using removed = event(() => notifications.push("removed"));
	removed.dispose();
	let subscription: IDisposable | undefined;
	const delivered = new Promise<void>(resolve => {
		subscription = event(() => {
			notifications.push("retained");
			resolve();
		});
	});
	try {
		assert.deepEqual(notifications, []);
		await delivered;
		assert.deepEqual(notifications, ["retained"]);
	} finally {
		subscription?.dispose();
	}
});

test("listener failures are reported without stopping cancellation propagation", () => {
	using parent = new CancellationTokenSource();
	const failure = new Error("listener failed");
	const failures: unknown[] = [];
	const previousHandler = errorHandler.getUnexpectedErrorHandler();
	setUnexpectedErrorHandler(error => failures.push(error));
	try {
		using listener = parent.token.onCancellationRequested(() => { throw failure; });
		using child = new CancellationTokenSource(parent.token);
		parent.cancel();
		assert.deepEqual([failures, child.token.isCancellationRequested], [[failure], true]);
	} finally {
		setUnexpectedErrorHandler(previousHandler);
	}
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
