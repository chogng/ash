import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Action, ActionRunner, getActionForAltMode, type IAction, type IRunEvent } from '../../common/actions.js';
import { CancellationError } from '../../common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('ActionRunner forwards context and reports action failures', async () => {
	using runner = new ActionRunner();
	const context = { resource: 'test.txt' };
	const failure = new Error('failed');
	const events: IRunEvent[] = [];
	using willRunListener = runner.onWillRun((event) => events.push(event));
	using didRunListener = runner.onDidRun((event) => events.push(event));

	await runner.run({
		id: 'test.action',
		label: 'Test',
		tooltip: 'Test',
		enabled: true,
		run(receivedContext) {
			assert.equal(receivedContext, context);
			throw failure;
		},
	}, context);

	assert.equal(events.length, 2);
	assert.equal(events[0]?.context, context);
	assert.equal(events[1]?.error, failure);
});

test('ActionRunner delegates execution to its protected hook inside the existing event boundary', async () => {
	const context = { resource: 'hook.txt' };
	const calls: unknown[] = [];
	class CustomRunner extends ActionRunner {
		protected override async runAction(action: IAction, receivedContext?: unknown): Promise<void> {
			calls.push([action, receivedContext]);
		}
	}
	using runner = new CustomRunner();
	const action: IAction = { id: 'custom', label: 'Custom', tooltip: '', enabled: true, run() { throw new Error('The hook owns execution'); } };
	using willRunListener = runner.onWillRun(event => calls.push(['will', event]));
	using didRunListener = runner.onDidRun(event => calls.push(['did', event]));
	await runner.run(action, context);
	assert.deepEqual(calls, [
		['will', { action, context }], [action, context], ['did', { action, context, error: undefined }],
	]);
});

test('ActionRunner waits for asynchronous completion and preserves the action receiver', async () => {
	using runner = new ActionRunner();
	let complete!: () => void;
	const completion = new Promise<void>(resolve => { complete = resolve; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const order: string[] = [];
	const context = { value: 7 };
	let count = 0;
	const action: IAction = {
		id: 'async', label: 'Async', tooltip: '', enabled: true,
		async run(receivedContext) {
			assert.equal(this, action);
			assert.equal(receivedContext, context);
			count++;
			order.push('run');
			entered();
			await completion;
			order.push('complete');
		},
	};
	using willRunListener = runner.onWillRun(() => order.push('will'));
	using didRunListener = runner.onDidRun(event => { assert.equal(event.error, undefined); order.push('did'); });
	const pending = runner.run(action, context);
	await started;
	assert.deepEqual(order, ['will', 'run']);
	complete();
	await pending;
	assert.deepEqual({ order, count }, { order: ['will', 'run', 'complete', 'did'], count: 1 });
});

for (const failure of [new Error('sync failure'), 'primitive failure', undefined, new CancellationError()]) {
	for (const asynchronous of [false, true]) {
		test(`ActionRunner fulfills and preserves ${String(failure)} from ${asynchronous ? 'rejected' : 'throwing'} actions`, async () => {
			using runner = new ActionRunner();
			const events: IRunEvent[] = [];
			using didRunListener = runner.onDidRun(event => events.push(event));
			const action: IAction = {
				id: 'failure', label: 'Failure', tooltip: '', enabled: true,
				run() { if (asynchronous) return Promise.reject(failure); throw failure; },
			};
			await runner.run(action);
			assert.deepEqual(events, [{ action, context: undefined, error: failure }]);
		});
	}
}

test('ActionRunner retains existing disabled-action and disposed-run behavior', async () => {
	const runner = new ActionRunner();
	let calls = 0;
	let events = 0;
	using didRunListener = runner.onDidRun(() => events++);
	const action: IAction = { id: 'disabled', label: 'Disabled', tooltip: '', enabled: false, run() { calls++; return 42; } };
	try {
		await runner.run(action);
		runner.dispose();
		await runner.run(action);
		assert.deepEqual({ calls, events }, { calls: 2, events: 1 });
	} finally { runner.dispose(); }
});


test('Action notifies retained views synchronously and ignores unchanged assignments', () => {
	using action = new Action('mutable', 'Before');
	const changes: unknown[] = [];
	using changeListener = action.onDidChange(change => changes.push(change));
	action.label = 'After';
	action.label = 'After';
	action.checked = true;
	action.enabled = false;
	assert.deepEqual(changes, [{ label: 'After' }, { checked: true }, { enabled: false }]);
	assert.equal(action.label, 'After');
});

test('alternative selection respects both action enablement boundaries', () => {
	const alternate = { id: 'alt', label: 'Alt', tooltip: '', enabled: true, run() { } };
	const primary = { id: 'primary', label: 'Primary', tooltip: '', enabled: true, alt: alternate, run() { } };
	assert.equal(getActionForAltMode(primary, { altKey: true }), alternate);
	alternate.enabled = false;
	assert.equal(getActionForAltMode(primary, { altKey: true }), primary);
	alternate.enabled = true;
	primary.enabled = false;
	assert.equal(getActionForAltMode(primary, { altKey: true }), primary);
});
