import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { handleVetos } from '../../../../platform/lifecycle/common/lifecycle.js';
import { ShutdownVetoError, type IBeforeShutdownErrorEvent, type IBeforeShutdownEvent, type ILifecycleService, type IWillShutdownEvent, type LifecyclePhase, type ShutdownReason } from "../common/lifecycle.js";

export interface BrowserLifecycleServiceOptions {
	readonly ownerWindow: Window;
	readonly onError: (error: unknown) => void;
}

/** Maps browser page lifecycle into one ordered shutdown join point. */
export class BrowserLifecycleService extends Disposable implements ILifecycleService {
	private readonly beforeShutdownEmitter = this._register(new Emitter<IBeforeShutdownEvent>());
	private readonly beforeShutdownErrorEmitter = this._register(new Emitter<IBeforeShutdownErrorEvent>());
	private readonly shutdownVetoEmitter = this._register(new Emitter<void>());
	private readonly willShutdownEmitter = this._register(new Emitter<IWillShutdownEvent>());
	private readonly didShutdownEmitter = this._register(new Emitter<ShutdownReason>());
	private readonly onError: (error: unknown) => void;
	private shutdownPromise: Promise<void> | undefined;
	private _phase: LifecyclePhase = "running";

	readonly onBeforeShutdown = this.beforeShutdownEmitter.event;
	readonly onBeforeShutdownError = this.beforeShutdownErrorEmitter.event;
	readonly onShutdownVeto = this.shutdownVetoEmitter.event;
	readonly onWillShutdown = this.willShutdownEmitter.event;
	readonly onDidShutdown = this.didShutdownEmitter.event;

	constructor(options: BrowserLifecycleServiceOptions) {
		super();
		this.onError = options.onError;
		const onPageHide = (): void => { void this.shutdown("pageHide").catch(this.onError); };
		options.ownerWindow.addEventListener("pagehide", onPageHide);
		this._register(toDisposable(() => options.ownerWindow.removeEventListener("pagehide", onPageHide)));
	}

	get phase(): LifecyclePhase { return this._phase; }

	shutdown(reason: ShutdownReason): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		let resolveShutdown: (() => void) | undefined;
		let rejectShutdown: ((error: unknown) => void) | undefined;
		this.shutdownPromise = new Promise<void>((resolve, reject) => {
			resolveShutdown = resolve;
			rejectShutdown = reject;
		});
		this._phase = "shuttingDown";
		void this.beginShutdown(reason).then(resolveShutdown, error => {
			this._phase = 'running';
			this.shutdownPromise = undefined;
			rejectShutdown?.(error);
		});
		return this.shutdownPromise;
	}

	private beginShutdown(reason: ShutdownReason): Promise<void> {
		const vetos: { readonly id: string; readonly value: boolean | Promise<boolean> }[] = [];
		let accepting = true;
		this.beforeShutdownEmitter.fire({
			reason,
			veto: (value, id) => {
				if (!accepting) throw new Error('Shutdown vetoes must be registered synchronously during onBeforeShutdown');
				if (!id.trim()) throw new TypeError('Shutdown veto id must not be empty');
				vetos.push({ id, value });
			},
		});
		accepting = false;
		if (vetos.length === 0) return this.completeShutdown(reason);
		return this.handleBeforeShutdown(reason, vetos).then(() => this.completeShutdown(reason));
	}

	private async handleBeforeShutdown(reason: ShutdownReason, vetos: readonly { readonly id: string; readonly value: boolean | Promise<boolean> }[]): Promise<void> {
		const errors: Error[] = [];
		const isVetoed = await handleVetos(vetos.map(({ id, value }) => typeof value === 'boolean' ? value : value.catch(error => {
			throw new Error(`Shutdown veto '${id}' failed`, { cause: error });
		})), error => {
			errors.push(error);
			this.beforeShutdownErrorEmitter.fire({ reason, error });
		});
		if (!isVetoed) return;
		this.shutdownVetoEmitter.fire();
		if (errors.length > 0) throw new AggregateError(errors, 'One or more shutdown vetoes failed');
		throw new ShutdownVetoError();
	}

	private async completeShutdown(reason: ShutdownReason): Promise<void> {
		const operations: { readonly label: string; readonly operation: Promise<unknown> }[] = [];
		let accepting = true;
		this.willShutdownEmitter.fire({
			reason,
			join: (operation, label) => {
				if (!accepting) throw new Error("Shutdown participants must join synchronously during onWillShutdown");
				if (!label.trim()) throw new TypeError("Shutdown participant label must not be empty");
				operations.push({ label, operation });
			},
		});
		accepting = false;
		const results = await Promise.allSettled(operations.map(candidate => candidate.operation));
		const failures = results.flatMap((result, index) => result.status === "rejected" ? [new Error(`Shutdown participant '${operations[index]!.label}' failed`, { cause: result.reason })] : []);
		if (failures.length > 0) throw new AggregateError(failures, "One or more shutdown participants failed");
		this._phase = "shutdown";
		this.didShutdownEmitter.fire(reason);
	}
}
