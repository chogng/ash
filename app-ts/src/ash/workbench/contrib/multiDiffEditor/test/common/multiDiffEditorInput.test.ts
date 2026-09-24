import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { createMultiDiffEditorInput, matchMultiDiffEditor, MULTI_DIFF_EDITOR_ID } from '../../browser/multiDiffEditorInput.js';

test('Stanza multi-diff inputs keep one caller-owned tab identity and ordered comparisons', () => {
	const source = URI.parse('ash-multi-diff:/scm/working?revision=7');
	const firstFile = { resource: URI.parse('file:///workspace/src/first.ts'), label: 'first.ts' };
	const input = createMultiDiffEditorInput(source, [
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
	], 'Changes');

	assert.equal(MULTI_DIFF_EDITOR_ID, 'stanza.editor.multiDiff');
	assert.equal(input.resource, source);
	assert.equal(input.readOnly, true);
	assert.deepEqual(input.items.map((item) => item.label), ['src/first.ts', 'src/second.ts']);
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
	assert.throws(
		() => createMultiDiffEditorInput(URI.parse('ash-multi-diff:/duplicates'), [item, item], 'Changes'),
		/Duplicate multi-diff comparison/,
	);
});
