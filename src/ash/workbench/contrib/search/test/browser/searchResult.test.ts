import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import type { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { SearchResultImpl } from '../../browser/searchTreeModel/searchResult.js';

test('Search results keep same-path files in different roots and every occurrence in one line', () => {
	const folders: IWorkspaceFolder[] = [
		{ id: 'first', name: 'first', index: 0, uri: URI.file('/first') },
		{ id: 'second', name: 'second', index: 1, uri: URI.parse('ssh://host/second') },
	];
	const result = new SearchResultImpl(folders);
	const line = { path: 'src/中文.ts', lineNumber: 3, preview: '中文😀 needle needle', ranges: [{ start: 5, end: 11 }, { start: 12, end: 18 }] };
	result.add([{ ...line, dirId: 'first' }, { ...line, dirId: 'second' }]);
	result.add([{ ...line, dirId: 'first' }]);
	assert.equal(result.count, 4);
	assert.deepEqual(result.files.map(file => ({ resource: file.resource.toString(), name: file.name, ranges: file.matches.map(match => ({ ...match.range })) })), [
		{
			resource: URI.file('/first/src/中文.ts').toString(), name: '中文.ts', ranges: [
				{ startLineNumber: 3, startColumn: 6, endLineNumber: 3, endColumn: 12 },
				{ startLineNumber: 3, startColumn: 13, endLineNumber: 3, endColumn: 19 },
			]
		},
		{
			resource: URI.parse('ssh://host/second/src/中文.ts').toString(), name: '中文.ts', ranges: [
				{ startLineNumber: 3, startColumn: 6, endLineNumber: 3, endColumn: 12 },
				{ startLineNumber: 3, startColumn: 13, endLineNumber: 3, endColumn: 19 },
			]
		},
	]);
	assert.deepEqual(result.children.map(folder => ({ name: folder.name, children: [...folder.children.values()].map(child => child.name) })), [
		{ name: 'first', children: ['src'] }, { name: 'second', children: ['src'] },
	]);
	result.clear();
	assert.deepEqual({ count: result.count, children: result.children, files: result.files }, { count: 0, children: [], files: [] });
});

test('Search results require a root identity even for a single workspace folder', () => {
	const folders = [
		{ id: 'first', name: 'first', index: 0, uri: URI.file('/first') },
		{ id: 'second', name: 'second', index: 1, uri: URI.file('/second') },
	];
	for (const workspaceFolders of [folders.slice(0, 1), folders]) {
		const result = new SearchResultImpl(workspaceFolders);
		assert.throws(() => result.add([{ path: 'main.ts', lineNumber: 1, preview: 'needle', ranges: [{ start: 0, end: 6 }] }]), /workspace folder/);
	}
});

test('Search results map UTF-16 offsets in a CRLF preview block to an editor range across lines', () => {
	const result = new SearchResultImpl([{ id: 'workspace', name: 'workspace', index: 0, uri: URI.file('/workspace') }]);
	result.add([{ dirId: 'workspace', path: 'main.ts', lineNumber: 4, preview: '中文😀 first\r\nsecond end', ranges: [{ start: 5, end: 18 }] }]);
	assert.deepEqual({ ...result.files[0]!.matches[0]!.range }, { startLineNumber: 4, startColumn: 6, endLineNumber: 5, endColumn: 7 });
});

test('Dismiss removes mixed levels once, keeps other roots and prunes empty branches', () => {
	const result = new SearchResultImpl([
		{ id: 'first', name: 'first', index: 0, uri: URI.file('/first') },
		{ id: 'second', name: 'second', index: 1, uri: URI.file('/second') },
	]);
	const line = { lineNumber: 1, preview: 'needle needle', ranges: [{ start: 0, end: 6 }, { start: 7, end: 13 }] };
	result.add([
		{ ...line, dirId: 'first', path: 'src/a.ts' },
		{ ...line, ranges: line.ranges.slice(0, 1), dirId: 'first', path: 'src/nested/b.ts' },
		{ ...line, dirId: 'first', path: 'docs/c.ts' },
		{ ...line, ranges: line.ranges.slice(0, 1), dirId: 'first', path: 'keep.ts' },
		{ ...line, ranges: line.ranges.slice(0, 1), dirId: 'second', path: 'src/a.ts' },
	]);
	const folder = [...result.children[0]!.children.values()].find(child => child.name === 'src')!;
	const firstFile = result.files[0]!;
	const docs = result.files[2]!;
	const selected = [folder, firstFile, firstFile.matches[0]!, docs.matches[0]!, result.files[4]!, folder];
	result.batchRemove(selected);
	result.batchRemove(selected);
	assert.deepEqual({ count: result.count, files: result.files.map(file => [file.resource.toString(), file.matches.length]), roots: result.children.map(root => root.name) }, {
		count: 2,
		files: [[URI.file('/first/docs/c.ts').toString(), 1], [URI.file('/first/keep.ts').toString(), 1]],
		roots: ['first'],
	});
	result.batchRemove([docs.matches[0]!]);
	assert.deepEqual([...result.children[0]!.children.values()].map(child => child.name), ['keep.ts']);
	result.batchRemove([...result.children]);
	assert.deepEqual({ count: result.count, files: result.files, children: result.children }, { count: 0, files: [], children: [] });
});

test('Later search batches can restore dismissed matches and stale selections cannot remove them', () => {
	const result = new SearchResultImpl([{ id: 'workspace', name: 'workspace', index: 0, uri: URI.file('/workspace') }]);
	const raw = { dirId: 'workspace', path: 'src/main.ts', lineNumber: 1, preview: 'needle', ranges: [{ start: 0, end: 6 }] };
	result.add([raw]);
	const folder = result.children[0]!;
	const file = result.files[0]!;
	const match = file.matches[0]!;
	result.batchRemove([match]);
	result.add([raw, { ...raw, lineNumber: 2 }]);
	result.batchRemove([folder, file, match]);
	assert.deepEqual({ count: result.count, lines: result.files[0]!.matches.map(match => match.range.startLineNumber) }, { count: 2, lines: [1, 2] });
});
