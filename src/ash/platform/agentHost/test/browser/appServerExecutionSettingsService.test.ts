import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import type { ServerNotification } from '../../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { createAppServerExecutionSettingsService } from '../../browser/appServerExecutionSettingsService.js';

test('execution defaults retain backend revision and publish only config changes', async () => {
	using notifications = new Emitter<ServerNotification>();
	const requests: { method: string; params: unknown }[] = [];
	const execution = {
		approvalMode: 'manual',
		commandFileAccess: 'readOnly',
		commandNetworkAccess: 'denied',
	} as const;
	const service = createAppServerExecutionSettingsService({
		onNotification: notifications.event,
		async request(definition: { method: string }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return definition.method === 'config/read' ? { revision: 7, execution } : {};
		},
	} as unknown as AppServerProtocolClient);
	const snapshot = await service.read();
	assert.deepEqual(snapshot, { revision: 7, settings: execution });
	assert.notEqual(snapshot.settings, execution);
	const next = { ...execution, approvalMode: 'auto' } as const;
	await service.configure(next, snapshot.revision);
	assert.deepEqual(requests[0], { method: 'config/read', params: {} });
	const write = requests[1].params as { commandId: string; expectedRevision: number; execution: unknown };
	assert.ok(write.commandId);
	assert.deepEqual(
		{ ...requests[1], params: { ...write, commandId: 'command' } },
		{
			method: 'config/update',
			params: { commandId: 'command', expectedRevision: 7, execution: next },
		},
	);
	let changes = 0;
	const subscription = service.onDidChange(() => changes++);
	try {
		notifications.fire({ method: 'session/changed', params: { sessionId: 'session', agentTreeChanged: false } });
		assert.equal(changes, 0);
		notifications.fire({ method: 'config/changed', params: { revision: 8, generation: 2 } });
		assert.equal(changes, 1);
	} finally {
		subscription.dispose();
	}
	notifications.fire({ method: 'config/changed', params: { revision: 9, generation: 3 } });
	assert.equal(changes, 1);
});
