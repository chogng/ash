import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ResourceTree } from '../../common/resourceTree.js';
import { extUriIgnorePathCase } from '../../common/resources.js';
import { URI } from '../../common/uri.js';

suite('ResourceTree', () => {
	test('indexes drive paths from the default root', () => {
		const tree = new ResourceTree<string, undefined>(undefined);
		const file = URI.file('C:/folder/file.txt');
		tree.add(file, 'file');
		assert.equal(tree.getNode(file)!.element, 'file');
		assert.equal(tree.root.get('C:')!.get('folder')!.get('file.txt')!.element, 'file');
		assert.equal(tree.delete(file), 'file');
		assert.equal(tree.root.childrenCount, 0);
	});
	test('shares path ancestors and replaces only the resource data', () => {
		const context = { id: 1 };
		const root = URI.parse('test://host/root');
		const tree = new ResourceTree<string, typeof context>(context, root);
		const first = URI.joinPath(root, 'one/first.txt');
		tree.add(first, 'first');
		tree.add(URI.joinPath(root, 'one/second.txt'), 'second');
		const node = tree.getNode(first)!;
		tree.add(first, 'updated');
		assert.equal(tree.getNode(first), node);
		assert.deepEqual({ count: tree.root.childrenCount, name: node.name, path: node.relativePath, context: node.context, values: ResourceTree.collect(tree.root) }, {
			count: 1, name: 'first.txt', path: '/one/first.txt', context, values: ['updated', 'second'],
		});
		assert.equal(tree.root.get('one')!.get('first.txt'), node);
		assert.equal(ResourceTree.getRoot(node), tree.root);
		assert.equal(ResourceTree.isResourceNode(node), true);
		assert.equal(ResourceTree.isResourceNode({ uri: first }), false);
	});

	test('removes subtrees and prunes only ancestors without data', () => {
		const root = URI.parse('test://host/root');
		const tree = new ResourceTree<string, undefined>(undefined, root);
		const folder = URI.joinPath(root, 'folder');
		const file = URI.joinPath(folder, 'nested/file');
		tree.add(folder, 'folder data');
		tree.add(file, 'file');
		assert.equal(tree.delete(file), 'file');
		assert.deepEqual(ResourceTree.collect(tree.root), ['folder data']);
		assert.equal(tree.getNode(folder)!.childrenCount, 0);
		tree.add(file, 'replacement');
		assert.equal(tree.delete(folder), 'folder data');
		assert.deepEqual([tree.root.childrenCount, tree.getNode(file), tree.delete(file)], [0, undefined, undefined]);
	});

	test('deleting an implicit directory removes its descendants', () => {
		const root = URI.parse('test://host/root');
		const tree = new ResourceTree<string, undefined>(undefined, root);
		tree.add(URI.joinPath(root, 'one/two/file'), 'file');
		assert.equal(tree.delete(URI.joinPath(root, 'one/two')), undefined);
		assert.equal(tree.root.childrenCount, 0);
	});

	test('uses exact URI components to enforce the tree boundary', () => {
		const root = URI.parse('test://host/root?revision=1#part');
		const tree = new ResourceTree<number, undefined>(undefined, root);
		const file = URI.joinPath(root, 'file');
		tree.add(file, 0);
		for (const outside of [file.with({ scheme: 'other' }), file.with({ authority: 'elsewhere' }), file.with({ query: 'revision=2' }), file.with({ fragment: 'other' }), file.with({ path: '/roots/file' })]) {
			assert.throws(() => tree.add(outside, 1), RangeError);
			assert.equal(tree.getNode(outside), undefined);
			assert.equal(tree.delete(outside), undefined);
		}
		assert.deepEqual(ResourceTree.collect(tree.root), [0]);
	});

	test('keeps escaped separators inside a single child name', () => {
		const root = URI.parse('test://host/root');
		const tree = new ResourceTree<string, undefined>(undefined, root);
		const encoded = URI.parse('test://host/root/a%2Fb');
		tree.add(encoded, 'encoded');
		tree.add(URI.joinPath(root, 'a/b'), 'nested');
		assert.equal(tree.root.get('a/b')!.element, 'encoded');
		assert.equal(tree.root.get('a')!.get('b')!.element, 'nested');
		assert.equal(tree.getNode(encoded)!.name, 'a/b');
		assert.equal(tree.root.childrenCount, 2);
	});

	test('preserves case by default and honors caller-selected identity', () => {
		const root = URI.parse('test://host/root');
		const upper = URI.joinPath(root, 'Dir/File');
		const lower = URI.joinPath(root, 'dir/file');
		const sensitive = new ResourceTree<string, undefined>(undefined, root);
		sensitive.add(upper, 'upper');
		sensitive.add(lower, 'lower');
		assert.equal(sensitive.root.childrenCount, 2);
		const insensitive = new ResourceTree<string, undefined>(undefined, root, extUriIgnorePathCase);
		insensitive.add(upper, 'upper');
		insensitive.add(lower, 'lower');
		assert.equal(insensitive.root.childrenCount, 1);
		assert.equal(insensitive.root.get('DIR')!.get('FILE')!.element, 'lower');
		assert.equal(insensitive.delete(upper), 'lower');
		assert.equal(insensitive.root.childrenCount, 0);
	});

	test('clears root data and supports directory roots with trailing separators', () => {
		const root = URI.parse('test://host/root/');
		const tree = new ResourceTree<string, undefined>(undefined, root);
		tree.add(root, 'root');
		tree.add(URI.joinPath(root, 'file'), 'file');
		assert.deepEqual(ResourceTree.collect(tree.root), ['root', 'file']);
		tree.clear();
		assert.deepEqual(ResourceTree.collect(tree.root), []);
		assert.equal(tree.root.childrenCount, 0);
		tree.add(URI.joinPath(root, 'new/file'), 'new');
		assert.equal(tree.delete(root), undefined);
		assert.equal(tree.root.childrenCount, 0);
	});
});
