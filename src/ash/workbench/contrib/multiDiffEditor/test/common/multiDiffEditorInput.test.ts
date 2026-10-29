import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { createMultiDiffEditorInput, isMultiDiffEditorInput, matchMultiDiffEditor, multiDiffEditorItemKey, MULTI_DIFF_EDITOR_ID } from '../../browser/multiDiffEditorInput.js';

test('Stanza multi-diff inputs keep one caller-owned tab identity and ordered comparisons', () => {
	const source = URI.parse('ash-multi-diff:/scm/working?revision=7');
	const firstFile = { resource: URI.parse('file:///workspace/src/first.ts'), label: 'first.ts' };
	const input = createMultiDiffEditorInput(
		source,
		[
			{
				label: 'src/first.ts',
				original: { resource: URI.parse('git-change:/first/original'), label: 'first.ts (Index)' },
				modified: { resource: URI.parse('git-change:/first/modified'), label: 'first.ts (Working Tree)' },
				goToFile: firstFile,
			},
			{
				label: 'src/second.ts',
				original: { resource: URI.parse('git-change:/second/original'), label: 'second.ts (Index)' },
				modified: { resource: URI.parse('git-change:/second/modified'), label: 'second.ts (Working Tree)' },
			},
		],
		'Changes',
	);

	assert.equal(MULTI_DIFF_EDITOR_ID, 'stanza.editor.multiDiff');
	assert.equal(input.resource, source);
	assert.equal(input.readOnly, false);
	assert.deepEqual(
		input.items.map(item => item.label),
		['src/first.ts', 'src/second.ts'],
	);
	assert.equal(input.items[0]!.goToFile, firstFile);
	assert.equal(input.items[1]!.goToFile, undefined);
	assert.equal(matchMultiDiffEditor(input), EditorPaneMatch.Default);
});

test('Stanza multi-diff inputs reject duplicate comparisons', () => {
	const item = {
		label: 'src/first.ts',
		original: { resource: URI.parse('git-change:/first/original') },
		modified: { resource: URI.parse('git-change:/first/modified') },
	};
	assert.throws(() => createMultiDiffEditorInput(URI.parse('ash-multi-diff:/duplicates'), [item, item], 'Changes'), /Duplicate multi-diff comparison/);
});

test('Source-provided identities survive revisions while captured comparisons stay distinct', () => {
	const first = {
		id: 'repo:file.ts',
		label: 'file.ts',
		original: { resource: URI.parse('git-change:/file.ts?revision=1&side=original') },
		modified: { resource: URI.parse('git-change:/file.ts?revision=1&side=modified') },
	};
	const second = { ...first, modified: { resource: URI.parse('git-change:/file.ts?revision=2&side=modified') } };
	assert.equal(multiDiffEditorItemKey(first), multiDiffEditorItemKey(second));
	const capturedFirst = { ...first, id: undefined };
	const capturedSecond = { ...second, id: undefined };
	assert.notEqual(multiDiffEditorItemKey(capturedFirst), multiDiffEditorItemKey(capturedSecond));
	assert.equal(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/snapshot'), [capturedFirst, capturedSecond], 'Comparisons').items.length, 2);
});

test('binary metadata survives serialization and never makes a comparison writable', () => {
	const binary = {
		label: 'image.bin',
		binary: true,
		original: { resource: URI.parse('snapshot:/image.bin') },
		modified: { resource: URI.file('/workspace/image.bin') },
	};
	const input = createMultiDiffEditorInput(URI.parse('ash-multi-diff:/binary'), [binary], 'Binary review');
	const restored = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input))));
	assert.ok(isMultiDiffEditorInput(restored));
	assert.deepEqual([restored.readOnly, restored.items[0].binary, restored.items[0].modified.resource.toString()], [true, true, binary.modified.resource.toString()]);
	assert.throws(() => createMultiDiffEditorInput(input.resource, [{ ...binary, binary: 'yes' as unknown as boolean }], input.label), /binary state must be boolean/);
});

test('restored comparisons retain disabled file capabilities and reject corrupted context values', () => {
	const input = createMultiDiffEditorInput(
		URI.parse('ash-multi-diff:/capture'),
		[
			{
				label: 'file.ts',
				original: { resource: URI.parse('snapshot:/before') },
				modified: { resource: URI.parse('snapshot:/after') },
				contextKeys: { 'sessions.changesCanPreview': false },
			},
		],
		'Capture',
	);
	const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
	const restored = EditorInputSerializers.deserialize(serialized);
	assert.ok(isMultiDiffEditorInput(restored));
	assert.deepEqual(restored.items[0]!.contextKeys, { 'sessions.changesCanPreview': false });
	serialized.value.items[0].contextKeys['sessions.changesCanPreview'] = 'true';
	assert.throws(() => EditorInputSerializers.deserialize(serialized), /Invalid multi-diff context keys/u);
});
