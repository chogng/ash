import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type { ExecutionSettingsSnapshot, IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { SandboxSettingsModel } from '../../browser/sandboxSettingsModel.js';

const remote = { connectionState: 'connected', onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService;
const snapshot: ExecutionSettingsSnapshot = { revision: 12, settings: { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' } };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('Sandbox settings save through the backend revision and preserve approval mode', async () => {
	let saved: unknown;
	using model = new SandboxSettingsModel({ onDidChange: Event.None, read: async () => snapshot, configure: async (settings, revision) => { saved = { settings, revision }; } }, remote);
	assert.equal(model.categoryId, 'sandbox');
	model.setVisible(true); await tick();
	const network = model.fields.find(field => field.id === 'network')!;
	assert.equal(network.kind, 'select');
	if (network.kind === 'select') network.setValue('allowed');
	const save = model.fields.find(field => field.id === 'save')!;
	if (save.kind === 'action') { assert.equal(save.enabled, true); await save.run(); }
	assert.deepEqual(saved, { settings: { ...snapshot.settings, commandNetworkAccess: 'allowed' }, revision: 12 });
});

test('Sandbox settings reject stale drafts and never retry a failed write', async () => {
	using changes = new Emitter<void>();
	let writes = 0;
	const execution: IAgentExecutionSettingsService = { onDidChange: changes.event, read: async () => snapshot, configure: async () => { writes++; throw new Error('revision conflict'); } };
	using model = new SandboxSettingsModel(execution, remote);
	model.setVisible(true); await tick();
	const files = model.fields.find(field => field.id === 'files')!;
	if (files.kind === 'select') files.setValue('directoryWrite');
	let save = model.fields.find(field => field.id === 'save')!;
	if (save.kind === 'action') await save.run();
	assert.equal(writes, 1);
	save = model.fields.find(field => field.id === 'save')!;
	if (save.kind === 'action') { assert.equal(save.enabled, false); await save.run(); }
	assert.equal(writes, 1);
	changes.fire();
	const status = model.fields.find(field => field.id === 'status')!;
	if (status.kind === 'status') assert.match(status.text, /Refresh/);
});

test('Sandbox settings ignore a read completed after leaving the page', async () => {
	const read = new DeferredPromise<ExecutionSettingsSnapshot>();
	using model = new SandboxSettingsModel({ onDidChange: Event.None, read: () => read.p, configure: async () => { throw new Error('must not write'); } }, remote);
	model.setVisible(true); model.setVisible(false);
	await read.complete(snapshot); await tick();
	const files = model.fields.find(field => field.id === 'files')!;
	if (files.kind === 'select') assert.equal(files.enabled, false);
});
