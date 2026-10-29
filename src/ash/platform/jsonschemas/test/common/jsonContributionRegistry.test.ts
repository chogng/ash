import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Extensions, type IJSONContributionRegistry } from '../../common/jsonContributionRegistry.js';
import { Registry } from '../../../registry/common/platform.js';

const registry = Registry.as<IJSONContributionRegistry>(Extensions.JSONContribution);

test('JSON contributions and their resource patterns have separate change notifications', () => {
	using store = new DisposableStore();
	const id = 'test://schema/settings';
	const changes: string[] = [];
	store.add(registry.onDidChangeSchema(uri => changes.push(uri)));
	store.add(registry.onDidChangeSchemaAssociations(() => changes.push('associations')));
	const schema = { type: 'object' as const, properties: { enabled: { type: 'boolean' as const } } };
	using contribution = new DisposableStore();
	registry.registerSchema(id + '#', schema, contribution);
	using association = registry.registerSchemaAssociation(id, '**/settings.json');
	assert.equal(registry.getSchemaContributions().schemas[id], schema);
	assert.deepEqual(registry.getSchemaAssociations()[id], ['**/settings.json']);
	registry.notifySchemaChanged(id);
	association.dispose();
	contribution.dispose();
	assert.deepEqual({ schema: registry.getSchemaContributions().schemas[id], associations: registry.getSchemaAssociations()[id], changes }, {
		schema: undefined, associations: undefined, changes: [id, 'associations', id, 'associations', id],
	});
});

test('disposing an older JSON contribution does not remove its replacement', () => {
	using first = new DisposableStore();
	using second = new DisposableStore();
	const id = 'test://schema/replacement';
	registry.registerSchema(id, { type: 'string' }, first);
	const schema = { type: 'boolean' as const };
	registry.registerSchema(id, schema, second);
	first.dispose();
	assert.equal(registry.getSchemaContributions().schemas[id], schema);
	second.dispose();
	assert.equal(registry.getSchemaContributions().schemas[id], undefined);
});

test('duplicate JSON associations remain registered until every owner releases them', () => {
	const id = 'test://schema/shared-association';
	using first = registry.registerSchemaAssociation(id, '**/*.json');
	using second = registry.registerSchemaAssociation(id, '**/*.json');
	first.dispose();
	assert.deepEqual(registry.getSchemaAssociations()[id], ['**/*.json']);
	second.dispose();
	assert.equal(registry.getSchemaAssociations()[id], undefined);
});
