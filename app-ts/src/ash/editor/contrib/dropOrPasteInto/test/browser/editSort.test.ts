import assert from 'node:assert/strict';
import { test } from 'mocha';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { sortEditsByYieldTo } from '../../browser/edit.js';

interface Edit {
	readonly title: string;
	readonly kind: HierarchicalKind;
	readonly handledMimeType?: string;
	readonly yieldTo?: readonly ({ readonly kind: HierarchicalKind } | { readonly mimeType: string })[];
}

function edit(title: string, kind: string, yieldTo?: Edit['yieldTo'], handledMimeType?: string): Edit {
	return { title, kind: new HierarchicalKind(kind), yieldTo, handledMimeType };
}

test('yield preferences order a chain without changing unrelated candidates', () => {
	const edits = [
		edit('third', 'c', [{ kind: new HierarchicalKind('b') }]),
		edit('unrelated', 'x'),
		edit('second', 'b', [{ kind: new HierarchicalKind('a') }]),
		edit('first', 'a'),
	];
	assert.deepEqual(sortEditsByYieldTo(edits).map(item => item.title), ['first', 'second', 'third', 'unrelated']);
	assert.deepEqual(edits.map(item => item.title), ['third', 'unrelated', 'second', 'first']);
});

test('mime preferences and parent kinds target matching edits', () => {
	const edits = [
		edit('deferred', 'other', [{ mimeType: 'text/plain' }, { kind: new HierarchicalKind('uri') }]),
		edit('plain', 'text.plain', undefined, 'text/plain'),
		edit('path', 'uri.path.absolute', undefined, 'text/uri-list'),
	];
	assert.deepEqual(sortEditsByYieldTo(edits).map(item => item.title), ['plain', 'path', 'deferred']);
});

test('empty and cyclic preferences remain finite', () => {
	assert.deepEqual(sortEditsByYieldTo([]), []);
	const edits = [
		edit('a', 'a', [{ kind: new HierarchicalKind('b') }]),
		edit('b', 'b', [{ kind: new HierarchicalKind('a') }]),
	];
	assert.deepEqual(sortEditsByYieldTo(edits).map(item => item.title), ['a', 'b']);
});
