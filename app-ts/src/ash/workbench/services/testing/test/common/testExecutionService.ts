import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { type ITestExecutionService, type TestItem, type TestResult, type TestSnapshot, type TestUpdate } from '../../../../../platform/testing/common/testExecutionService.js';

/** Controlled backend boundary; notifications intentionally precede start responses. */
export class TestExecutionService extends Disposable implements ITestExecutionService {
	readonly updates = this._register(new Emitter<TestUpdate>());
	readonly disconnected = this._register(new Emitter<void>());
	readonly onDidUpdate = this.updates.event;
	readonly onDidDisconnect = this.disconnected.event;
	readonly snapshots = new Map<string, TestSnapshot>();
	readonly released: string[] = [];
	readonly runs: { id: string; tests: readonly string[] }[] = [];
	pendingDiscovery: Promise<void> | undefined;
	holdRuns = false;
	items: readonly TestItem[] = [
		{ id: 'fixture:lib:fixture:checks::passes', package: 'fixture', target: 'fixture', targetKind: 'library', name: 'checks::passes', path: 'src/lib.rs', line: 3 },
		{ id: 'fixture:lib:fixture:checks::fails', package: 'fixture', target: 'fixture', targetKind: 'library', name: 'checks::fails', path: 'src/lib.rs', line: 4 },
	];

	async discover(id: string, _dir: string): Promise<void> {
		this.snapshots.set(id, { operationId: id, kind: 'discovery', status: 'running', tests: [], results: [], sequence: 0, error: null });
		await this.pendingDiscovery;
		this.update(id, { status: 'completed', tests: this.items });
	}

	async run(id: string, _dir: string, catalogId: string, tests: readonly string[]): Promise<void> {
		if (!this.snapshots.has(catalogId)) { throw new Error('Missing discovery catalog'); }
		this.runs.push({ id, tests });
		this.snapshots.set(id, { operationId: id, kind: 'run', status: 'running', tests: [], results: [], sequence: 0, error: null });
		for (const testId of tests) {
			this.update(id, { result: { testId, state: 'running', durationMs: 0, output: '', outputTruncated: false, failurePath: null, failureLine: null } });
		}
		if (!this.holdRuns) { this.finish(id); }
	}

	finish(id: string): void {
		for (const testId of this.runs.find(run => run.id === id)!.tests) {
			const failed = testId.endsWith('fails');
			this.update(id, { result: { testId, state: failed ? 'failed' : 'passed', durationMs: 12, output: failed ? 'fixture failure' : '1 passed', outputTruncated: false, failurePath: failed ? 'src/lib.rs' : null, failureLine: failed ? 4 : null } });
		}
		this.update(id, { status: 'completed' });
	}

	async read(id: string): Promise<TestSnapshot> { return this.snapshots.get(id)!; }
	async cancel(id: string): Promise<TestSnapshot> {
		for (const result of this.snapshots.get(id)!.results) {
			if (result.state === 'running') { this.update(id, { result: { ...result, state: 'cancelled' } }); }
		}
		this.update(id, { status: 'cancelled' });
		return this.read(id);
	}
	async release(id: string): Promise<void> {
		if (!this.snapshots.delete(id)) { throw new Error('Operation released twice: ' + id); }
		this.released.push(id);
	}

	update(id: string, change: { status?: TestSnapshot['status']; tests?: readonly TestItem[]; result?: TestResult }): void {
		const before = this.snapshots.get(id)!;
		const results = change.result ? [...before.results.filter(result => result.testId !== change.result!.testId), change.result] : before.results;
		const snapshot = { ...before, status: change.status ?? before.status, tests: change.tests ?? before.tests, results, sequence: before.sequence + 1 };
		this.snapshots.set(id, snapshot);
		this.updates.fire({ operationId: id, sequence: snapshot.sequence, status: snapshot.status, tests: change.tests ?? null, result: change.result ?? null, error: null });
	}
}
