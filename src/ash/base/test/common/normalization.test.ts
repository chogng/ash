import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { normalizeNFC } from '../../common/normalization.js';

suite('Unicode normalization', () => {
	test('composes canonical equivalents and orders combining marks', () => {
		assert.equal(normalizeNFC('re\u0301sume\u0301.txt'), 'résumé.txt');
		assert.equal(normalizeNFC('\u1100\u1161\u11a8'), '각');
		assert.equal(normalizeNFC('a\u0301\u0323'), '\u1ea1\u0301');
	});

	test('preserves compatibility characters, case, whitespace and unrelated Unicode', () => {
		const text = '  Ａ Å ﬀ ① É 中文 🧑🏽‍💻  ';
		assert.equal(normalizeNFC(text), '  Ａ Å ﬀ ① É 中文 🧑🏽‍💻  ');
		assert.equal(normalizeNFC(''), '');
		assert.equal(normalizeNFC('\ud800'), '\ud800');
	});
});
