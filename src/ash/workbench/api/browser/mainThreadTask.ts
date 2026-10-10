import { extensionHostTaskSnapshot, extensionHostWorkflowProviderId, normalizeTaskResult } from './extensionHostWorkflowBridge.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import {
	IExtensionHostApi,
	normalizeExtensionHostPayload,
	type ExtensionClientOperation,
	type ExtensionClientResult,
	type ExtensionClientSource,
	type ExtensionHostFleetSnapshot,
	type JsonValue,
} from '../../../platform/extensionHost/common/extensionHostApi.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ITaskService, type ITaskRun, type IWorkspaceTask } from '../../services/tasks/common/taskService.js';

/** Serializes the window's existing task objects; execution remains with TaskService. */
export class MainThreadTask extends Disposable {
	private readonly executionIds = new WeakMap<ITaskRun, string>();
	private readonly observers = this._register(new DisposableMap<string, TaskObserver>());
	private sequence = 0;

	constructor(
		private readonly timeoutMillis: number,
		private readonly reportError: (error: unknown) => void,
		@ITaskService private readonly tasks: ITaskService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
	) {
		super();
		this._register(tasks.onDidStartTask(run => {
			for (const [, observer] of this.observers) {
				if (observer.providerId === run.task.providerId) observer.track(run);
			}
			const execution = this.executionSnapshot(run);
			this.emit({ type: 'start', execution });
			if (run.processId !== undefined) {
				this.emit({ type: 'processStart', execution, processId: run.processId });
			}
			const observers = [...this.observers].map(([, observer]) => observer);
			void (run.completion ?? run.processCompletion)?.then(exitCode => {
				if (this.isDisposed) { return; }
				const completed = { ...execution, active: false, exitCode: exitCode ?? null };
				if (run.processId !== undefined) {
					this.emit({ type: 'processEnd', execution: completed, exitCode: exitCode ?? null }, observers);
				}
				this.emit({ type: 'end', execution: completed }, observers);
			}, error => {
				if (!this.isDisposed) {
					this.reportError(error);
					this.emit({ type: 'end', execution: { ...execution, active: false } }, observers);
				}
			});
		}));
		this._register(tasks.onDidChangeTaskRun(run => {
			if (run.status === 'running') { return; }
			for (const [, observer] of this.observers) { observer.forget(run); }
			if (run.completion || run.processCompletion) { return; }
			if (run.processId !== undefined) { this.emit({ type: 'processEnd', execution: this.executionSnapshot(run), exitCode: run.exitCode ?? null }); }
			this.emit({ type: 'end', execution: this.executionSnapshot(run) });
		}));
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const retained = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'taskEvents') { continue; }
				const identity = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation, registrationId: registration.registrationId };
				const key = JSON.stringify([identity.extensionId, identity.activationGeneration, identity.incarnation, identity.registrationId]);
				retained.add(key);
				if (this.observers.has(key)) { continue; }
				const observer = new TaskObserver(extensionHostWorkflowProviderId(identity.extensionId, identity.registrationId), (event, signal) => this.api.invoke({ ...identity, operation: 'taskEvent', payload: event, deadlineUnixMillis: Date.now() + this.timeoutMillis }, signal), error => { if (!this.isDisposed) { this.reportError(error); } }, run => this.tasks.terminate(run));
				this.observers.set(key, observer);
				observer.send({ type: 'snapshot', sequence: this.sequence, executions: this.tasks.activeRuns.map(run => this.executionSnapshot(run)) });
			}
		}
		for (const key of this.observers.keys()) { if (!retained.has(key)) { this.observers.deleteAndDispose(key); } }
	}

	public clear(): void {
		this.observers.clearAndDisposeAll();
	}

	private emit(event: Readonly<Record<string, JsonValue>>, observers = [...this.observers].map(([, observer]) => observer)): void {
		const value = normalizeExtensionHostPayload({ ...event, sequence: ++this.sequence });
		for (const observer of observers) { observer.send(value); }
	}

	public async handle(
		operation: Extract<ExtensionClientOperation, { operation: 'fetchTasks' | 'executeTask' | 'terminateTask'; }>,
		signal: AbortSignal,
		source?: ExtensionClientSource,
	): Promise<ExtensionClientResult> {
		this.assertNotDisposed();
		throwIfCancelled(signal);
		if (operation.operation === 'fetchTasks') {
			const catalog = await this.tasks.refresh();
			throwIfCancelled(signal);
			const tasks = catalog.filter(task => (operation.version === null || operation.version === (task.configuration?.version ?? '2.0.0')) && (operation.taskType === null || operation.taskType === this.definition(task).type));
			return { result: 'tasks', sequence: this.sequence, tasks: tasks.map(task => extensionHostTaskSnapshot(task, this.workspace)), executions: this.tasks.activeRuns.map(run => this.executionSnapshot(run)) };
		}
		if (operation.operation === 'terminateTask') {
			const run = this.tasks.activeRuns.find(run => this.executionId(run) === operation.executionId);
			if (run) { await this.tasks.terminate(run); }
			return { result: 'done' };
		}
		if (operation.task !== null) {
			if (!source) { throw new TypeError('A provided task requires an authenticated extension owner'); }
			const key = JSON.stringify([source.extensionId, source.activationGeneration, source.incarnation, 'vscode.tasks.events']);
			const observer = this.observers.get(key);
			if (!observer) { throw new Error('Task extension owner has retired'); }
			let task = normalizeTaskResult({ tasks: [operation.task] }, (operation, payload, signal) => this.api.invoke({
				...source, registrationId: 'vscode.tasks.events', operation, payload,
				deadlineUnixMillis: Date.now() + this.timeoutMillis,
			}, AbortSignal.any([signal, observer.signal])))[0]!;
			if (operation.taskId !== null) {
				const catalog = await this.tasks.refresh();
				throwIfCancelled(AbortSignal.any([signal, observer.signal]));
				const original = catalog.find(value => value.id === operation.taskId);
				if (original?.execution?.type !== 'custom' || task.execution?.type !== 'custom') { throw new TypeError('An edited custom task requires a current custom catalog execution'); }
				// The snapshot controls metadata, never the provider callback or its
				// invocation authority. TaskService retains the caller's run lifetime.
				task = { ...task, execution: original.execution };
			}
			const run = await this.tasks.runProvidedTask(
				extensionHostWorkflowProviderId(source.extensionId, 'vscode.tasks.events'),
				task,
				AbortSignal.any([signal, observer.signal]),
			);
			observer.track(run);
			return { result: 'taskExecution', sequence: this.sequence, execution: this.executionSnapshot(run) };
		}
		if (operation.taskId === null) { throw new TypeError('A task execution requires a catalog identity or a provided task'); }
		// Fetch returns only identities from the canonical catalog. Dispatch rereads
		// workspace configuration through TaskService instead of trusting stale Host data.
		const task = this.tasks.tasks.find(task => task.id === operation.taskId);
		if (!task) { throw new Error('Task is no longer present in the current workspace configuration'); }
		const run = await this.tasks.run(task, signal);
		return { result: 'taskExecution', sequence: this.sequence, execution: this.executionSnapshot(run) };
	}

	private executionSnapshot(run: ITaskRun): { readonly id: string; readonly task: JsonValue; readonly active: boolean; readonly exitCode: number | null; } {
		return Object.freeze({
			id: this.executionId(run), task: extensionHostTaskSnapshot(run.task, this.workspace),
			active: run.status === 'running', exitCode: run.exitCode ?? null,
		});
	}

	private executionId(run: ITaskRun): string {
		let id = this.executionIds.get(run);
		if (!id) {
			id = generateUuid();
			this.executionIds.set(run, id);
		}
		return id;
	}

	private definition(task: IWorkspaceTask): Readonly<Record<string, unknown>> & { readonly type: string; } {
		return task.definition ?? { type: task.execution?.type ?? 'shell', task: task.label };
	}

}

