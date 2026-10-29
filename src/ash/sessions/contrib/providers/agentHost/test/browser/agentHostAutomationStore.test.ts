import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import type { Automation, AutomationRun, AutomationRunResult, IAutomationBackendService } from '../../../../../../platform/agentHost/common/automation.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IRendererHostService, type IRendererHost } from '../../../../../../platform/renderer/common/rendererHost.js';
import { AgentHostAutomationStore } from '../../browser/agentHostAutomationStore.js';

function fixture() {
	const resources = new DisposableStore();
	const changes = resources.add(new Emitter<void>());
	const connection = observableValue<'connected' | 'connecting' | 'disconnected'>('automation connection', 'connected');
	const automation: Automation = {
		id: 'automation',
		revision: 1,
		definition: {
			title: 'Original',
			prompt: 'Review',
			directory: '/workspace',
			session: { type: 'new' },
			schedule: { type: 'interval', anchor: 0, minutes: 60 },
		},
		status: 'enabled',
		createdAt: 1,
		updatedAt: 1,
		nextRunAt: null,
	};
	const run: AutomationRun = {
		id: 'run',
		automationId: automation.id,
		revision: automation.revision,
		definition: automation.definition,
		status: 'running',
		scheduledAt: 1,
		startedAt: 1,
		finishedAt: null,
		sessionId: 'session',
		threadId: 'thread',
		turnId: 'turn',
		message: null,
	};
	let plans: readonly Automation[] = [automation];
	let runs: readonly AutomationRun[] = [run];
	const reads: string[] = [];
	const stops: string[] = [];
	const backend: IAutomationBackendService = {
		onDidChange: changes.event,
		list: async () => plans,
		runs: async () => runs,
		save: async (id, revision, definition, status) => ({
			...automation,
			id,
			revision: revision + 1,
			definition,
			status,
		}),
		delete: async () => {},
		run: async () => run,
		getRun: async id => {
			reads.push(id);
			return run;
		},
		stop: async id => {
			stops.push(id);
			return { ...run, status: 'stopped' };
		},
		readResult: async () => ({ output: '', files: [] }),
		preview: async () => [60],
	};
	const services = resources.add(new InstantiationService());
	services.registerInstance(IRendererHostService, { automation: backend } as IRendererHost);
	const store = resources.add(services.createInstance(AgentHostAutomationStore, 'host', connection));
	return {
		resources,
		backend,
		store,
		automation,
		run,
		reads,
		stops,
		async reconnect(nextPlans: readonly Automation[], nextRuns: readonly AutomationRun[] = []): Promise<void> {
			connection.set('disconnected', undefined);
			plans = nextPlans;
			runs = nextRuns;
			connection.set('connected', undefined);
			await store.refresh();
		},
	};
}

for (const operation of ['create', 'update'] as const) {
	test(`late ${operation} receipts cannot replace the replacement connection catalogue`, async () => {
		const value = fixture();
		using resources = value.resources;
		await value.store.refresh();
		const pending = new DeferredPromise<Automation>();
		let writes = 0;
		value.backend.save = () => {
			writes++;
			return pending.p;
		};
		const current = value.store.automations.get()[0]!;
		const saving =
			operation === 'create' ? value.store.createAutomation({ ...current, name: 'Saved on old connection' }) : value.store.updateAutomation(current.id, { name: 'Saved on old connection' });
		const replacement = {
			...value.automation,
			revision: 3,
			definition: { ...value.automation.definition, title: 'Replacement' },
		};
		await value.reconnect([replacement]);
		const names: string[][] = [];
		using listener = value.store.automations.onDidChange(items => names.push(items.map(item => item.name)));
		await pending.complete({
			...value.automation,
			revision: 2,
			definition: { ...value.automation.definition, title: 'Old receipt' },
		});
		assert.equal((await saving).name, 'Old receipt', 'a confirmed write remains successful');
		assert.deepEqual(
			value.store.automations.get().map(item => [item.name, item.revision]),
			[['Replacement', 3]],
		);
		assert.ok(
			names.every(snapshot => snapshot.every(name => name === 'Replacement')),
			'no observer may see the retired receipt',
		);
		assert.equal(writes, 1, 'recovery must not replay a write');
	});
}

