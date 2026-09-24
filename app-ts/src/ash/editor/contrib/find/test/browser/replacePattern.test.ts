import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ReplacePattern, ReplacePiece, parseReplaceString } from '../../browser/replacePattern.js';

test('replacement parser keeps literal escapes and captures distinct', () => {
	assert.deepEqual(parseReplaceString('a$$b\\n$1'), new ReplacePattern([
		ReplacePiece.staticValue('a$b\n'),
		ReplacePiece.matchIndex(1),
	]));
	assert.equal(parseReplaceString('$10/$2/$&').buildReplaceString(['whole', 'first']), 'first0/$2/whole');
});

test('replacement parser expands named captures, case operations, and preserved case', () => {
	const captures: string[] & { groups?: Record<string, string | undefined> } = ['name: ash', 'name', 'ash'];
	captures.groups = { key: 'name' };
	assert.equal(parseReplaceString('$<key>=\\U$2 $$ $&').buildReplaceString(captures), 'name=ASH $ name: ash');
	assert.equal(parseReplaceString('\\u$2').buildReplaceString(captures), 'Ash');
	assert.equal(ReplacePattern.fromStaticValue('value').buildReplaceString(['VALUE'], true), 'VALUE');
	assert.equal(ReplacePattern.fromStaticValue('value').buildReplaceString([''], true), 'value');
});