/** Ordered callbacks are tied to one registration incarnation, including initial state. */
class TaskObserver extends Disposable {
	private readonly controller = new AbortController();
	private queue: Promise<void> = Promise.resolve();
	private pending = 0;
	private readonly ownedRuns = new Set<ITaskRun>();
	public get signal(): AbortSignal { return this.controller.signal; }

	constructor(
		public readonly providerId: string,
		private readonly invoke: (event: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
		private readonly reportError: (error: unknown) => void,
		private readonly terminate: (run: ITaskRun) => Promise<void>,
	) {
		super();
	}

	public track(run: ITaskRun): void {
		if (this.isDisposed) {
			void this.terminate(run).catch(this.reportError);
			return;
		}
		if (run.status === 'running') { this.ownedRuns.add(run); }
	}

	public forget(run: ITaskRun): void { this.ownedRuns.delete(run); }

	public send(event: JsonValue): void {
		if (this.isDisposed || this.controller.signal.aborted) { return; }
		if (++this.pending > 64) {
			this.reportError(new Error('Extension task event queue exceeded 64 pending events'));
			this.dispose();
			return;
		}
		this.queue = this.queue.then(async () => {
			throwIfCancelled(this.controller.signal);
			await this.invoke(event, this.controller.signal);
		}).catch(error => { if (!this.controller.signal.aborted) { this.reportError(error); } }).finally(() => { this.pending--; });
	}

	protected override disposeCore(): void {
		this.controller.abort();
		for (const run of this.ownedRuns) { void this.terminate(run).catch(this.reportError); }
		this.ownedRuns.clear();
		super.disposeCore();
	}
}
