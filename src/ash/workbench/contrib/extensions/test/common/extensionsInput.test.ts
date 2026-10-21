import assert from 'node:assert/strict';
import { test } from 'mocha';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { ExtensionsInput, ExtensionsCapabilityInput } from '../../common/extensionsInput.js';

test('Extensions tabs restore the selected installation without persisting capability authority', () => {
	const summary = { id: 'demo@vendor', version: '1.2.3', displayName: 'Demo', description: 'A skill bundle', packageType: 'plugin' };
	using input = new ExtensionsInput(summary, 'installation-one');
	const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
	assert.deepEqual(serialized, { typeId: input.typeId, value: { ...summary, installationId: 'installation-one', source: 'registry' } });
	using restored = EditorInputSerializers.deserialize(serialized) as ExtensionsInput;
	assert.ok(restored instanceof ExtensionsInput);
	assert.ok(input.matches(restored));
	assert.deepEqual(restored.summary, summary);
	assert.equal(restored.installationId, 'installation-one');
	assert.equal(restored.readOnly, true);
	using otherVersion = new ExtensionsInput({ ...summary, version: '2.0.0' }, 'installation-two');
	assert.equal(restored.matches(otherVersion), false);
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: input.typeId, value: { ...summary, installationId: 12 } }), TypeError);
});

test('Extensions restores built-in and local sources separately and accepts older registry tabs', () => {
	const summary = { id: 'ash.demo', version: '1.0.0', displayName: 'Demo', description: '', packageType: 'editorExtension' };
	for (const source of ['builtIn', 'local']) {
		using restored = EditorInputSerializers.deserialize({ typeId: 'ash.extensions.input', value: { ...summary, source } }) as ExtensionsInput;
		assert.equal(restored.source, source);
		assert.equal(restored.resource.path, `/${source}/ash.demo`);
		assert.equal(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(restored))).value.source, source);
	}
	using legacy = EditorInputSerializers.deserialize({ typeId: 'ash.extensions.input', value: summary }) as ExtensionsInput;
	assert.equal(legacy.source, 'registry');
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: 'ash.extensions.input', value: { ...summary, source: 'untrusted' } }), TypeError);
});

test('Capability tabs restore Skill, Connector and MCP identities without catalog state', () => {
	for (const target of [
		{ kind: 'skill' as const, source: 'workspace:review', name: 'review', sessionId: 'session-one' },
		{ kind: 'mcp' as const, serverId: 'fixture-server', installationId: 'installation-one', capabilityId: 'capability-one' },
		{ kind: 'connector' as const, connectorId: 'github-account' },
	]) {
		using input = new ExtensionsCapabilityInput(target);
		const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
		assert.deepEqual(serialized.value, target);
		using restored = EditorInputSerializers.deserialize(serialized) as ExtensionsCapabilityInput;
		assert.deepEqual(restored.target, target);
		assert.ok(input.matches(restored));
	}
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: 'ash.extensions.capabilityInput', value: { kind: 'skill', name: 'review', source: 12 } }), TypeError);
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: 'ash.extensions.capabilityInput', value: { kind: 'connector', connectorId: 12 } }), TypeError);
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: 'ash.extensions.capabilityInput', value: { kind: 'other' } }), TypeError);
});
