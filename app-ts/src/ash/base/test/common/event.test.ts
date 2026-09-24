import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createEventDeliveryQueue, Emitter, Event, PauseableEmitter, runWithBufferedEvents, ValueWithChangeEvent } from "../../common/event.js";
import { DisposableStore, type IDisposable, noneDisposable } from "../../common/lifecycle.js";

test("Event.None returns the reusable empty disposable", () => {
	assert.equal(Event.None(() => undefined), noneDisposable);
});

test("Emitter binds listener context and registers subscriptions with their owner", () => {
	using emitter = new Emitter<number>();
	const context = { total: 1 };
	const subscriptions: IDisposable[] = [];
	emitter.event(function (this: typeof context, event) {
		this.total += event;
	}, context, subscriptions);

	assert.equal(emitter.hasListeners(), true);
	emitter.fire(2);
	assert.equal(context.total, 3);
	assert.equal(subscriptions.length, 1);
	subscriptions[0].dispose();
	assert.equal(emitter.hasListeners(), false);

	using store = new DisposableStore();
	emitter.event(() => context.total += 1, undefined, store);
	store.clear();
	assert.equal(emitter.hasListeners(), false);
});

test("Emitter delivers synchronously and subscriptions are disposable", () => {
	const emitter = new Emitter<number>();
	const received: number[] = [];
	const subscription = emitter.event((event) => received.push(event));

	emitter.fire(1);
	assert.deepEqual(received, [1]);

	subscription.dispose();
	emitter.fire(2);
	assert.deepEqual(received, [1]);

	emitter.dispose();
	assert.throws(() => emitter.event(() => undefined), ReferenceError);
	emitter.fire(3);
});

test("Emitter treats repeated listener registrations independently", () => {
	const emitter = new Emitter<void>();
	let calls = 0;
	const listener = (): void => {
		calls += 1;
	};
	const first = emitter.event(listener);
	const second = emitter.event(listener);

	emitter.fire();
	assert.equal(calls, 2);

	first.dispose();
	emitter.fire();
	assert.equal(calls, 3);

	second.dispose();
	emitter.dispose();
});

test("Emitter reports listener lifecycle in registration order", () => {
	const lifecycle: string[] = [];
	const emitter = new Emitter<void>({
		onWillAddFirstListener: () => lifecycle.push("will-first"),
		onDidAddFirstListener: () => lifecycle.push("did-first"),
		onDidAddListener: () => lifecycle.push("did-add"),
		onWillRemoveListener: () => lifecycle.push("will-remove"),
		onDidRemoveLastListener: () => lifecycle.push("did-remove-last"),
	});
	const first = emitter.event(() => undefined);
	const second = emitter.event(() => undefined);
	assert.deepEqual(lifecycle, ["will-first", "did-first", "did-add", "did-add"]);

	first.dispose();
	assert.deepEqual(lifecycle, ["will-first", "did-first", "did-add", "did-add", "will-remove"]);
	second.dispose();
	assert.deepEqual(lifecycle, ["will-first", "did-first", "did-add", "did-add", "will-remove", "will-remove", "did-remove-last"]);

	emitter.event(() => undefined);
	emitter.dispose();
	assert.deepEqual(lifecycle.slice(-4), ["will-first", "did-first", "did-add", "did-remove-last"]);
});

test("Emitter snapshots registrations before delivering an event", () => {
	const emitter = new Emitter<number>();
	const received: string[] = [];
	let second: IDisposable;
	const first = emitter.event((event) => {
		received.push(`first:${event}`);
		second.dispose();
		second = emitter.event((next) => received.push(`late:${next}`));
	});
	second = emitter.event((event) => received.push(`second:${event}`));

	emitter.fire(1);
	assert.deepEqual(received, ["first:1"]);

	emitter.fire(2);
	assert.deepEqual(received, ["first:1", "first:2"]);

	first.dispose();
	second.dispose();
	emitter.dispose();
});

