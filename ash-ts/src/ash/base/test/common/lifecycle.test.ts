import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	AbstractDisposable,
	AsyncDisposableStore,
	DisposableMap,
	MutableDisposable,
	DisposableStore,
	Disposable,
	dispose,
	ImmortalReference,
	type IDisposable,
	isDisposable,
	noneDisposable,
	toDisposable,
} from "../../common/lifecycle.js";

test('dispose releases complete collections and aggregates failures', () => {
	const calls: string[] = [];
	assert.deepEqual(dispose([
		toDisposable(() => calls.push('first')),
		toDisposable(() => calls.push('second')),
	]), []);
	assert.deepEqual(calls, ['first', 'second']);
	assert.throws(() => dispose([
		toDisposable(() => { throw new Error('first failure'); }),
		toDisposable(() => { throw new Error('second failure'); }),
	]), AggregateError);
});

test("noneDisposable is a reusable no-op", () => {
	assert.equal(Disposable.None, noneDisposable);
	noneDisposable.dispose();
	noneDisposable[Symbol.dispose]();
	assert.equal(Object.isFrozen(noneDisposable), true);
});

test("AsyncDisposableStore shares one cleanup operation", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let cleanupCalls = 0;
	const store = new AsyncDisposableStore();
	store.add({
		async [Symbol.asyncDispose](): Promise<void> {
			cleanupCalls += 1;
			await gate;
		},
	});
	const first = store.disposeAsync();
	const second = store[Symbol.asyncDispose]();
	assert.equal(first, second);
	release();
	await first;
	assert.equal(cleanupCalls, 1);
});

test("AbstractDisposable runs leaf cleanup once", () => {
	class Resource extends AbstractDisposable {
		public cleanupCalls = 0;

		protected override disposeCore(): void {
			this.cleanupCalls += 1;
		}
	}

	const resource = new Resource();
	resource.dispose();
	resource[Symbol.dispose]();

	assert.equal(resource.cleanupCalls, 1);
});

test("project disposables support explicit disposal and using", () => {
	let calls = 0;

	{
		using resource = toDisposable(() => {
			calls += 1;
		});
		resource.dispose();
	}

	assert.equal(calls, 1);
});

test("DisposableStore releases resources in LIFO order and is idempotent", () => {
	const released: number[] = [];
	const store = new DisposableStore();
	store.add(toDisposable(() => released.push(1)));
	store.add(null);
	store.add(toDisposable(() => released.push(2)));
	store.add(undefined);

	store.dispose();
	store.dispose();

	assert.deepEqual(released, [2, 1]);
});

test("a disposed store rejects resources without taking ownership", () => {
	const store = new DisposableStore();
	store.dispose();
	let disposed = false;
	const resource = toDisposable(() => {
		disposed = true;
	});

	assert.throws(() => store.add(resource), ReferenceError);
	assert.equal(disposed, false);
	resource.dispose();
});

test("DisposableStore owns callback cleanup through toDisposable", () => {
	const released: string[] = [];
	const store = new DisposableStore();
	store.add(toDisposable(() => released.push("value")));
	store.add(toDisposable(() => released.push("deferred")));

	store.dispose();
	assert.deepEqual(released, ["deferred", "value"]);
});

test("DisposableStore delete transfers a resource without disposing it", () => {
	const calls: string[] = [];
	const store = new DisposableStore();
	const first = store.add(toDisposable(() => calls.push("first")));
	store.add(toDisposable(() => calls.push("second")));

	assert.equal(store.delete(first), true);
	assert.equal(store.delete(first), false);
	store.dispose();
	assert.deepEqual(calls, ["second"]);
	first.dispose();
	assert.deepEqual(calls, ["second", "first"]);
});

test("DisposableMap replaces, removes, leaks, and disposes keyed resources", () => {
	const released: string[] = [];
	const resources = new DisposableMap<string>();
	resources.set("first", toDisposable(() => released.push("first:old")));
	resources.set("first", toDisposable(() => released.push("first:new")));
	resources.set("second", toDisposable(() => released.push("second")));
	resources.set("third", toDisposable(() => released.push("third")));

	assert.deepEqual(released, ["first:old"]);
	assert.equal(resources.deleteAndDispose("first"), true);
	assert.equal(resources.deleteAndDispose("missing"), false);
	const leaked = resources.set("leaked", toDisposable(() => released.push("leaked")));
	assert.equal(resources.deleteAndLeak("leaked"), leaked);
	resources.dispose();
	resources.dispose();
	assert.deepEqual(released, ["first:old", "first:new", "third", "second"]);
	leaked[Symbol.dispose]();
	assert.deepEqual(released, ["first:old", "first:new", "third", "second", "leaked"]);

	const rejected = toDisposable(() => released.push("rejected"));
	assert.throws(() => resources.set("rejected", rejected), ReferenceError);
	rejected.dispose();
});

