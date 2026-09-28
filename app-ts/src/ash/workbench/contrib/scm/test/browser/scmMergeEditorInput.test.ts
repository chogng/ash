import assert from 'node:assert/strict';
import { test } from 'mocha';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import type { GitStatus } from '../../../../contrib/git/common/gitService.js';
import { createScmMergeEditorInput, isScmMergeEditorInput, matchScmMergeEditor } from '../../browser/scmMergeEditorInput.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';

test('merge editor input keeps its result file and repository across restore', () => {
	const status: GitStatus = {
		repositoryId: 'repo-1',
		streamInstanceId: 'stream-1',
		revision: 1,
		workspacePath: '/workspace',
		head: { type: 'branch', name: 'main', objectId: '1234', upstream: undefined },
		changes: [],
	};
	const input = createScmMergeEditorInput(status, 'src/main.ts');
	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input));
	assert.equal(isScmMergeEditorInput(restored), true);
	assert.equal(matchScmMergeEditor(restored), EditorPaneMatch.Default);
	if (!isScmMergeEditorInput(restored)) throw new Error('Merge editor input was not restored');
	assert.equal(restored.repositoryId, 'repo-1');
	assert.equal(restored.path, 'src/main.ts');
	assert.equal(restored.resultResource.toString(), 'file:///workspace/src/main.ts');
});
