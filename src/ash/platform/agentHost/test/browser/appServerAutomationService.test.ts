import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { AppServerAutomationService } from '../../browser/appServerAutomationService.js';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import type { AutomationRun } from '../../common/automation.js';

test('Automation run reads use the run identity independently of history', async () => {
	const requests: { method: string; params: unknown; }[] = [];
	const run: AutomationRun = {
		id: 'old-run', automationId: 'automation', revision: 1,
		definition: { title: 'Review', prompt: 'Review changes', directory: '/workspace', session: { type: 'new' }, schedule: { type: 'once', at: 1 } },
		status: 'completed', scheduledAt: 1, startedAt: 2, finishedAt: 3, sessionId: null, threadId: null, turnId: null, message: null,
	};
	using service = new AppServerAutomationService({
		onStateChange: Event.None,
		onNotification: Event.None,
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			return definition.method === 'automation/runs' ? { runs: [] } : run;
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.runs(run.automationId), []);
	assert.deepEqual(await service.getRun(run.id), run);
	assert.deepEqual(requests, [
		{ method: 'automation/runs', params: { id: 'automation', limit: 50 } },
		{ method: 'automation/run/read', params: { runId: 'old-run' } },
	]);
});

test('Automation results read only the recorded Turn in a continued conversation and retain output when its ledger fails', async () => {
	const requests: { method: string; params: unknown; }[] = [];
	let ledgerUnavailable = false;
	const service = new AppServerAutomationService({
		onStateChange: Event.None,
		onNotification: Event.None,
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			switch (definition.method) {
				case 'session/thread/read': return {
					thread: {
						turns: [
							{ turnId: 'recorded', items: [{ type: 'agentMessage', phase: 'commentary', text: 'Working' }, { type: 'agentMessage', phase: 'final_answer', text: 'Recorded result' }] },
							{ turnId: 'later', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Unrelated later result' }] },
						]
					}
				};
				case 'turnChanges/list':
					if (ledgerUnavailable) throw new Error('Unavailable ledger');
					return { changeSets: [{ turnId: 'recorded', changeSetId: 'recorded-changes' }, { turnId: 'later', changeSetId: 'later-changes' }] };
				case 'turnChanges/read': return { files: [{ path: 'recorded.ts', kind: 'modified', additions: 4, deletions: 2 }] };
				default: throw new Error('Unexpected operation: ' + definition.method);
			}
		},
	} as unknown as AppServerProtocolClient);
	const run: AutomationRun = {
		id: 'run', automationId: 'automation', revision: 1,
		definition: { title: 'Review', prompt: 'Review changes', directory: '/workspace', session: { type: 'continue', sessionId: 'session', threadId: 'thread' }, schedule: { type: 'once', at: 1 } },
		status: 'completed', scheduledAt: 1, startedAt: 2, finishedAt: 3, sessionId: 'session', threadId: 'thread', turnId: 'recorded', message: null,
	};
	try {
		assert.deepEqual(await service.readResult(run), { output: 'Recorded result', files: [{ path: 'recorded.ts', kind: 'modified', additions: 4, deletions: 2 }] });
		assert.deepEqual(requests, [
			{ method: 'session/thread/read', params: { sessionId: 'session', threadId: 'thread' } },
			{ method: 'turnChanges/list', params: { sessionId: 'session', threadId: 'thread' } },
			{ method: 'turnChanges/read', params: { sessionId: 'session', threadId: 'thread', changeSetId: 'recorded-changes' } },
		]);
		ledgerUnavailable = true;
		assert.deepEqual(await service.readResult(run), { output: 'Recorded result', files: undefined });
		requests.length = 0;
		assert.deepEqual(await service.readResult({ ...run, turnId: null }), { output: '', files: [] });
		assert.deepEqual(requests, []);
	} finally { service.dispose(); }
});

test('PR follow-up refuses an older backend before sending a conditional plan', async () => {
	let writes = 0;
	const client = {
		capabilities: { contracts: {} as Record<string, { version: number; }> },
		onStateChange: Event.None, onNotification: Event.None,
		async request(): Promise<unknown> { writes++; return {}; },
	};
	using service = new AppServerAutomationService(client as unknown as AppServerProtocolClient);
	const definition = {
		title: 'Follow PR', prompt: 'Fix CI', directory: '/workspace',
		session: { type: 'continue' as const, sessionId: 'session', threadId: 'thread' },
		schedule: { type: 'interval' as const, anchor: 1, minutes: 1 },
		condition: { type: 'gitHubChecks' as const, host: 'github.com', owner: 'team', repository: 'repo', number: 7, accountId: 'account', credentialRevision: '1' },
	};
	assert.equal(service.supportsPullRequestFollowUp, false);
	await assert.rejects(service.save('follow-up', 0, definition, 'enabled'), /requires a backend/);
	assert.equal(writes, 0);
	client.capabilities.contracts.automationConditions = { version: 1 };
	assert.equal(service.supportsPullRequestFollowUp, true);
	await service.save('follow-up', 0, definition, 'enabled');
	assert.equal(writes, 1);
});
