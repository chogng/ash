import { type DebugSessionState, type IDebugConfiguration, type IDebugService, type IDebugSession } from '../../../../services/debug/common/debugService.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { type ITestExecutionService, type TestDebugLaunch, type TestItem, type TestResult, type TestSnapshot, type TestUpdate } from '../../../../../platform/testing/common/testExecutionService.js';

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
		{ id: 'fixture:lib:fixture:checks::passes', package: 'fixture', target: 'fixture', targetKind: 'library', name: 'checks::passes', source: { path: 'src/lib.rs', line: 3 }, debuggable: true },
		{ id: 'fixture:lib:fixture:checks::fails', package: 'fixture', target: 'fixture', targetKind: 'library', name: 'checks::fails', source: { path: 'src/lib.rs', line: 4 }, debuggable: true },
	];

	async discover(id: string, _dir: string): Promise<void> {
		this.snapshots.set(id, { operationId: id, kind: 'discovery', status: 'running', tests: [], results: [], sequence: 0, error: null, launch: null });
		await this.pendingDiscovery;
		this.update(id, { status: 'completed', tests: this.items });
	}

	async run(id: string, _dir: string, catalogId: string, tests: readonly string[]): Promise<void> {
		if (!this.snapshots.has(catalogId)) { throw new Error('Missing discovery catalog'); }
		this.runs.push({ id, tests });
		this.snapshots.set(id, { operationId: id, kind: 'run', status: 'running', tests: [], results: [], sequence: 0, error: null, launch: null });
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

	async prepareDebug(id: string, _dir: string, catalogId: string, testId: string): Promise<void> {
		if (!this.snapshots.has(catalogId)) { throw new Error('Missing discovery catalog'); }
		this.snapshots.set(id, { operationId: id, kind: 'debug', status: 'running', tests: [], results: [], sequence: 0, error: null, launch: null });
		this.update(id, { status: 'completed', launch: { testId, program: '/workspace/target/test', arguments: ['--exact', this.items.find(test => test.id === testId)!.name], directory: '/workspace', adapterProgram: 'lldb-dap' } });
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

	update(id: string, change: { status?: TestSnapshot['status']; tests?: readonly TestItem[]; result?: TestResult; launch?: TestDebugLaunch }): void {
		const before = this.snapshots.get(id)!;
		const results = change.result ? [...before.results.filter(result => result.testId !== change.result!.testId), change.result] : before.results;
		const snapshot = { ...before, status: change.status ?? before.status, tests: change.tests ?? before.tests, results, launch: change.launch ?? before.launch, sequence: before.sequence + 1 };
		this.snapshots.set(id, snapshot);
		this.updates.fire({ operationId: id, sequence: snapshot.sequence, status: snapshot.status, tests: change.tests ?? null, result: change.result ?? null, error: null, launch: change.launch ?? null });
	}
}

/** Boundary stub for the DAP owner; test preparation must never invoke task scripts. */
export class TestDebugService extends Disposable {
	readonly launches: IDebugConfiguration[] = [];
	readonly states = this._register(new Emitter<DebugSessionState>());
	private state: DebugSessionState = 'running';
	private currentSession: IDebugSession | undefined;
	readonly sessionChanges = this._register(new Emitter<IDebugSession | undefined>());
	readonly service: IDebugService;
	constructor() {
		super();
		const owner = this;
		this.service = {
			get sessions() { return owner.currentSession ? [owner.currentSession] : []; },
			onDidChangeSession: this.sessionChanges.event,
			startDebugging: async (configuration: IDebugConfiguration) => {
				this.launches.push(configuration);
				this.state = 'running';
				this.currentSession = { configuration, get state() { return owner.state; }, onDidChangeState: this.states.event } as IDebugSession;
				this.sessionChanges.fire(this.currentSession);
				return this.currentSession;
			},
			stop: async () => this.finish(),
		} as unknown as IDebugService;
	}
	finish(): void { this.state = 'terminated'; this.states.fire(this.state); this.currentSession = undefined; this.sessionChanges.fire(undefined); }
}
