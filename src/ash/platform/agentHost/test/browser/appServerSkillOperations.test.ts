import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { createAppServerSkillOperations } from '../../browser/appServerApi.js';

for (const enablement of [undefined, 'disabled', 'enabled'] as const) {
	test(`Skill registration reuses the owning source and revision (${enablement ?? 'new'})`, async () => {
		const calls: { method: string; params: Record<string, unknown> }[] = [];
		const rootReference = '/fixture-home/.ash/skills';
		const id = 'user:skill-source:personal';
		const connection = {
			async request(definition: { method: string }, params: Record<string, unknown>) {
				calls.push({ method: definition.method, params });
				return definition.method === 'config/read' ? { revision: 12, skillSources: enablement ? { [id]: { id, rootReference, enablement } } : {} } : {};
			},
		} as unknown as AppServerProtocolClient;
		await createAppServerSkillOperations(connection).registerSource(rootReference);
		if (enablement === 'enabled') {
			assert.deepEqual(calls, [{ method: 'config/read', params: {} }]);
		} else {
			assert.equal(calls.length, 2);
			assert.equal(calls[1].params.expectedRevision, 12);
			assert.equal(typeof calls[1].params.commandId, 'string');
			if (enablement === 'disabled') {
				assert.equal(calls[1].method, 'skill/source/enablement/set');
				assert.equal(calls[1].params.sourceId, id);
				assert.equal(calls[1].params.enablement, 'enabled');
			} else {
				assert.equal(calls[1].method, 'skill/source/add');
				const source = calls[1].params.source as { id: string; rootReference: string; enablement: string };
				assert.match(source.id, /^user:skill-source:customize-/);
				assert.equal(source.rootReference, rootReference);
				assert.equal(source.enablement, 'enabled');
			}
		}
	});
}

test('Skill source configuration conflicts are returned without retrying the mutation', async () => {
	const methods: string[] = [];
	const conflict = new Error('Configuration revision conflict');
	const connection = {
		async request(definition: { method: string }) {
			methods.push(definition.method);
			if (definition.method === 'config/read') return { revision: 12, skillSources: {} };
			throw conflict;
		},
	} as unknown as AppServerProtocolClient;
	await assert.rejects(createAppServerSkillOperations(connection).registerSource('/fixture-home/.ash/skills'), error => error === conflict);
	assert.deepEqual(methods, ['config/read', 'skill/source/add']);
});
