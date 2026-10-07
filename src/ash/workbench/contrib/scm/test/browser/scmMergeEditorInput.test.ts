import assert from 'node:assert/strict';
import { test } from 'mocha';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { createScmMergeEditorInput, isScmMergeEditorInput, matchScmMergeEditor } from '../../browser/scmMergeEditorInput.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { URI } from '../../../../../base/common/uri.js';

test('merge editor input keeps its result file and repository across restore', () => {
	const input = createScmMergeEditorInput('repo-1', 'src/main.ts', URI.parse('git-merge:/repo-1/src/main.ts'), URI.file('/workspace/src/main.ts'));
	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input));
	assert.equal(isScmMergeEditorInput(restored), true);
	assert.equal(matchScmMergeEditor(restored), EditorPaneMatch.Default);
	if (!isScmMergeEditorInput(restored)) throw new Error('Merge editor input was not restored');
	assert.equal(restored.repositoryId, 'repo-1');
	assert.equal(restored.path, 'src/main.ts');
	assert.equal(restored.resultResource.toString(), 'file:///workspace/src/main.ts');
});
