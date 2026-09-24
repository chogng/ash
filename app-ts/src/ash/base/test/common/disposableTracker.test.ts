import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	AbstractDisposable,
	DisposableMap,
	DisposableStore,
	Disposable,
	DisposableTracker,
	installDisposableTracker,
	markAsSingleton,
	MutableDisposable,
	type IDisposable,
	noneDisposable,
	toDisposable,
} from "../../common/lifecycle.js";

test("AbstractDisposable closes its tracking record when cleanup throws", () => {
	class Resource extends AbstractDisposable {
		protected override disposeCore(): void {
			throw new Error("cleanup failed");
		}
	}

	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const resource = new Resource();

	assert.equal(tracker.leaks()[0]?.label, "Resource");
	assert.throws(() => resource.dispose(), /cleanup failed/);
	tracker.assertNoLeaks();
	resource[Symbol.dispose]();
});

test("DisposableTracker reports an unowned disposable until it is disposed", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const resource = toDisposable(() => {});

	const [leak] = tracker.leaks();
	assert.equal(leak?.label, "toDisposable");
	assert.equal(leak?.ownerLabel, undefined);
	assert.match(leak?.createdAt ?? "", /disposableTracker\.test/);
	assert.throws(() => tracker.assertNoLeaks(), /1 undisposed disposable/);

	resource[Symbol.dispose]();
	tracker.assertNoLeaks();
});

test("markAsSingleton excludes a process-lifetime disposable from leak reports", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const resource = markAsSingleton(toDisposable(() => {}));

	tracker.assertNoLeaks();
	resource.dispose();
});

test("DisposableTracker records ownership and closes the complete subtree", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const store = new DisposableStore();
	store.add(toDisposable(() => {}));

	const child = tracker.leaks().find((leak) => leak.label === "toDisposable");
	assert.equal(child?.ownerLabel, "DisposableStore");

	store.dispose();
	tracker.assertNoLeaks();
});

test("DisposableStore closes tracker records for structural resources", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	let cleanupCalls = 0;
	const resource: IDisposable = {
		dispose(): void {
			cleanupCalls += 1;
		},
		[Symbol.dispose](): void {
			this.dispose();
		},
	};
	const store = new DisposableStore();
	store.add(resource);

	store.dispose();

	assert.equal(cleanupCalls, 1);
	tracker.assertNoLeaks();
});

test("DisposableTracker follows values owned by DisposableMap", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const resources = new DisposableMap<string>();
	resources.set("resource", toDisposable(() => {}));

	const child = tracker.leaks().find((leak) => leak.label === "toDisposable");
	assert.equal(child?.ownerLabel, "DisposableMap");

	resources.dispose();
	tracker.assertNoLeaks();
});

test("DisposableMap releases leaked values from its ownership graph", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const resources = new DisposableMap<string>();
	const resource = resources.set("resource", toDisposable(() => {}));

	assert.equal(resources.deleteAndLeak("resource"), resource);
	const child = tracker.leaks().find((leak) => leak.label === "toDisposable");
	assert.equal(child?.ownerLabel, undefined);

	resources.dispose();
	resource[Symbol.dispose]();
	tracker.assertNoLeaks();
});

test("DisposableTracker follows MutableDisposable values", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const slot = new MutableDisposable();
	const first = toDisposable(() => {});
	const second = toDisposable(() => {});
	slot.value = first;

	assert.equal(
		tracker.leaks().find((leak) => leak.disposable === first)?.ownerLabel,
		"MutableDisposable",
	);
	slot.value = second;
	assert.equal(tracker.leaks().some((leak) => leak.disposable === first), false);

	slot.dispose();
	tracker.assertNoLeaks();
});

test("noneDisposable can be shared by independent owners", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const first = new DisposableStore();
	const second = new DisposableStore();
	first.add(noneDisposable);
	second.add(noneDisposable);

	first.dispose();
	second.dispose();
	tracker.assertNoLeaks();
});

test("DisposableTracker follows Disposable through its internal store", () => {
	class Owner extends Disposable {
		take(resource: IDisposable): void {
			this._register(resource);
		}
	}

	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const owner = new Owner();
	owner.take(toDisposable(() => {}));

	const store = tracker.leaks().find((leak) =>
		leak.label === "DisposableStore"
	);
	assert.equal(store?.ownerLabel, "Owner");

	owner.dispose();
	tracker.assertNoLeaks();
});

test("DisposableTracker rejects multiple owners before ownership transfers", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const first = new DisposableStore();
	const second = new DisposableStore();
	const resource = first.add(toDisposable(() => {}));

	assert.throws(
		() => second.add(resource),
		/already belongs to DisposableStore/,
	);

	first.dispose();
	second.dispose();
	tracker.assertNoLeaks();
});

test("DisposableTracker rejects ownership cycles", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const parent = new DisposableStore();
	const child = parent.add(new DisposableStore());

	assert.throws(
		() => child.add(parent),
		/ownership cannot contain a cycle/,
	);

	parent.dispose();
	tracker.assertNoLeaks();
});

test("DisposableTracker closes ownership records even when cleanup throws", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const store = new DisposableStore();
	store.add(toDisposable(() => {
		throw new Error("cleanup failed");
	}));

	assert.throws(() => store.dispose(), /cleanup failed/);
	tracker.assertNoLeaks();
});

test("tracking is disabled outside an installed development scope", () => {
	const tracker = new DisposableTracker();
	const resource = toDisposable(() => {});

	assert.equal(tracker.leaks().length, 0);
	resource.dispose();
});

test("only one DisposableTracker can be installed in a JavaScript realm", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);

	assert.throws(
		() => installDisposableTracker(new DisposableTracker()),
		/already installed/,
	);
});