test('a late delete cannot remove a definition read by the replacement connection', async () => {
	const value = fixture();
	using resources = value.resources;
	await value.store.refresh();
	const pending = new DeferredPromise<void>();
	value.backend.delete = () => pending.p;
	const deleting = value.store.deleteAutomation(value.store.automations.get()[0]!.id);
	await value.reconnect([{ ...value.automation, revision: 2 }]);
	const lengths: number[] = [];
	using listener = value.store.automations.onDidChange(items => lengths.push(items.length));
	await pending.complete();
	await deleting;
	assert.deepEqual(
		value.store.automations.get().map(item => item.revision),
		[2],
	);
	assert.ok(
		lengths.every(length => length === 1),
		'replacement rows must never disappear for a retired delete',
	);
});

test('a late stop receipt cannot overwrite replacement run history', async () => {
	const value = fixture();
	using resources = value.resources;
	await value.store.refresh();
	const pending = new DeferredPromise<AutomationRun>();
	value.backend.stop = () => pending.p;
	const stopping = value.store.stopRun(value.store.runs.get()[0]!);
	await value.reconnect([value.automation], [{ ...value.run, status: 'completed', finishedAt: 2 }]);
	const states: string[][] = [];
	using listener = value.store.runs.onDidChange(runs => states.push(runs.map(run => run.status)));
	await pending.complete({ ...value.run, status: 'stopped' });
	await stopping;
	assert.deepEqual(
		value.store.runs.get().map(run => run.status),
		['completed'],
	);
	assert.ok(states.every(snapshot => snapshot.every(state => state === 'completed')));
});

test('late run admission preserves its receipt without observing or stopping through a replacement connection', async () => {
	const value = fixture();
	using resources = value.resources;
	await value.store.refresh();
	const pending = new DeferredPromise<AutomationRun>();
	value.backend.run = () => pending.p;
	const dispatching = value.store.runAutomation(value.store.automations.get()[0]!.id);
	await value.reconnect([value.automation]);
	await pending.complete(value.run);
	const result = await dispatching;
	assert.equal(result.run.sessionResource?.path, '/session/thread');
	assert.equal(decodeURIComponent(result.run.sessionResource!.authority), result.run.providerId);
	assert.deepEqual(value.reads, []);
	assert.deepEqual(value.store.runs.get(), []);
	await assert.rejects(result.whenCompleted);
	result.cancel();
	assert.deepEqual(value.stops, []);
});

test('a run cancel handle cannot send to a connection acquired after admission', async () => {
	const value = fixture();
	using resources = value.resources;
	await value.store.refresh();
	const result = await value.store.runAutomation(value.store.automations.get()[0]!.id);
	const observed = assert.rejects(result.whenCompleted);
	await value.reconnect([value.automation]);
	await observed;
	result.cancel();
	assert.deepEqual(value.stops, []);
});

test('read-only run results and schedule previews retire with their originating connection', async () => {
	const value = fixture();
	using resources = value.resources;
	await value.store.refresh();
	const output = new DeferredPromise<AutomationRunResult>();
	const preview = new DeferredPromise<readonly number[]>();
	value.backend.readResult = () => output.p;
	value.backend.preview = () => preview.p;
	const reading = assert.rejects(value.store.readRunResult(value.store.runs.get()[0]!));
	const previewing = assert.rejects(value.store.previewSchedule('host', value.automation.definition.schedule));
	await value.reconnect([value.automation]);
	await output.complete({ output: 'Old private result', files: [] });
	await preview.complete([120]);
	await Promise.all([reading, previewing]);
});

test('PR follow-up pause preserves the backend condition and rejects generic editing', async () => {
	const value = fixture();
	using resources = value.resources;
	const plan: Automation = {
		...value.automation,
		definition: {
			...value.automation.definition,
			session: { type: 'continue', sessionId: 'session', threadId: 'thread' },
			condition: {
				type: 'gitHubChecks',
				host: 'github.com',
				owner: 'team',
				repository: 'repo',
				number: 7,
				accountId: 'account',
				credentialRevision: '1',
			},
		},
	};
	await value.reconnect([plan]);
	const descriptor = value.store.automations.get()[0]!;
	assert.equal(descriptor.kind, 'pullRequestFollowUp');
	const writes: unknown[] = [];
	value.backend.save = async (_id, _revision, definition, status) => {
		writes.push({ definition, status });
		return { ...plan, definition, status, revision: 2 };
	};
	await assert.rejects(value.store.updateAutomation(descriptor.id, { prompt: 'Unconditional repair' }), /PR follow-up controls/);
	assert.deepEqual(writes, []);
	await value.store.updateAutomation(descriptor.id, { enabled: false });
	assert.deepEqual(writes, [{ definition: plan.definition, status: 'paused' }]);
	assert.equal(value.store.canDeleteAutomation(descriptor.id), false);
});
