import { Emitter } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { ILifecycleService, IWillShutdownEvent, LifecyclePhase, ShutdownReason } from "../common/lifecycleService.js";

export interface BrowserLifecycleServiceOptions {
	readonly ownerWindow: Window;
	readonly onError: (error: unknown) => void;
}

/** Maps browser page lifecycle into one ordered shutdown join point. */
export class BrowserLifecycleService extends Disposable implements ILifecycleService {
	private readonly willShutdownEmitter = this._register(new Emitter<IWillShutdownEvent>());
	private readonly didShutdownEmitter = this._register(new Emitter<ShutdownReason>());
	private readonly onError: (error: unknown) => void;
	private shutdownPromise: Promise<void> | undefined;
	private _phase: LifecyclePhase = "running";

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
		void this.completeShutdown(reason, operations).then(resolveShutdown, rejectShutdown);
		return this.shutdownPromise;
	}

	private async completeShutdown(reason: ShutdownReason, operations: readonly { readonly label: string; readonly operation: Promise<unknown> }[]): Promise<void> {
		const results = await Promise.allSettled(operations.map(candidate => candidate.operation));
		this._phase = "shutdown";
		this.didShutdownEmitter.fire(reason);
		const failures = results.flatMap((result, index) => result.status === "rejected" ? [new Error(`Shutdown participant '${operations[index]!.label}' failed`, { cause: result.reason })] : []);
		if (failures.length > 0) throw new AggregateError(failures, "One or more shutdown participants failed");
	}
}
