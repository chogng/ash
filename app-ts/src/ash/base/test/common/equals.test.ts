import assert from 'node:assert/strict';
import { test } from 'mocha';
import { arrayEqualsC, equalsIfDefinedC, structuralEquals, thisEqualsC } from '../../common/equals.js';
import { equals as objectEquals } from '../../common/objects.js';

test('structural equality ignores plain-object key order and preserves array order', () => {
	assert.equal(structuralEquals({ b: [2, 3], a: 1 }, { a: 1, b: [2, 3] }), true);
	assert.equal(structuralEquals({ b: [3, 2], a: 1 }, { a: 1, b: [2, 3] }), false);
	assert.equal(structuralEquals(new Date(0), new Date(0)), false);
	assert.equal(objectEquals({ nested: true }, { nested: true }), true);
});

test('equality comparer factories compose domain equality', () => {
	const caseInsensitive = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
	assert.equal(arrayEqualsC(caseInsensitive)(['A'], ['a']), true);
	assert.equal(equalsIfDefinedC(caseInsensitive)(undefined, undefined), true);
	assert.equal(equalsIfDefinedC(caseInsensitive)(undefined, 'value'), false);
	class EquatableValue {
		constructor(readonly id: number) {}
		equals(other: EquatableValue): boolean { return this.id === other.id; }
	}
	assert.equal(thisEqualsC<EquatableValue>()(new EquatableValue(1), new EquatableValue(1)), true);
});
