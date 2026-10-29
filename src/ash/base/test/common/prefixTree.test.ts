import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { WellDefinedPrefixTree } from '../../common/prefixTree.js';

suite('WellDefinedPrefixTree', () => {
	test('distinguishes explicit ancestors, implicit ancestors and unrelated segments', () => {
		const tree = new WellDefinedPrefixTree<boolean>();
		tree.insert(['editor', 'options', 'colors'], false);
		tree.insert(['editorial', 'enabled'], true);
		const keys = [
			['editor'],
			['editor', 'options'],
			['editor', 'options', 'colors'],
			['editor', 'options', 'colors', 'foreground'],
			['editor', 'option'],
			['editorial'],
			['editorial', 'enabled'],
			['editorials'],
		];
		assert.deepEqual(
			keys.map(key => [tree.hasKeyOrParent(key), tree.hasKeyOrChildren(key)]),
			[
				[false, true],
				[false, true],
				[true, true],
				[true, false],
				[false, false],
				[false, true],
				[true, true],
				[false, false],
			],
		);
	});

	test('accepts single-pass paths and replaces values without losing descendants', () => {
		const tree = new WellDefinedPrefixTree<number | undefined>();
		tree.insert(['settings', 'color'].values(), 1);
		tree.insert(['settings'].values(), undefined);
		tree.insert(['settings'].values(), 0);
		assert.equal(tree.hasKeyOrParent(['settings', 'font'].values()), true);
		assert.equal(tree.hasKeyOrChildren(['settings', 'color'].values()), true);
		assert.equal(tree.hasKeyOrChildren(['settings', 'font'].values()), false);
	});

	test('keeps empty segments and case-sensitive keys distinct', () => {
		const tree = new WellDefinedPrefixTree<undefined>();
		assert.equal(tree.hasKeyOrParent(['']), false);
		assert.equal(tree.hasKeyOrChildren(['']), false);
		tree.insert(['editor', '', 'color'], undefined);
		tree.insert(['Editor', 'color'], undefined);
		assert.equal(tree.hasKeyOrChildren(['editor', '']), true);
		assert.equal(tree.hasKeyOrChildren(['editor', 'color']), false);
		assert.equal(tree.hasKeyOrParent(['editor', '', 'color', 'red']), true);
		assert.equal(tree.hasKeyOrParent(['editor', 'color']), false);
		assert.equal(tree.hasKeyOrParent(['Editor', 'color']), true);
		assert.equal(tree.hasKeyOrParent(['EDITOR', 'color']), false);
	});
});
