import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { createSshRemoteWorkspaceUri } from '../../../../platform/remote/common/remote.js';
import { EditorResourceAccessor, SideBySideEditor, isResourceDiffEditorInput } from '../../../common/editor.js';
import { createBinaryDiffEditorInput, createDiffEditorInput, isBinaryDiffEditorInput, isDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';

suite('Comparison editor inputs', () => {
	for (const [kind, createInput, matches] of [
		['text', createDiffEditorInput, isDiffEditorInput],
		['binary', createBinaryDiffEditorInput, isBinaryDiffEditorInput],
	] as const) {
		test(`${kind} comparisons expose file sides while retaining their tab identity`, () => {
			const original = { resource: createSshRemoteWorkspaceUri('build', '/project/before.bin') };
			const modified = { resource: URI.file('/project/after.bin') };
			const input = createInput(original, modified);
			const identity = input.resource;
			assert.deepEqual([
				EditorResourceAccessor.getOriginalUri(input),
				EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY }),
				EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.SECONDARY }),
				EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.BOTH }),
				EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.BOTH, filterByScheme: Schemas.file }),
				EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.ANY, filterByScheme: [Schemas.ashRemote] }),
			], [
				undefined,
				modified.resource,
				original.resource,
				{ primary: modified.resource, secondary: original.resource },
				{ primary: modified.resource, secondary: undefined },
				original.resource,
			]);
			assert.strictEqual(input.resource, identity);
		});

		test(`${kind} comparisons restore both resources using only the common input owner`, () => {
			const input = createInput(
				{ resource: createSshRemoteWorkspaceUri('build', '/project/before.bin'), label: 'Before' },
				{ resource: URI.file('/project/after.bin'), label: 'After', readOnly: true },
				'Review bytes',
			);
			const serialized = EditorInputSerializers.serialize(input);
			const restored = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(serialized)));
			assert.ok(matches(restored));
			assert.deepEqual(EditorInputSerializers.serialize(restored), serialized);
			assert.deepEqual(EditorResourceAccessor.getOriginalUri(restored, { supportSideBySide: SideBySideEditor.BOTH }), {
				primary: input.modified.resource,
				secondary: input.original.resource,
			});
		});
	}

	test('nested comparisons resolve the requested leaf instead of a synthetic comparison resource', () => {
		const before = { resource: URI.file('/project/before.bin') };
		const after = { resource: URI.file('/project/after.bin') };
		const binary = createBinaryDiffEditorInput(before, after);
		const input = createDiffEditorInput(binary, { resource: URI.parse('git-change:/project/current.bin') });
		assert.deepEqual([
			EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.BOTH }),
			EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.ANY, filterByScheme: Schemas.file }),
		], [
			{ primary: input.modified.resource, secondary: after.resource },
			after.resource,
		]);
	});

	test('resource-shaped fields alone do not identify a comparison input', () => {
		const input = { resource: URI.file('/project/file.bin') };
		assert.deepEqual([
			isResourceDiffEditorInput(input),
			isResourceDiffEditorInput({ original: input }),
			isResourceDiffEditorInput({ original: input, modified: { resource: 'file:///project/after.bin' } }),
			isResourceDiffEditorInput(null),
		], [false, false, false, false]);
	});
});
