import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { handleVetos } from '../../../../platform/lifecycle/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { LifecyclePhase, StartupKind, ShutdownVetoError, type IBeforeShutdownErrorEvent, type IBeforeShutdownEvent, type ILifecycleService, type IWillShutdownEvent, type ShutdownReason } from './lifecycle.js';

/** Owns window startup progress and shutdown coordination independently of its host. */
export abstract class AbstractLifecycleService extends Disposable implements ILifecycleService {
	private readonly beforeShutdownEmitter = this._register(new Emitter<IBeforeShutdownEvent>());
	private readonly beforeShutdownErrorEmitter = this._register(new Emitter<IBeforeShutdownErrorEvent>());
	private readonly shutdownVetoEmitter = this._register(new Emitter<void>());
	private readonly willShutdownEmitter = this._register(new Emitter<IWillShutdownEvent>());
	private readonly didShutdownErrorEmitter = this._register(new Emitter<ShutdownReason>());
	private readonly didShutdownEmitter = this._register(new Emitter<ShutdownReason>());
	private readonly phaseWaiters = new Map<LifecyclePhase, { readonly promise: Promise<void>; readonly resolve: () => void; }>();
	private _phase = LifecyclePhase.Starting;
	private _willShutdown = false;
	private shutdownPromise: Promise<void> | undefined;
	private shutdownReason: ShutdownReason | undefined;

	public readonly onBeforeShutdown = this.beforeShutdownEmitter.event;
	public readonly onBeforeShutdownError = this.beforeShutdownErrorEmitter.event;
	public readonly onShutdownVeto = this.shutdownVetoEmitter.event;
	public readonly onWillShutdown = this.willShutdownEmitter.event;
	public readonly onDidShutdownError = this.didShutdownErrorEmitter.event;
	public readonly onDidShutdown = this.didShutdownEmitter.event;
	public readonly startupKind: StartupKind;

