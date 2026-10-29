import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { TernarySearchTree } from '../../common/ternarySearchTree.js';
import { URI } from '../../common/uri.js';

suite('URI ancestor index', () => {
	test('finds nearest complete segments regardless of insertion order', () => {
		const index = TernarySearchTree.forUris<string>();
		for (const path of ['/work/z', '/work/a/b', '/other', '/work', '/']) index.set(URI.file(path), path);
		for (const [path, expected] of [['/work/a/b/file.ts', '/work/a/b'], ['/work/a/file.ts', '/work'], ['/work/zebra', '/work'], ['/elsewhere', '/'], ['/work/z', '/work/z']]) {
			assert.equal(index.findSubstr(URI.file(path!)), expected);
		}
		assert.equal(index.findSubstr(URI.parse('ash-remote://ssh+build/work/a/b')), undefined);
		assert.equal(index.set(URI.file('/work/a/b/'), 'replacement'), '/work/a/b');
		assert.equal(index.findSubstr(URI.file('/work/a/b/file.ts')), 'replacement');
	});

	test('keeps reserved separators and repeated separators inside their original boundaries', () => {
		const index = TernarySearchTree.forUris<string>();
		index.set(URI.parse('ash-remote://ssh+build/work/a%2Fb'), 'escaped');
		index.set(URI.parse('ash-remote://ssh+build/work/a/b'), 'nested');
		index.set(URI.parse('ash-remote://ssh+build/work/a//b'), 'repeated');
		index.set(URI.parse('ash-remote://ssh+build/work/a%5Cb'), 'backslash');
		for (const [path, expected] of [['a%2fb/file', 'escaped'], ['a/b/file', 'nested'], ['a//b/file', 'repeated'], ['a%5cb/file', 'backslash']]) {
			assert.equal(index.findSubstr(URI.parse(`ash-remote://ssh+build/work/${path}`)), expected);
		}
		assert.equal(index.findSubstr(URI.parse('ash-remote://ssh+other/work/a/b')), undefined);
	});

	test('uses per-resource casing and optionally ignores query and fragment', () => {
		const index = TernarySearchTree.forUris<string>(resource => resource.scheme === 'file', () => true);
		index.set(URI.parse('file:///C:/Work/%61'), 'local');
		index.set(URI.parse('ash-remote://ssh+BUILD/Work/a'), 'remote');
		assert.equal(index.findSubstr(URI.parse('file:///c:/WORK/A/file?preview#L2')), 'local');
		assert.equal(index.findSubstr(URI.parse('ash-remote://ssh+build/Work/a/file?preview#L2')), 'remote');
		assert.equal(index.findSubstr(URI.parse('ash-remote://ssh+build/work/a/file')), undefined);
		const decorated = TernarySearchTree.forUris<string>();
		decorated.set(URI.parse('custom:/work?view=one#L1'), 'first');
		decorated.set(URI.parse('custom:/work?view=two'), 'second');
		assert.equal(decorated.findSubstr(URI.parse('custom:/work?view=one#L1')), 'first');
		assert.equal(decorated.findSubstr(URI.parse('custom:/work?view=two#L1')), 'second');
		assert.equal(decorated.findSubstr(URI.parse('custom:/work?view=three')), undefined);
	});

	test('recognizes escaped unreserved spelling and keeps undefined values as matches', () => {
		const index = TernarySearchTree.forUris<number | undefined>();
		index.set(URI.parse('custom:/work'), 1);
		index.set(URI.parse('custom:/work/%61'), undefined);
		assert.equal(index.findSubstr(URI.parse('custom:/work/a/file')), undefined);
		assert.equal(index.set(URI.parse('custom:/work/a'), 0), undefined);
		assert.equal(index.findSubstr(URI.parse('custom:/work/%61/file')), 0);
	});
});
