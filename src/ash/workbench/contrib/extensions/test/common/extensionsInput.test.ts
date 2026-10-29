import assert from 'node:assert/strict';
import { test } from 'mocha';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { ExtensionsInput, ExtensionsCapabilityInput, ExtensionsInputSource } from '../../common/extensionsInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';

test('Extension tabs publish pane icon changes without persisting temporary image URLs', () => {
	const summary = {
		id: 'ash.bat',
		version: '1.0.0',
		displayName: 'Batch',
		description: '',
		packageType: 'editorExtension',
	};
	using input = new ExtensionsInput(summary, undefined, ExtensionsInputSource.BuiltIn);
	const fallback = input.getIcon();
	assert.ok(fallback instanceof URI);
	assert.equal(fallback.scheme, 'data');
	let changes = 0;
	using listener = input.onDidChangeLabel(() => {
		changes++;
	});
	const first = URI.parse('blob:first-icon');
	input.setIcon(first);
	assert.equal(input.getIcon(), first);
	const saved = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
	assert.equal(JSON.stringify(saved).includes('blob:'), false);
	using restored = EditorInputSerializers.deserialize(saved) as ExtensionsInput;
	assert.equal(restored.getIcon().toString(), fallback.toString());
	input.setIcon(URI.parse('blob:second-icon'));
	input.setIcon(undefined);
	assert.equal(input.getIcon(), fallback);
	input.setIcon(first);
	assert.equal(changes, 4);
	input.dispose();
	input.setIcon(undefined);
	assert.equal(changes, 4);
	using external = new ExtensionsInput(summary);
	assert.equal(external.getIcon(), Lxicon.extensions);
});

test('Extensions tabs restore the selected installation without persisting capability authority', () => {
	const summary = {
		id: 'demo@vendor',
		version: '1.2.3',
		displayName: 'Demo',
		description: 'A skill bundle',
		packageType: 'plugin',
	};
	using input = new ExtensionsInput(summary, 'installation-one');
	const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
	assert.deepEqual(serialized, {
		typeId: input.typeId,
		value: { ...summary, installationId: 'installation-one', source: 'registry' },
	});
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
	const summary = {
		id: 'ash.demo',
		version: '1.0.0',
		displayName: 'Demo',
		description: '',
		packageType: 'editorExtension',
	};
	for (const source of ['builtIn', 'local']) {
		using restored = EditorInputSerializers.deserialize({
			typeId: 'ash.extensions.input',
			value: { ...summary, source },
		}) as ExtensionsInput;
		assert.equal(restored.source, source);
		assert.equal(restored.resource.path, `/${source}/ash.demo`);
		assert.equal(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(restored))).value.source, source);
	}
	using legacy = EditorInputSerializers.deserialize({
		typeId: 'ash.extensions.input',
		value: summary,
	}) as ExtensionsInput;
	assert.equal(legacy.source, 'registry');
	assert.throws(
		() =>
			EditorInputSerializers.deserialize({
				typeId: 'ash.extensions.input',
				value: { ...summary, source: 'untrusted' },
			}),
		TypeError,
	);
});

test('Capability tabs restore Skill, Connector and MCP identities without catalog state', () => {
	for (const target of [
		{ kind: 'skill' as const, source: 'workspace:review', name: 'review', sessionId: 'session-one' },
		{
			kind: 'mcp' as const,
			serverId: 'fixture-server',
			installationId: 'installation-one',
			capabilityId: 'capability-one',
		},
		{ kind: 'connector' as const, connectorId: 'github-account' },
	]) {
		using input = new ExtensionsCapabilityInput(target);
		const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
		assert.deepEqual(serialized.value, target);
		using restored = EditorInputSerializers.deserialize(serialized) as ExtensionsCapabilityInput;
		assert.deepEqual(restored.target, target);
		assert.ok(input.matches(restored));
	}
	assert.throws(
		() =>
			EditorInputSerializers.deserialize({
				typeId: 'ash.extensions.capabilityInput',
				value: { kind: 'skill', name: 'review', source: 12 },
			}),
		TypeError,
	);
	assert.throws(
		() =>
			EditorInputSerializers.deserialize({
				typeId: 'ash.extensions.capabilityInput',
				value: { kind: 'connector', connectorId: 12 },
			}),
		TypeError,
	);
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: 'ash.extensions.capabilityInput', value: { kind: 'other' } }), TypeError);
});

test('legacy built-in Rust tabs restore and persist the Ash identity', () => {
	const summary = {
		id: 'vscode.rust',
		version: '10.0.0',
		displayName: 'rust',
		description: '',
		packageType: 'editorExtension',
	};
	const saved = { typeId: 'ash.extensions.input', value: { ...summary, source: 'builtIn' } };
	using restored = EditorInputSerializers.deserialize(saved) as ExtensionsInput;
	using current = new ExtensionsInput({ ...summary, id: 'ash.rust' }, undefined, ExtensionsInputSource.BuiltIn);
	assert.deepEqual(restored.summary, current.summary);
	assert.equal(restored.source, ExtensionsInputSource.BuiltIn);
	assert.equal(restored.resource.path, '/builtIn/ash.rust');
	assert.equal(restored.resource.query, '10.0.0');
	assert.ok(restored.matches(current));
	assert.equal(saved.value.id, 'vscode.rust');
	const migrated = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(restored)));
	assert.deepEqual(migrated, { typeId: saved.typeId, value: { ...summary, id: 'ash.rust', source: 'builtIn' } });
	using reopened = EditorInputSerializers.deserialize(migrated) as ExtensionsInput;
	assert.deepEqual(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(reopened))), migrated);
	assert.ok(reopened.matches(current));
});

test('Rust tab migration is restricted to the exact legacy built-in identity', () => {
	for (const [source, id] of [
		[undefined, 'vscode.rust'],
		['registry', 'vscode.rust'],
		['local', 'vscode.rust'],
		['builtIn', 'ash.rust'],
		['builtIn', 'vscode.rust-extra'],
		['builtIn', 'vscode.css'],
	]) {
		const value = {
			id,
			version: '1.0.0',
			displayName: 'Rust',
			description: '',
			packageType: 'editorExtension',
			source,
			installationId: 'installed-version',
		};
		using restored = EditorInputSerializers.deserialize({
			typeId: 'ash.extensions.input',
			value,
		}) as ExtensionsInput;
		assert.equal(restored.summary.id, id);
		assert.equal(restored.source, source ?? ExtensionsInputSource.Registry);
		assert.equal(restored.installationId, value.installationId);
	}
	assert.throws(
		() =>
			EditorInputSerializers.deserialize({
				typeId: 'ash.extensions.input',
				value: { id: 12, source: 'builtIn' },
			}),
		TypeError,
	);
});
