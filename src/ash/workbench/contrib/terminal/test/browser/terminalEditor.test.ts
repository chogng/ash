import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { TerminalEditorInput } from '../../browser/terminalEditorInput.js';
import { TerminalInputSerializer } from '../../browser/terminalEditorSerializer.js';
import { getTerminalUri, parseTerminalUri, getInstanceFromResource } from '../../browser/terminalUri.js';
import { EditorInputSerializerRegistry } from '../../../../services/editor/common/editorInputSerializer.js';

suite('Terminal editor resource boundary', () => {
	test('working sets persist only identity, not executable configuration', () => {
		const registry = new EditorInputSerializerRegistry();
		using registration = registry.register(new TerminalInputSerializer());
		const resource = getTerminalUri('session-one', 3, 'Shell');
		const saved = registry.serialize(new TerminalEditorInput(resource));
		assert.deepEqual(saved.value, { resource: resource.toString() });
		const restored = registry.deserialize(saved);
		assert.ok(restored instanceof TerminalEditorInput);
		assert.equal(restored.label, 'Shell');
		assert.equal(restored.terminalInstance, undefined);
	});

	test('incarnations with a reused instance number cannot bind an old resource', () => {
		const instance = { resource: getTerminalUri('current-session', 1, 'New') };
		assert.equal(getInstanceFromResource([instance], getTerminalUri('old-session', 1)), undefined);
		assert.equal(getInstanceFromResource([instance], instance.resource.with({ fragment: 'Old label', query: 'command' })), instance);
	});

	test('rejects forged resource schemes, authorities, IDs and persistence values', () => {
		for (const value of ['file:/session/1', 'vscode-terminal://host/session/1', 'vscode-terminal:/session/0', 'vscode-terminal:/session/1x', 'vscode-terminal:/session/9007199254740992', 'vscode-terminal:/session/1/extra']) {
			assert.throws(() => parseTerminalUri(URI.parse(value)), TypeError);
		}
		const serializer = new TerminalInputSerializer();
		for (const value of [null, [], {}, { resource: 3 }, { resource: 'file:/session/1' }]) assert.throws(() => serializer.deserialize(value), TypeError);
	});
});
