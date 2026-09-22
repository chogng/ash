import assert from "node:assert/strict";
import { test } from "mocha";
import { assert as assertCondition, assertDefined, assertReturnsDefined, assertType, isDefined, isFunction, isNonEmptyString, isObject, isRecord, validateConstraint, validateConstraints, type Mutable } from "../../common/types.js";

test("assert narrows caller-defined conditions", () => {
	assert.equal(requireStringFromUnknown("value"), "value");
	assert.throws(
		() => assertCondition(false, "condition was not satisfied"),
		new Error("condition was not satisfied"),
	);
});

test("assertDefined narrows non-nullable values", () => {
	assert.equal(requireString("value"), "value");
	assert.doesNotThrow(() => assertDefined(false, "missing boolean"));
	assert.doesNotThrow(() => assertDefined(0, "missing number"));
	assert.doesNotThrow(() => assertDefined("", "missing string"));
});

test("assertDefined rejects nullish values with caller context", () => {
	assert.throws(
		() => assertDefined(undefined, "value was not initialized"),
		new Error("value was not initialized"),
	);
	assert.throws(
		() => assertDefined(null, "value was cleared"),
		new Error("value was cleared"),
	);
});

test("assertDefined preserves caller-owned errors", () => {
	const error = new ReferenceError("value was not initialized");
	assert.throws(() => assertDefined(undefined, error), (thrown) => thrown === error);
});

test("isRecord accepts records and rejects arrays and null", () => {
	assert.equal(isRecord({ value: 1 }), true);
	assert.equal(isRecord(Object.create(null)), true);
	assert.equal(isRecord([]), false);
	assert.equal(isRecord(null), false);
});

test("isNonEmptyString requires non-whitespace text", () => {
	assert.equal(isNonEmptyString(" value "), true);
	assert.equal(isNonEmptyString(" \t\n"), false);
	assert.equal(isNonEmptyString(1), false);
});

test('general type guards expose object, function, defined, and mutable contracts', () => {
	const value: Mutable<{ readonly count: number }> = { count: 1 };
	value.count = 2;
	assert.deepEqual({
		count: value.count,
		function: isFunction(() => undefined),
		object: isObject({ value: true }),
		array: isObject([]),
		defined: assertReturnsDefined('value'),
	}, {
		count: 2,
		function: true,
		object: true,
		array: false,
		defined: 'value',
	});
	assert.throws(() => assertReturnsDefined(undefined), /must not be null or undefined/);
	assert.deepEqual([undefined, null, 0].filter(isDefined), [0]);
	assert.doesNotThrow(() => assertType(typeof value.count === "number", "number"));
	assert.throws(() => assertType(false, "string"), TypeError);
});

test('argument constraints accept primitives, class instances and strict predicates', () => {
	class Value {}
	class DerivedValue extends Value {}
	const BoundValue = Value.bind(undefined);
	validateConstraints([3, 'text', false], [Number, 'string', Boolean]);
	validateConstraints([new DerivedValue(), new Value()], [Value, BoundValue]);
	validateConstraints([() => undefined, undefined], [Function, (value: unknown) => value === undefined]);
	validateConstraint('text', (value: unknown) => typeof value === 'string');
	assert.throws(() => validateConstraint('3', Number), TypeError);
	assert.throws(() => validateConstraint({}, Value), TypeError);
	assert.throws(() => validateConstraint('text', (value: unknown) => value), TypeError);
});

test('argument constraints check supplied positions without changing values or swallowing predicate errors', () => {
	const args = [3, 'extra'];
	validateConstraints(args, ['number']);
	validateConstraints([], ['number']);
	validateConstraints([undefined], [undefined]);
	assert.deepEqual(args, [3, 'extra']);
	validateConstraints([null], ['object', 'number']);
	assert.throws(() => validateConstraints([undefined], ['object']), TypeError);
	const failure = new Error('predicate failed');
	assert.throws(() => validateConstraint('text', (_value: unknown) => { throw failure; }), error => error === failure);
});

function requireString(value: string | undefined): string {
	assertDefined(value, "string was not initialized");
	return value;
}

function requireStringFromUnknown(value: unknown): string {
	assertCondition(typeof value === "string", "value is not a string");
	return value;
}
