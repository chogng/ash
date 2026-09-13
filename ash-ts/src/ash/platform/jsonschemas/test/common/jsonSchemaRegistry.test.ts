import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { JsonSchemaRegistry } from '../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';

test('JSON schema registrations and exact resource associations are caller-owned', () => {
	using registry = new JsonSchemaRegistry();
	const resource = URI.parse('test:/settings.json');
	const schema = Object.freeze({ type: 'object' as const, properties: Object.freeze({ enabled: Object.freeze({ type: 'boolean' as const }) }) });
	const schemaRegistration = registry.registerSchema('test://schema/settings', schema);
	const association = registry.registerAssociation(resource, 'test://schema/settings');

	assert.equal(registry.getSchemaForResource(resource), schema);
	association.dispose();
	assert.equal(registry.getSchemaForResource(resource), undefined);
	schemaRegistration.dispose();
	assert.equal(registry.getSchema('test://schema/settings'), undefined);
});