test("Emitter queues reentrant events in FIFO order", () => {
	const emitter = new Emitter<number>();
	const received: string[] = [];
	const first = emitter.event((event) => {
		received.push(`first:${event}`);
		if (event === 1) emitter.fire(2);
	});
	const second = emitter.event((event) => {
		received.push(`second:${event}`);
	});

	emitter.fire(1);

	assert.deepEqual(received, [
		"first:1",
		"second:1",
		"first:2",
		"second:2",
	]);
	first.dispose();
	second.dispose();
	emitter.dispose();
});

test("Emitter reports listener errors and continues delivery", () => {
	const expected = new Error("listener failed");
	const errors: unknown[] = [];
	const emitter = new Emitter<void>({
		onListenerError: (error) => errors.push(error),
	});
	const failing = emitter.event(() => {
		throw expected;
	});
	let delivered = false;
	const succeeding = emitter.event(() => {
		delivered = true;
	});

	assert.doesNotThrow(() => emitter.fire());
	assert.equal(delivered, true);
	assert.deepEqual(errors, [expected]);

	failing.dispose();
	succeeding.dispose();
	emitter.dispose();
});

test("runWithBufferedEvents publishes only after every state mutation completes", () => {
	const first = new Emitter<void>();
	const second = new Emitter<void>();
	const state = { first: 0, second: 0 };
	const observations: string[] = [];
	first.event(() => observations.push(`${state.first}:${state.second}`));
	second.event(() => observations.push(`${state.first}:${state.second}`));

	runWithBufferedEvents(() => {
		state.first = 1;
		first.fire();
		state.second = 1;
		second.fire();
		assert.deepEqual(observations, []);
	});

	assert.deepEqual(observations, ["1:1", "1:1"]);
	first.dispose();
	second.dispose();
});

test("runWithBufferedEvents discards notifications from failed mutations", () => {
	const emitter = new Emitter<void>();
	let calls = 0;
	emitter.event(() => { calls += 1; });

	assert.throws(() => runWithBufferedEvents(() => {
		emitter.fire();
		throw new Error("failed");
	}), /failed/);

	assert.equal(calls, 0);
	emitter.dispose();
});

test("shared delivery queues keep nested cross-emitter delivery in FIFO order", () => {
	const deliveryQueue = createEventDeliveryQueue();
	const first = new Emitter<number>({ deliveryQueue });
	const second = new Emitter<number>({ deliveryQueue });
	const received: string[] = [];
	first.event(value => {
		received.push(`first-a:${value}`);
		second.fire(value);
	});
	first.event(value => received.push(`first-b:${value}`));
	second.event(value => received.push(`second:${value}`));

	first.fire(1);

	assert.deepEqual(received, ["first-a:1", "first-b:1", "second:1"]);
	first.dispose();
	second.dispose();
});

test("PauseableEmitter preserves nesting and optionally merges queued events", () => {
	const plain = new PauseableEmitter<number>();
	const received: number[] = [];
	plain.event(value => received.push(value));
	plain.pause();
	plain.pause();
	plain.fire(1);
	plain.fire(2);
	plain.resume();
	assert.deepEqual([...received], []);
	plain.resume();
	assert.deepEqual(received, [1, 2]);

	const merged = new PauseableEmitter<number>({ merge: values => values.reduce((sum, value) => sum + value, 0) });
	merged.event(value => received.push(value));
	merged.pause();
	merged.fire(3);
	merged.fire(4);
	merged.resume();
	assert.deepEqual(received, [1, 2, 7]);
	plain.dispose();
	merged.dispose();
});

test("ValueWithChangeEvent emits only for changed values", () => {
	const value = new ValueWithChangeEvent(1);
	let changes = 0;
	value.onDidChange(() => changes += 1);
	value.value = 1;
	value.value = 2;
	assert.equal(value.value, 2);
	assert.equal(changes, 1);
	assert.equal(ValueWithChangeEvent.const("fixed").value, "fixed");
});