test("DisposableStore attempts every cleanup and preserves suppressed errors", () => {
	const released: number[] = [];
	const store = new DisposableStore();
	store.add(toDisposable(() => {
		released.push(1);
		throw new Error("first cleanup failed");
	}));
	store.add(toDisposable(() => {
		released.push(2);
		throw new Error("second cleanup failed");
	}));

	assert.throws(
		() => store.dispose(),
		(error: unknown) => error instanceof SuppressedError,
	);
	assert.deepEqual(released, [2, 1]);
	assert.equal(store.isDisposed, true);
});

test("Disposable owns standard Disposable resources", () => {
	class Owner extends Disposable {
		take<T extends IDisposable>(resource: T): T {
			return this._register(resource);
		}
	}

	let disposed = false;
	const owner = new Owner();
	owner.take(toDisposable(() => {
		disposed = true;
	}));
	owner[Symbol.dispose]();
	owner.dispose();

	assert.equal(disposed, true);
	assert.equal(owner.isDisposed, true);
	const rejected = toDisposable(() => undefined);
	assert.throws(
		() => owner.take(rejected),
		ReferenceError,
	);
	rejected.dispose();
});

test("MutableDisposable releases replaced and current values", () => {
	const released: number[] = [];
	const slot = new MutableDisposable();
	slot.value = toDisposable(() => released.push(1));
	slot.value = toDisposable(() => released.push(2));

	assert.deepEqual(released, [1]);
	slot.dispose();
	assert.deepEqual(released, [1, 2]);
});

test("a disposed MutableDisposable ignores values without taking ownership", () => {
	const slot = new MutableDisposable();
	slot.dispose();
	let disposed = false;
	const resource = toDisposable(() => {
		disposed = true;
	});

	slot.value = resource;
	assert.equal(disposed, false);
	resource.dispose();
});

test("MutableDisposable can leak its current value without disposing it", () => {
	let disposed = false;
	const slot = new MutableDisposable();
	const resource = toDisposable(() => {
		disposed = true;
	});
	slot.value = resource;

	assert.equal(slot.clearAndLeak(), resource);
	assert.equal(slot.value, undefined);
	assert.equal(disposed, false);
	resource.dispose();
	assert.equal(disposed, true);
});

test("MutableDisposable clears its value and releases it only once", () => {
	let cleanupCalls = 0;
	const slot = new MutableDisposable();
	const resource = toDisposable(() => {
		cleanupCalls += 1;
	});

	slot.value = resource;
	slot.value = resource;
	slot.clear();
	slot.clear();
	slot.dispose();
	slot.dispose();

	assert.equal(slot.value, undefined);
	assert.equal(cleanupCalls, 1);
});

test("DisposableStore clears, rebuilds, and then closes", () => {
	const released: number[] = [];
	const group = new DisposableStore();
	group.add(toDisposable(() => released.push(1)));
	group.clear();
	group.add(toDisposable(() => released.push(2)));
	group.dispose();

	assert.deepEqual(released, [1, 2]);
	assert.throws(
		() => group.add(toDisposable(() => released.push(3))),
		ReferenceError,
	);
});

test("AsyncDisposableStore owns sync and async resources in LIFO order", async () => {
	const released: number[] = [];

	await (async () => {
		await using store = new AsyncDisposableStore();
		store.add(toDisposable(() => released.push(1)));
		store.add({
			async [Symbol.asyncDispose](): Promise<void> {
				await Promise.resolve();
				released.push(2);
			},
		});
	})();

	assert.deepEqual(released, [2, 1]);
});

test("AsyncDisposableStore closes registration when disposal starts", async () => {
	const store = new AsyncDisposableStore();
	const disposal = store.disposeAsync();
	const rejected = toDisposable(() => undefined);

	assert.equal(store.isDisposed, true);
	assert.throws(() => store.add(rejected), ReferenceError);
	rejected.dispose();
	await disposal;
});

test("disposable guards and borrowed references keep ownership explicit", () => {
	const borrowed = { value: 1 };
	const reference = new ImmortalReference(borrowed);
	assert.equal(reference.object, borrowed);
	assert.equal(isDisposable(reference), true);
	assert.equal(isDisposable({ dispose(value: unknown): void { void value; } }), false);
	assert.equal(isDisposable(null), false);
	assert.doesNotThrow(() => reference.dispose());
});
