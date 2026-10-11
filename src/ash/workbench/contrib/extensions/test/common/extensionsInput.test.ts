import assert from 'node:assert/strict';
import { test } from 'mocha';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { ExtensionsInput } from '../../common/extensionsInput.js';

test('Extensions tabs restore the selected installation without persisting capability authority', () => {
	const summary = { id: 'demo@vendor', version: '1.2.3', displayName: 'Demo', description: 'A skill bundle', packageType: 'plugin' };
	using input = new ExtensionsInput(summary, 'installation-one');
	const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
	assert.deepEqual(serialized, { typeId: input.typeId, value: { ...summary, installationId: 'installation-one' } });
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