	constructor(
		startupKind: StartupKind | undefined,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		const previousReason = storageService.get('lifecycle.lastShutdownReason', StorageScope.WORKSPACE);
		let resolvedKind = StartupKind.NewWindow;
		if (previousReason === 'reload') {
			resolvedKind = StartupKind.ReloadedWindow;
		} else if (previousReason === 'load') {
			resolvedKind = StartupKind.ReopenedWindow;
		}
		this.startupKind = startupKind ?? resolvedKind;
		storageService.remove('lifecycle.lastShutdownReason', StorageScope.WORKSPACE);
		this.logService.trace('lifecycle', `Window startup kind: ${StartupKind[this.startupKind]}`);
		this._register(storageService.onWillSaveState(event => {
			if (event.reason === WillSaveStateReason.SHUTDOWN) {
				storageService.store('lifecycle.lastShutdownReason', this.shutdownReason, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		}));
		this._register(toDisposable(() => this.phaseWaiters.clear()));
	}

	public get phase(): LifecyclePhase { return this._phase; }

	public set phase(value: LifecyclePhase) {
		this.assertNotDisposed();
		if (value < this._phase) {
			throw new Error('Lifecycle cannot go backwards');
		}
		if (value === this._phase) {
			return;
		}
		this._phase = value;
		this.logService.trace('lifecycle', `Startup phase: ${LifecyclePhase[value]}`);
		// A host may skip a phase, but everyone waiting for an earlier milestone is ready too.
		for (const [phase, waiter] of this.phaseWaiters) {
			if (phase <= value) {
				this.phaseWaiters.delete(phase);
				waiter.resolve();
			}
		}
	}

	public get willShutdown(): boolean { return this._willShutdown; }

	public when(phase: LifecyclePhase): Promise<void> {
		this.assertNotDisposed();
		if (phase <= this._phase) {
			return Promise.resolve();
		}
		let waiter = this.phaseWaiters.get(phase);
		if (!waiter) {
			let resolve!: () => void;
			const promise = new Promise<void>(complete => { resolve = complete; });
			waiter = { promise, resolve };
			this.phaseWaiters.set(phase, waiter);
		}
		return waiter.promise;
	}

	public shutdown(reason: ShutdownReason): Promise<void> {
		this.assertNotDisposed();
		if (this.shutdownPromise) {
			return this.shutdownPromise;
		}
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		// Publish the promise before firing events because participants may request shutdown again.
		this.shutdownPromise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
		void this.beginShutdown(reason).then(resolve, error => {
			const joinedShutdown = this._willShutdown;
			this._willShutdown = false;
			this.shutdownReason = undefined;
			this.shutdownPromise = undefined;
			this.storageService.remove('lifecycle.lastShutdownReason', StorageScope.WORKSPACE);
			if (joinedShutdown) this.didShutdownErrorEmitter.fire(reason);
			reject(error);
		});
		return this.shutdownPromise;
	}

	private async beginShutdown(reason: ShutdownReason): Promise<void> {
		const vetos: { readonly id: string; readonly value: boolean | Promise<boolean>; }[] = [];
		let accepting = true;
		this.beforeShutdownEmitter.fire({
			reason,
			veto: (value, id) => {
				if (!accepting) {
					throw new Error('Shutdown vetoes must be registered synchronously during onBeforeShutdown');
				}
				if (!id.trim()) {
					throw new TypeError('Shutdown veto id must not be empty');
				}
				vetos.push({ id, value });
			},
		});
		accepting = false;
		if (vetos.length > 0) {
			await this.handleBeforeShutdown(reason, vetos);
		}
		this._willShutdown = true;
		this.shutdownReason = reason;
		this.logService.trace('lifecycle', `Window shutdown: ${reason}`);
		const operations: { readonly label: string; readonly operation: Promise<unknown> | (() => Promise<unknown>); readonly isCurrent?: () => boolean; }[] = [];
		accepting = true;
		this.willShutdownEmitter.fire({
			reason,
			join: (operation, label, isCurrent) => {
				if (!accepting) {
					throw new Error('Shutdown participants must join synchronously during onWillShutdown');
				}
				if (!label.trim()) {
					throw new TypeError('Shutdown participant label must not be empty');
				}
				operations.push({ label, operation, isCurrent });
			},
		});
		accepting = false;
		const failures: Error[] = [];
		// Final captures must observe edits made while ordinary shutdown joins were waiting.
		for (const phase of [operations.filter(candidate => typeof candidate.operation !== 'function'), operations.filter(candidate => typeof candidate.operation === 'function')]) {
			let pending = phase;
			do {
				const results = await Promise.allSettled(pending.map(candidate => typeof candidate.operation === 'function' ? Promise.resolve().then(candidate.operation) : candidate.operation));
				failures.push(...results.flatMap((result, index) => result.status === 'rejected' ? [new Error(`Shutdown participant '${pending[index]!.label}' failed`, { cause: result.reason })] : []));
				if (failures.length > 0) break;
				// Check synchronously with completion: a promise observer can edit after its write resolves.
				pending = phase.filter(candidate => typeof candidate.operation === 'function' && candidate.isCurrent && !candidate.isCurrent());
			} while (pending.length > 0);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'One or more shutdown participants failed');
		}
		this.didShutdownEmitter.fire(reason);
	}

	private async handleBeforeShutdown(reason: ShutdownReason, vetos: readonly { readonly id: string; readonly value: boolean | Promise<boolean>; }[]): Promise<void> {
		const errors: Error[] = [];
		const isVetoed = await handleVetos(vetos.map(({ id, value }) => typeof value === 'boolean' ? value : value.catch(error => {
			throw new Error(`Shutdown veto '${id}' failed`, { cause: error });
		})), error => {
			errors.push(error);
			this.beforeShutdownErrorEmitter.fire({ reason, error });
		});
		if (!isVetoed) {
			return;
		}
		this.shutdownVetoEmitter.fire();
		if (errors.length > 0) {
			throw new AggregateError(errors, 'One or more shutdown vetoes failed');
		}
		throw new ShutdownVetoError();
	}
}
