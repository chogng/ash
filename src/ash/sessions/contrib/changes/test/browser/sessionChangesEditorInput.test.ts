import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditorInputSerializers } from '../../../../../workbench/services/editor/common/editorInputSerializer.js';
import type { ISessionChangeset } from '../../../../services/sessions/common/session.js';
import { SessionChangesEditorInput } from '../../browser/sessionChangesEditorInput.js';

suite('Session Changes editor restoration', () => {
	test('restores the capture choice and opaque conversation identity through JSON', () => {
		const resource = URI.from({
			scheme: 'ash-session',
			path: '/session #1',
			query: new URLSearchParams({ thread: 'thread&peer=2' }).toString(),
		});
		const input = new SessionChangesEditorInput(resource, { kind: 'id', id: 'capture #2' });
		const restored = EditorInputSerializers.deserialize(
			JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input))),
		);
		assert.ok(restored instanceof SessionChangesEditorInput);
		assert.equal(restored.resource.toString(), input.resource.toString());
		assert.equal(restored.sessionResource.toString(), resource.toString());
		assert.deepEqual(restored.changesetSelection, { kind: 'id', id: 'capture #2' });
	});

	test('persists a transient selection as its backing capture rather than resolved state or operations', () => {
		const changeset: ISessionChangeset = {
			id: 'capture',
			label: 'Temporary comparison',
			isEnabled: constObservable(true),
			isDefault: constObservable(false),
			isLoadingChanges: constObservable(false),
			changes: constObservable([]),
			operations: constObservable([]),
			originalCheckpointRef: constObservable(undefined),
			modifiedCheckpointRef: constObservable(undefined),
			invokeOperation: async () => {
				throw new Error('Restoration must not invoke operations');
			},
		};
		const input = new SessionChangesEditorInput(URI.parse('ash-session:/session?thread=thread'), {
			kind: 'transient',
			changeset,
		});
		const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
		assert.deepEqual(serialized.value, {
			resource: 'ash-session-changes:/session?thread=thread',
			changesetId: 'capture',
		});
		const restored = EditorInputSerializers.deserialize(serialized);
		assert.ok(restored instanceof SessionChangesEditorInput);
		assert.deepEqual(restored.changesetSelection, { kind: 'id', id: 'capture' });
	});

	test('rejects corrupted persisted choices and resources at the restoration boundary', () => {
		const input = new SessionChangesEditorInput(URI.parse('ash-session:/session?thread=thread'));
		const serialized = EditorInputSerializers.serialize(input);
		for (const changesetId of [0, '', {}, null]) {
			assert.throws(
				() =>
					EditorInputSerializers.deserialize({
						...serialized,
						value: { resource: input.resource.toString(), changesetId },
					}),
				TypeError,
			);
		}
		assert.throws(
			() =>
				EditorInputSerializers.deserialize({
					...serialized,
					value: { resource: 'file:/session', changesetId: 'capture' },
				}),
			TypeError,
		);
	});
});
