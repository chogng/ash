import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { isValidBasename } from '../../common/extpath.js';

suite('isValidBasename', () => {
	test('rejects path components and NUL on every filesystem', () => {
		for (const name of [undefined, null, '', '.', '..', 'child/file', 'file\0name']) {
			assert.deepEqual([isValidBasename(name, false), isValidBasename(name, true)], [false, false], String(name));
		}
	});

	test('Windows refuses device aliases, forbidden characters and lossy suffixes', () => {
		const names = ['CON', 'con.txt', 'AUX.md', 'PRN', 'NUL.tar.gz', 'COM0', 'COM9.txt', 'LPT1', 'LPT².txt', 'CON .txt', 'a\\b', 'a:b', 'a?b', 'a*b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\n', 'name.', 'name '];
		assert.deepEqual(names.filter(name => isValidBasename(name, true)), []);
		assert.deepEqual(['console', 'auxiliary.txt', 'COM10', 'LPT00', '.gitignore', 'file %中.txt'].filter(name => !isValidBasename(name, true)), []);
	});

	test('POSIX preserves backslashes, device-like names, colons and trailing spaces', () => {
		const names = ['dir\\name.txt', 'CON', 'COM1.txt', 'a:b', 'name.', 'name ', '.gitignore', 'file %中.txt'];
		assert.deepEqual(names.filter(name => !isValidBasename(name, false)), []);
	});
});
