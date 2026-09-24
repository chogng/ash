import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../common/event.js";
import { toDisposable } from "../../common/lifecycle.js";
import { autorun, autorunWithStore, derived, observableFromEvent, observableValue, transaction } from "../../common/observable.js";

test("derived observables track changing dependency sets", () => {
	const useFirst = observableValue("useFirst", true);
	const first = observableValue("first", 1);
	const second = observableValue("second", 2);
	const selected = derived(reader =>
		useFirst.read(reader) ? first.read(reader) : second.read(reader)
	);
	const values: number[] = [];
	using registration = selected.onDidChange(value => values.push(value));

	first.set(3);
	useFirst.set(false);
	first.set(4);
	second.set(5);

	assert.deepEqual(values, [3, 2, 5]);
	assert.equal(selected.get(), 5);
});

test("transactions publish one final value per observable", () => {
	const value = observableValue("value", 0);
	const values: number[] = [];
	using registration = value.onDidChange(next => values.push(next));

	transaction(tx => {
		value.set(1, tx);
		value.set(2, tx);
		value.set(3, tx);
	});

	assert.deepEqual(values, [3]);
});

test("autorun disposes stale dependencies and per-run resources", () => {
	const selectFirst = observableValue("selectFirst", true);
	const first = observableValue("first", "a");
	const second = observableValue("second", "b");
	const values: string[] = [];
	let resourceDisposals = 0;
	const registration = autorunWithStore((reader, store) => {
		store.add(toDisposable(() => resourceDisposals += 1));
		values.push(selectFirst.read(reader) ? first.read(reader) : second.read(reader));
	});

	first.set("a2");
	selectFirst.set(false);
	first.set("ignored");
	second.set("b2");
	registration.dispose();

	assert.deepEqual(values, ["a", "a2", "b", "b2"]);
	assert.equal(resourceDisposals, 4);
});

test("disposed autoruns stop observing", () => {
	const value = observableValue("value", 1);
	const values: number[] = [];
	const registration = autorun(reader => values.push(value.read(reader)));

	value.set(2);
	registration.dispose();
	value.set(3);

	assert.deepEqual(values, [1, 2]);
});

test("event-backed observables read current state on every event", () => {
	const changed = new Emitter<void>();
	let current = "first";
	const value = observableFromEvent("value", changed.event, () => current);
	const values: string[] = [];
	using registration = autorun(reader => values.push(value.read(reader)));

	current = "second";
	changed.fire();

	assert.deepEqual(values, ["first", "second"]);
});

test("failed initial reactions release resources before propagating", () => {
	let disposals = 0;

	assert.throws(() => autorunWithStore((_reader, store) => {
		store.add(toDisposable(() => disposals += 1));
		throw new Error("initial reaction failed");
	}), /initial reaction failed/);
	assert.equal(disposals, 1);
});
