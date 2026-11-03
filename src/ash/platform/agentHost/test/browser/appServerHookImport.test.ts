import assert from 'node:assert/strict';
import { test } from 'mocha';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { createAppServerHookOperations } from '../../browser/appServerApi.js';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';

test('Claude Hook migration preserves reviewed commands, detects concurrent edits and stops publishing', async () => {
	const requests: unknown[] = [];
	const conflict = new Error('Config revision changed');
	const connection = {
		generation: 1,
		state: 'ready',
		operatingSystem: OperatingSystem.Macintosh,
		async request(method: { method: string; }, params: unknown) {
			if (method.method === 'config/read') return { revision: 17, hooks: {} };
			assert.equal(method.method, 'hook/upsert');
			requests.push(params);
			if (requests.length > 1) throw conflict;
			return { revision: 18 };
		},
	};
	const hooks = createAppServerHookOperations(connection as unknown as AppServerProtocolClient);
	const apply = await hooks.captureClaudeHookImport!();
	const commands = ['a', 'b', 'c'].map(name => ({ id: `user:hook:${name}`, program: '/bin/sh', args: ['-c', `echo ${name}`], timeoutSeconds: 5 }));
	assert.deepEqual(await apply(commands, () => true), { imported: 1, existing: 0, error: conflict });
	assert.equal(requests.length, 2);
	const [first, second] = requests as { expectedRevision: number; hook: unknown; }[];
	assert.equal(first.expectedRevision, 17);
	assert.equal(second.expectedRevision, 18);
	assert.deepEqual(first.hook, {
		id: 'user:hook:a', event: 'preToolUse', enablement: 'disabled',
		matcher: { toolNames: [] },
		action: { type: 'process', program: '/bin/sh', args: ['-c', 'echo a'] },
		claudePreToolUse: { timeoutSeconds: 5 },
	});
	const retired = await hooks.captureClaudeHookImport!();
	connection.generation++;
	assert.deepEqual(await retired(commands, () => true), { imported: 0, existing: 0 });
	assert.equal(requests.length, 2);
});
