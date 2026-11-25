import assert from 'node:assert/strict';
import { test } from 'mocha';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { createScmMergeEditorInput, isScmMergeEditorInput, matchScmMergeEditor } from '../../browser/scmMergeEditorInput.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { URI } from '../../../../../base/common/uri.js';
import { parseExtensionEditorInput } from '../../../../api/browser/mainThreadEditorInput.js';

test('merge editor input keeps its result file and repository across restore', () => {
	const input = createScmMergeEditorInput('repo-1', 'src/main.ts', URI.file('/workspace/src/main.ts'));
	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input));
	assert.equal(isScmMergeEditorInput(restored), true);
	assert.equal(matchScmMergeEditor(restored), EditorPaneMatch.Default);
	if (!isScmMergeEditorInput(restored)) throw new Error('Merge editor input was not restored');
	assert.equal(restored.repositoryId, 'repo-1');
	assert.equal(restored.path, 'src/main.ts');
	assert.equal(restored.resultResource.toString(), 'file:///workspace/src/main.ts');
});

test('Git merge inputs share an editor identity for paths with URI delimiters', () => {
	const path = 'src/report#100%.ts';
	const result = URI.file(`/workspace/${path}`);
	const fromScm = parseExtensionEditorInput({ kind: 'merge', repositoryId: 'repo-1', path, resource: `git-merge:/repo-1/${path}`, resultResource: result.toString() });
	const fromPalette = createScmMergeEditorInput('repo-1', path, result);
	assert.equal(fromPalette.resource.path, `/repo-1/${path}`);
	assert.equal(fromPalette.resource.fragment, '');
	assert.equal(fromScm.resource.toString(), fromPalette.resource.toString());
});
