import assert from 'node:assert/strict';
import { test } from 'mocha';
import { hash, StringSHA1 } from '../../common/hash.js';

test('hash is stable across plain-object key ordering', () => {
	assert.equal(hash({ a: 1, b: [true, 'value'] }), hash({ b: [true, 'value'], a: 1 }));
	assert.notEqual(hash({ a: 1 }), hash({ a: 2 }));
});

test('StringSHA1 matches standard vectors and chunked Unicode input', () => {
	const empty = new StringSHA1();
	assert.equal(empty.digest(), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
	const abc = new StringSHA1();
	abc.update('abc');
	assert.equal(abc.digest(), 'a9993e364706816aba3e25717850c26c9cd0d89d');
	const unicode = new StringSHA1();
	unicode.update('A\ud83d');
	unicode.update('\ude00Z');
	assert.equal(unicode.digest(), 'd09c03a66166d48ed77d6a150a8b3517322f7908');
	assert.throws(() => unicode.update('late'), ReferenceError);
});
